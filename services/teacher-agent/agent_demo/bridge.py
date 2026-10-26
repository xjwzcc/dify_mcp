"""Run the existing Node Bridge outside the untrusted execution sandbox."""
from contextlib import contextmanager
import os
import secrets
from pathlib import Path
import subprocess
import time
from urllib.parse import urlparse
import httpx


@contextmanager
def managed_bridge(settings):
    if len(settings.bridge_secret) < 32:
        raise ValueError("BRIDGE_SIGNING_KEY must contain at least 32 characters")
    if not settings.deepseek_key:
        raise ValueError("DEEPSEEK_API_KEY required")
    parsed = urlparse(settings.bridge_url)
    if parsed.hostname != "127.0.0.1":
        raise ValueError("The signing Bridge must be loopback-only")
    env = {k: os.environ[k] for k in ("PATH", "LANG", "NODE_EXTRA_CA_CERTS") if k in os.environ}
    instance = secrets.token_hex(16)
    env.update(BRIDGE_INSTANCE_ID=instance, UPSTREAM_PROVIDER="deepseek", DEEPSEEK_BASE_URL=settings.deepseek_url,
               DEEPSEEK_API_KEY=settings.deepseek_key, UPSTREAM_MODEL=settings.model,
               BRIDGE_API_KEY=settings.bridge_secret, PORT=str(parsed.port or 8787),
               HOST="127.0.0.1", PAYLOAD_LOG_ENABLED="false",
               MAX_OUTPUT_TOKENS=str(settings.max_output_tokens))
    process = subprocess.Popen(["node", str(Path(os.environ.get("BRIDGE_DIR", "bridge")).resolve() / "bridge.js")], env=env)
    try:
        with httpx.Client(trust_env=False, timeout=1) as client:
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError("Bridge exited")
                try:
                    reply = client.get(settings.bridge_url + "/health")
                    if reply.status_code == 200 and reply.json().get("instance") == instance:
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError("Bridge readiness timed out")
        yield process
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
