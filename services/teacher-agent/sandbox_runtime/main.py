"""Untrusted execution-side runner. Contains no provider/cloud/database credentials."""
import base64
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import time
import urllib.request

ROOT = Path("/runs")
WORK = ROOT / "workspace"


def safe_name(name):
    parts = name.split("/")
    return (bool(name) and len(name) <= 240 and not name.startswith("/") and "\\" not in name
            and "\0" not in name and not any(p in {"", ".", "..", ".git", ".codex", ".agents",
            ".venv", "node_modules", "__pycache__"} for p in parts)
            and parts[-1].lower() not in {"agents.md", "agents.override.md"})


def collect():
    files, total = {}, 0
    for directory, dirs, names in os.walk(WORK, followlinks=False):
        dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()
                   and d not in {".git", ".codex", ".agents", ".venv", "node_modules", "__pycache__"}]
        for name in names:
            path = Path(directory) / name
            relative = str(path.relative_to(WORK))
            info = path.lstat()
            if path.is_symlink() or not path.is_file() or info.st_nlink != 1 or not safe_name(relative):
                continue
            if info.st_size > 4_000_000:
                raise ValueError("FILE_LIMIT")
            data = path.read_bytes()
            total += len(data)
            if total > 16_000_000 or len(files) >= 200:
                raise ValueError("WORKSPACE_LIMIT")
            files[relative] = base64.b64encode(data).decode()
    return files


def post(spec, kind, payload, seq):
    data = json.dumps({"type": kind, "payload": payload, "source_id": "cli:" + str(seq)}).encode()
    request = urllib.request.Request(spec["gateway"] + "/internal/events", data=data,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + spec["token"]})
    try:
        urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=5).close()
    except Exception:
        pass  # Observability must not replay an external action.


def run(spec):
    for path in (ROOT / "home", ROOT / "tmp", WORK, ROOT / "logs"):
        path.mkdir(parents=True, exist_ok=True)
    for name, encoded in spec["files"].items():
        if not safe_name(name):
            raise ValueError("INVALID_INPUT_PATH")
        target = WORK / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(encoded, validate=True))
    q = json.dumps
    config = (
        'model_provider = "gateway"\nmodel = ' + q(spec["model"]) + '\n'
        'model_reasoning_effort = ' + q(spec.get("reasoning_effort", "high")) + '\n'
        'approval_policy = "never"\nsandbox_mode = ' + q(spec["sandbox_mode"]) + '\n'
        'project_doc_max_bytes = 0\nweb_search = "disabled"\n'
        'model_catalog_json = ' + q(str(Path(__file__).with_name('models.json'))) + '\n'
        'developer_instructions = ' + q(spec["instructions"]) + '\n'
        '[model_providers.gateway]\nname = "Sandbox Gateway"\n'
        'base_url = ' + q(spec["gateway"] + "/v1") + '\n'
        'wire_api = "responses"\nrequires_openai_auth = false\nenv_key = "ATTEMPT_TOKEN"\n'
        '[mcp_servers.business]\nrequired = true\ncommand = "python3"\nargs = [' + q(str(Path(__file__).with_name('mcp.py'))) + ']\n'
        '[mcp_servers.business.env]\nATTEMPT_TOKEN = ' + q(spec["token"]) + '\n'
        'GATEWAY_URL = ' + q(spec["gateway"]) + '\n'
    )
    # Only the host-authorized tool snapshot is preapproved for this noninteractive run.
    for name in spec["tool_names"]:
        config += "\n[mcp_servers.business.tools." + q(name) + "]\napproval_mode = \"approve\"\n"
    (ROOT / "home/config.toml").write_text(config)
    # Minimal inherited environment. Sandbox contains no upstream or management credentials.
    env = {"PATH": os.environ["PATH"], "HOME": str(ROOT / "home"), "CODEX_HOME": str(ROOT / "home"),
           "TMPDIR": str(ROOT / "tmp"), "ATTEMPT_TOKEN": spec["token"],
           "LANG": "C.UTF-8"}
    command = ["codex", "exec", "--json", "--skip-git-repo-check", "--sandbox", spec["sandbox_mode"],
               "-C", str(WORK), "-o", str(ROOT / "answer.txt"), "-"]
    stderr = (ROOT / "logs/stderr.log").open("wb")
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=stderr, env=env, start_new_session=True)
    process.stdin.write(spec["prompt"].encode())
    process.stdin.close()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    buffer, seen_complete, seen_failed, ordinal = b"", False, False, 0
    deadline = time.monotonic() + spec["seconds"]
    failure = None
    try:
        while selector.get_map():
            if time.monotonic() > deadline:
                failure = "ATTEMPT_TIMEOUT"
                break
            for key, _ in selector.select(timeout=0.2):
                data = os.read(key.fd, 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                buffer += data
                if len(buffer) > 4_000_000:
                    raise ValueError("CLI_EVENT_LIMIT")
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    ordinal += 1
                    kind = event.get("type")
                    if kind in {"error", "turn.failed"}:
                        diagnostic = json.dumps(event).replace(spec["token"], "[REDACTED]")
                        stderr.write((diagnostic[:4000] + "\n").encode())
                        stderr.flush()
                    seen_complete |= kind == "turn.completed"
                    seen_failed |= kind == "turn.failed"
                    item = event.get("item", {})
                    if item.get("type") in {"command_execution", "mcp_tool_call", "file_change"}:
                        post(spec, "tool.completed" if kind == "item.completed" else "tool.started",
                             {"item_id": item.get("id"), "kind": item["type"],
                              "status": item.get("status"), "exit_code": item.get("exit_code")}, ordinal)
                    elif kind in {"thread.started", "turn.started", "turn.failed"}:
                        post(spec, "attempt.activity", {"event": kind}, ordinal)
        if failure is None:
            process.wait(timeout=10)
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        selector.close()
        stderr.close()
    if failure or process.returncode or seen_failed or not seen_complete:
        return {"ok": False, "error": failure or "CODEX_TURN_FAILED"}
    answer = (ROOT / "answer.txt").read_text()
    if not answer.strip():
        raise ValueError("EMPTY_ANSWER")
    if len(answer.encode()) > 256000:
        raise ValueError("ANSWER_LIMIT")
    return {"ok": True, "answer": answer.replace(spec["token"], "[REDACTED]"), "files": collect()}


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    while not (ROOT / "spec.json").exists():
        if time.monotonic() - start > 60:
            return
        time.sleep(0.2)
    try:
        spec = json.loads((ROOT / "spec.json").read_bytes())
        result = run(spec)
    except BaseException as error:
        result = {"ok": False, "error": "RUNNER_" + type(error).__name__.upper()}
    temporary = ROOT / "result.pending"
    temporary.write_text(json.dumps(result))
    temporary.replace(ROOT / "result.json")
    # Keep Docker alive so tmpfs remains available for trusted export.
    # FC command is likewise explicitly terminated by the orchestrator.
    time.sleep(120)


if __name__ == "__main__":
    main()
