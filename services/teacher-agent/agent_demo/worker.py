"""Durable, bounded reconciliation. HTTP request lifetime never owns a CLI process."""
import base64
import hashlib
import logging
import secrets
import time

from sqlalchemy import select, insert, update

from .db import sessions, executions, attempts, artifacts, operations, row, uid
from .service import ACTIVE, TERMINAL, SYSTEM
from .providers import provider
from .storage import InputError

LOG = logging.getLogger(__name__)


class Worker:
    def __init__(self, service, backend=None):
        self.service, self.s, self.db = service, service.s, service.db
        self.backend = backend or provider(self.s)
        self.owner = uid()

    def claim(self):
        now = time.time()
        with self.db.tx() as conn:
            self.service.lock_capacity(conn)
            candidates = list(conn.execute(select(executions).where(
                executions.c.state.in_(["QUEUED", "RETRY_WAIT"]) &
                (executions.c.available <= now)).order_by(executions.c.created, executions.c.id).limit(50)).mappings())
            for candidate in candidates:
                session = self.db.lock_session(conn, candidate["session_id"])
                ex = row(conn, executions, executions.c.id == candidate["id"])
                if ex["state"] not in {"QUEUED", "RETRY_WAIT"} or ex["available"] > now:
                    continue
                if session["active_execution"] not in {None, ex["id"]}:
                    continue
                earlier = conn.execute(select(executions.c.id).where(
                    (executions.c.session_id == ex["session_id"]) &
                    executions.c.state.in_(["QUEUED", "RETRY_WAIT", "RUNNING"]) &
                    (executions.c.created < ex["created"])).limit(1)).first()
                if earlier:
                    continue
                previous = list(conn.execute(select(attempts).where(attempts.c.execution_id == ex["id"])).mappings())
                if any(not a["cleaned"] for a in previous):
                    continue
                if not self.service.may_claim(conn, ex):
                    continue
                sandbox_expires = self.service.reserve_sandbox(conn, ex) if hasattr(self.service, 'reserve_sandbox') else None
                aid, token = uid(), secrets.token_urlsafe(32)
                number = ex["attempt_no"] + 1
                preparing_seconds = 30 if self.s.provider == 'fc-internal' else 180
                attempt = dict(id=aid, execution_id=ex["id"], number=number, owner=self.owner,
                    token_hash=hashlib.sha256(token.encode()).hexdigest(), state="PREPARING",
                    lease_until=now + preparing_seconds, deadline=now + self.s.attempt_seconds + preparing_seconds,
                    poll_until=now + preparing_seconds, basis_revision=session["revision"],
                    config_digest=self.s.fingerprint(), sandbox_id=None, cleaned=0,
                    request_count=0, event_bytes=0, created=now)
                conn.execute(insert(attempts).values(**attempt))
                conn.execute(update(executions).where(executions.c.id == ex["id"])
                    .values(state="RUNNING", attempt_no=number, error=None))
                conn.execute(update(sessions).where(sessions.c.id == session["id"])
                    .values(active_execution=ex["id"]))
                self.db.event(conn, ex["id"], "attempt.started", {"attempt": number}, aid)
                attempt.update(session_id=ex['session_id'], sandbox_expires=sandbox_expires)
                return attempt, token
        return None

    def start(self, attempt, token):
        try:
            self.service.refresh_authorization(attempt["execution_id"])
            with self.db.tx() as conn:
                _, ex = self.service.lock_capability(conn, token)
                session = self.db.lock_session(conn, ex["session_id"])
                prompt, files = self.service.briefing(conn, ex, session)
            # Persist allocation intent in attempt before any remote creation.
            box = self.backend.create(attempt)
            with self.db.tx() as conn:
                session = self.db.lock_session(conn, ex["session_id"])
                current = row(conn, attempts, attempts.c.id == attempt["id"])
                conn.execute(update(attempts).where(attempts.c.id == attempt["id"]).values(sandbox_id=box, cleaned=0))
                if current["state"] not in ACTIVE:
                    raise PermissionError("Execution cancelled during allocation")
                self.service.assert_authorization(conn, ex)
                if self.s.provider == 'fc-internal':
                    # Execution receives its own budget after preparation, not both budgets.
                    conn.execute(update(attempts).where(attempts.c.id == attempt["id"]).values(
                        deadline=time.time() + self.s.attempt_seconds))
            spec = {"model": self.s.model, "gateway": self.s.gateway_url, "token": token,
                    "reasoning_effort": self.s.reasoning_effort,
                    "sandbox_mode": self.s.sandbox_mode, "prompt": prompt, "instructions": SYSTEM,
                    "seconds": self.s.attempt_seconds,
                    "attempt_id": attempt['id'],
                    "tool_names": [tool["name"] for tool in ex["capabilities"]["tools"]]}
            self.backend.start(box, spec, files)
            with self.db.tx() as conn:
                self.db.lock_session(conn, ex["session_id"])
                current = row(conn, attempts, attempts.c.id == attempt["id"])
                if current["state"] not in ACTIVE:
                    return
                conn.execute(update(attempts).where(attempts.c.id == attempt["id"])
                    .values(state="RUNNING", poll_until=0, lease_until=time.time() + self.s.lease_seconds))
        except Exception as error:
            self.fail(attempt["id"], self.error_code(error))
        finally:
            with self.db.tx() as conn:
                self.db.lock_session(conn, ex["session_id"] if "ex" in locals() else
                    row(conn, executions, executions.c.id == attempt["execution_id"])["session_id"])
                conn.execute(update(attempts).where(attempts.c.id == attempt["id"]).values(poll_until=0))

    @staticmethod
    def error_code(error):
        if isinstance(error, InputError):
            return str(error)[:128]
        if isinstance(error, PermissionError):
            return "EXECUTION_REVOKED"
        return type(error).__name__.upper()

    def fail(self, aid, error):
        with self.db.tx() as conn:
            a = row(conn, attempts, attempts.c.id == aid)
            if not a:
                return
            ex = row(conn, executions, executions.c.id == a["execution_id"])
            self.db.lock_session(conn, ex["session_id"])
            a = row(conn, attempts, attempts.c.id == aid)
            ex = row(conn, executions, executions.c.id == ex["id"])
            if a["state"] not in ACTIVE or ex["attempt_no"] != a["number"]:
                return
            unresolved = conn.execute(select(operations.c.id).where(
                (operations.c.execution_id == ex["id"]) &
                operations.c.state.in_(["SENT", "UNKNOWN"])).limit(1)).first()
            if unresolved:
                state, error = "WAITING_INPUT", "UNKNOWN_EXTERNAL_RESULT"
            elif error in {"AUTHORIZATION_REVOKED", "AUTHORIZATION_UNAVAILABLE", "AUTHORIZATION_EXPIRED", "PROVIDER_CONFIG_MISMATCH", "CONTEXT_SOURCE_LIMIT", "CONTEXT_INPUT_LIMIT",
                           "MODEL_REQUEST_BUDGET", "FILE_LIMIT", "WORKSPACE_LIMIT", "CLIENT_DISCONNECTED", "INSTANCE_RESTARTED",
                           "SANDBOX_MEMORY_LIMIT", "SANDBOX_WORKSPACE_LIMIT", "SANDBOX_RESOURCE_GUARD_FAILED"}:
                state = "WAITING_INPUT"
            elif a["number"] >= self.s.max_attempts:
                state = "FAILED"
            else:
                state = "RETRY_WAIT"
            # Allocation may still be in flight. Do not release its capacity or
            # race destruction until start() returns (or the allocation fence expires).
            allocation_until = a["poll_until"] if a["state"] == "PREPARING" else 0
            conn.execute(update(attempts).where(attempts.c.id == aid).values(state="FAILED", poll_until=allocation_until))
            conn.execute(update(executions).where(executions.c.id == ex["id"])
                .values(state=state, error=error, available=time.time() + min(60, 5 * 2 ** (a["number"] - 1))))
            self.db.event(conn, ex["id"], "turn.retrying" if state == "RETRY_WAIT" else
                          "turn.waiting" if state == "WAITING_INPUT" else "turn.failed",
                          {"reason": error, "state": state}, aid)

    def finish(self, aid, result):
        if not isinstance(result, dict) or not result.get("ok"):
            self.fail(aid, str(result.get("error", "INVALID_RESULT"))[:128] if isinstance(result, dict) else "INVALID_RESULT")
            return
        answer = result.get("answer")
        if not isinstance(answer, str) or not answer.strip() or len(answer.encode()) > 256000:
            self.fail(aid, "INVALID_ANSWER")
            return
        try:
            supplied = result.get("files", {})
            if not isinstance(supplied, dict):
                raise InputError("INVALID_FILES")
            files = {name: base64.b64decode(value, validate=True) for name, value in supplied.items()}
            self.service.blobs.validate_files(files)
            # Uploaded candidates are immutable; authorization/head advancement happens below.
            manifest = {name: self.service.blobs.put(data) for name, data in files.items()}
            with self.db.tx() as conn:
                a = row(conn, attempts, attempts.c.id == aid)
                ex = row(conn, executions, executions.c.id == a["execution_id"])
                session = self.db.lock_session(conn, ex["session_id"])
                a = row(conn, attempts, attempts.c.id == aid)
                ex = row(conn, executions, executions.c.id == ex["id"])
                if (a["state"] not in ACTIVE or ex["state"] != "RUNNING"
                    or ex["attempt_no"] != a["number"] or a["lease_until"] <= time.time()
                    or a["deadline"] <= time.time() or session["revision"] != a["basis_revision"]):
                    return
                self.service.assert_authorization(conn, ex)
                unknown = conn.execute(select(operations.c.id).where(
                    (operations.c.execution_id == ex["id"]) & operations.c.state.in_(["SENT", "UNKNOWN"]))).first()
                if unknown:
                    raise InputError("UNKNOWN_EXTERNAL_RESULT")
                for name, ref in manifest.items():
                    if name.startswith(("context/", "skills/")):
                        continue
                    artifact_id = uid()
                    conn.execute(insert(artifacts).values(id=artifact_id, tenant=ex["tenant"],
                        session_id=ex["session_id"], name=name, ref=ref, created=time.time()))
                    self.db.event(conn, ex["id"], "artifact.created",
                                  {"artifact_id": artifact_id, "name": name, "size": ref["size"]}, aid)
                conn.execute(update(sessions).where(sessions.c.id == session["id"])
                    .values(checkpoint=manifest, revision=session["revision"] + 1))
                conn.execute(update(executions).where(executions.c.id == ex["id"])
                    .values(state="COMMITTED", result=answer, error=None))
                conn.execute(update(attempts).where(attempts.c.id == aid).values(state="COMMITTED", poll_until=0))
                self.db.event(conn, ex["id"], "turn.completed", {"answer": answer}, aid)
        except Exception as error:
            self.fail(aid, self.error_code(error))

    def reconcile(self, aid):
        now = time.time()
        with self.db.tx(durable=False) as conn:
            a = row(conn, attempts, attempts.c.id == aid)
            ex = row(conn, executions, executions.c.id == a["execution_id"])
            self.db.lock_session(conn, ex["session_id"])
            a = row(conn, attempts, attempts.c.id == aid)
            if a["state"] not in ACTIVE or a["poll_until"] > now:
                return
            expired = a["lease_until"] <= now or a["deadline"] <= now
            if not expired:
                conn.execute(update(attempts).where(attempts.c.id == aid)
                    .values(poll_until=now + 30, lease_until=now + self.s.lease_seconds, owner=self.owner))
        if expired:
            self.fail(aid, "LEASE_EXPIRED")
            return
        try:
            if a["state"] == "PREPARING":
                self.fail(aid, "INTERRUPTED_ALLOCATION")
                return
            value = self.backend.inspect(a["sandbox_id"])
            if value is not None:
                self.finish(aid, value)
        except Exception as error:
            self.fail(aid, self.error_code(error))
        finally:
            with self.db.tx(durable=False) as conn:
                self.db.lock_session(conn, ex["session_id"])
                conn.execute(update(attempts).where((attempts.c.id == aid) &
                    (attempts.c.owner == self.owner)).values(poll_until=0))

    def cleanup(self, aid):
        with self.db.tx() as conn:
            a = row(conn, attempts, attempts.c.id == aid)
            if a["cleaned"] or a["state"] in ACTIVE or a["poll_until"] > time.time():
                return
            ex = row(conn, executions, executions.c.id == a['execution_id'])
            a['session_id'] = ex['session_id']
        try:
            self.backend.destroy(a)
        except Exception:
            LOG.warning("Sandbox cleanup pending: attempt=%s", aid)
            return
        with self.db.tx() as conn:
            ex = row(conn, executions, executions.c.id == a["execution_id"])
            session = self.db.lock_session(conn, ex["session_id"])
            conn.execute(update(attempts).where(attempts.c.id == aid).values(cleaned=1))
            if session["active_execution"] == ex["id"] and ex["state"] not in {"RUNNING", "RETRY_WAIT"}:
                conn.execute(update(sessions).where(sessions.c.id == session["id"]).values(active_execution=None))

    def tick(self, *, dispatch=True):
        with self.db.tx() as conn:
            active = list(conn.execute(select(attempts.c.id).where(attempts.c.state.in_(ACTIVE)).limit(20)).scalars())
            cleanup = list(conn.execute(select(attempts.c.id).where(
                (~attempts.c.state.in_(ACTIVE)) & (attempts.c.cleaned == 0)).limit(20)).scalars())
        for aid in active:
            self.reconcile(aid)
        for aid in cleanup:
            self.cleanup(aid)
        if dispatch:
            self.dispatch()

    def dispatch(self):
        claimed = self.claim()
        if claimed:
            self.start(*claimed)
