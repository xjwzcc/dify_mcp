import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import httpx
from jsonschema import Draft202012Validator

NAME = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class Registry:
    def __init__(self, path: Path):
        self.root = path.resolve().parent
        self.data = json.loads(path.read_text())

    def freeze(self, profile, skills, principal):
        if profile not in principal.get("profiles", ["default"]):
            raise PermissionError("Profile not authorized")
        spec = self.data["profiles"].get(profile)
        if not spec:
            raise ValueError("Unknown profile")
        instructions = []
        for name in skills:
            if name not in spec.get("skills", []):
                raise PermissionError("Skill not authorized")
            directory = (self.root / self.data["skills"][name]).resolve()
            if not directory.is_relative_to(self.root) or not directory.is_dir():
                raise ValueError("Invalid skill directory")
            files = {}
            for path in sorted(directory.rglob("*")):
                if path.is_symlink():
                    raise ValueError("Skill symlinks are forbidden")
                if path.is_file():
                    data = path.read_text()
                    if len(data.encode()) > 128000:
                        raise ValueError("Skill file too large")
                    files[str(path.relative_to(directory))] = data
            if "SKILL.md" not in files or len(files) > 30:
                raise ValueError("Invalid skill bundle")
            instructions.append({"id": name, "files": files})
        tools = []
        for name in spec.get("tools", []):
            if not NAME.fullmatch(name):
                raise ValueError("Invalid tool name")
            tool = {"name": name, **self.data["tools"][name]}
            if tool.get("effect") not in {"read", "write"}:
                raise ValueError("Tools must declare read/write effects")
            Draft202012Validator.check_schema(tool["schema"])
            if tool["kind"] == "mcp" and not tool.get("url", "").startswith("https://"):
                raise ValueError("Remote MCP requires operator-configured HTTPS")
            tools.append(tool)
        return {"skills": instructions, "tools": tools}

    @staticmethod
    def schemas(capabilities):
        return [{"name": t["name"], "description": t["description"],
                 "inputSchema": t["schema"]} for t in capabilities["tools"]]


def parse_mcp_response(response):
    response.raise_for_status()
    if "text/event-stream" in response.headers.get("content-type", ""):
        for block in response.text.replace("\r\n", "\n").split("\n\n"):
            for line in block.splitlines():
                if line.startswith("data:"):
                    obj = json.loads(line[5:])
                    if "result" in obj or "error" in obj:
                        return obj
        raise ValueError("MCP stream missing response")
    return response.json()


def invoke_tool(tool, args, operation_id):
    if tool["kind"] == "clock":
        return {"content": [{"type": "text", "text": datetime.now(timezone.utc).isoformat()}]}
    if tool["kind"] != "mcp":
        raise ValueError("Unsupported tool adapter")
    import os
    headers = {"Accept": "application/json, text/event-stream"}
    if tool.get("bearer_env"):
        token = os.environ.get(tool["bearer_env"])
        if not token:
            raise RuntimeError("TOOL_CREDENTIAL_MISSING")
        headers["Authorization"] = "Bearer " + token
    # A new MCP session per invocation avoids unsynchronized shared sessions.
    with httpx.Client(timeout=60, follow_redirects=False, trust_env=False) as client:
        init = client.post(tool["url"], headers=headers, json={"jsonrpc": "2.0", "id": 1,
            "method": "initialize", "params": {"protocolVersion": "2025-03-26",
            "capabilities": {}, "clientInfo": {"name": "agent-demo", "version": "0.1.0"}}})
        msg = parse_mcp_response(init)
        if "error" in msg:
            raise RuntimeError("MCP_INITIALIZE_FAILED")
        version = msg["result"].get("protocolVersion", "2025-03-26")
        headers["MCP-Protocol-Version"] = version
        if init.headers.get("mcp-session-id"):
            headers["Mcp-Session-Id"] = init.headers["mcp-session-id"]
        client.post(tool["url"], headers=headers,
                    json={"jsonrpc": "2.0", "method": "notifications/initialized"}).raise_for_status()
        result = parse_mcp_response(client.post(tool["url"], headers=headers,
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                  "params": {"name": tool.get("remote_name", tool["name"]), "arguments": args}}))
        if "error" in result:
            raise RuntimeError("MCP_CALL_FAILED")
        return result["result"]
