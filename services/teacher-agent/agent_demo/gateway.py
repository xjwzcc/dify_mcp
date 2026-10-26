"""Authorization and public events around the reused Bridge; no protocol translation."""
import json
import hashlib
import hmac
import uuid

import httpx

from .capabilities import canonical
from .storage import InputError


def sse_events(lines):
    data, size = [], 0
    for line in lines:
        if not line:
            if data:
                yield json.loads("\n".join(data))
            data, size = [], 0
        elif line.startswith("data:"):
            value = line[5:].lstrip()
            if value == "[DONE]":
                continue
            size += len(value)
            if size > 4_000_000:
                raise InputError("UPSTREAM_EVENT_LIMIT")
            data.append(value)
    if data:
        yield json.loads("\n".join(data))


class RedactedDelta:
    """Hold a suffix so known secrets split across provider chunks cannot leak."""
    def __init__(self, secrets):
        self.secrets = [s for s in secrets if s]
        self.tail = ""

    def feed(self, value, final=False):
        self.tail += value
        for secret in self.secrets:
            self.tail = self.tail.replace(secret, "[REDACTED]")
        # Hold only a possible secret prefix, not a full key-length of ordinary
        # text. This preserves split-secret redaction without delaying short replies.
        keep = 0
        if not final:
            for secret in self.secrets:
                for size in range(min(len(secret)-1, len(self.tail)), keep, -1):
                    if self.tail.endswith(secret[:size]):
                        keep = size
                        break
        n = len(self.tail) - keep
        result, self.tail = self.tail[:n], self.tail[n:]
        return result


class Gateway:
    def __init__(self, service, client_factory=httpx.Client):
        self.service, self.s, self.client_factory = service, service.s, client_factory

    def open(self, token, body):
        attempt, _ = self.service.reserve_model_request(token)
        if body.get("model") not in {None, self.s.model}:
            raise InputError("MODEL_NOT_ALLOWED")
        if len(canonical(body).encode()) > self.s.max_input_bytes:
            raise InputError("CONTEXT_INPUT_LIMIT")
        request = dict(body)
        request["model"] = self.s.model
        request["max_output_tokens"] = min(int(body.get("max_output_tokens") or self.s.max_output_tokens),
                                           self.s.max_output_tokens)
        if request["max_output_tokens"] < 1:
            raise InputError("Invalid output budget")
        if not self.s.bridge_secret:
            raise InputError("BRIDGE_KEY_NOT_CONFIGURED")
        scope = attempt["id"]
        signed = hmac.new(self.s.bridge_secret.encode(),
                          ("expserver-codex:" + scope).encode(), hashlib.sha256).hexdigest()
        client = self.client_factory(timeout=httpx.Timeout(180, connect=15),
                                     follow_redirects=False, trust_env=False)
        try:
            response = client.send(client.build_request("POST", self.s.bridge_url + "/v1/responses",
                headers={"Authorization": "Bearer " + signed, "x-exp-conversation-id": scope},
                json=request), stream=True)
        except BaseException:
            client.close()
            raise
        if response.status_code >= 300:
            raw = response.read()[:64000]
            response.close()
            client.close()
            # Return status accurately but do not reflect provider messages containing secrets.
            return response.status_code, {"error": {"code": "UPSTREAM_HTTP_" + str(response.status_code)}}, None
        if not request.get("stream", False):
            try:
                value = response.json() if response.is_closed else json.loads(response.read())
                return 200, value, None
            finally:
                response.close()
                client.close()
        return 200, None, self.stream(token, response, client)

    def stream(self, token, response, client):
        request_id = uuid.uuid4().hex
        terminal = False
        number = 0
        buffers = {}
        try:
            for event in sse_events(response.iter_lines()):
                # Fence each event; cancellation also terminates provider consumption.
                with self.service.db.tx() as conn:
                    self.service.lock_capability(conn, token)
                number += 1
                kind = event.get("type")
                if kind == "response.output_text.delta":
                    key = str(event.get("item_id", event.get("output_index", 0))) + ":" + str(event.get("content_index", 0))
                    buf = buffers.setdefault(key, RedactedDelta([token, self.s.deepseek_key]))
                    text = buf.feed(event.get("delta", ""))
                    if text:
                        self.service.emit(token, "assistant.delta",
                            {"request_id": request_id, "item": key, "text": text, "provisional": True},
                            request_id + ":" + str(number))
                if kind in {"response.completed", "response.incomplete", "response.failed"}:
                    terminal = True
                    for key, buf in buffers.items():
                        text = buf.feed("", final=True)
                        if text:
                            self.service.emit(token, "assistant.delta",
                                {"request_id": request_id, "item": key, "text": text, "provisional": True},
                                request_id + ":tail:" + key)
                yield ("event: " + str(kind or "error") + "\ndata: " + canonical(event) + "\n\n").encode()
                if terminal:
                    break
            if not terminal:
                yield b'event: error\ndata: {"type":"error","code":"UPSTREAM_STREAM_INTERRUPTED","message":"No terminal response event"}\n\n'
        except (httpx.HTTPError, ValueError, PermissionError):
            yield b'event: error\ndata: {"type":"error","code":"STREAM_ABORTED","message":"Stream interrupted or execution revoked"}\n\n'
        finally:
            response.close()
            client.close()
