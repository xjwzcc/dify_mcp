"""Write ignored local development credentials; never print the DeepSeek key."""
import getpass
import json
from pathlib import Path
import secrets

target = Path(".env")
if target.exists():
    raise SystemExit(".env already exists; edit it locally instead of overwriting credentials")
key = getpass.getpass("DeepSeek API key: ").strip()
if not key:
    raise SystemExit("A DeepSeek key is required")
chat = secrets.token_urlsafe(32)
text = Path(".env.example").read_text()
text = text.replace("CHAT_API_KEYS={}", "CHAT_API_KEYS=" + json.dumps({chat: {"tenant": "local", "profiles": ["default"]}}))
text = text.replace("BRIDGE_SIGNING_KEY=\n", "BRIDGE_SIGNING_KEY=" + secrets.token_hex(32) + "\n")
text = text.replace("CONTROL_ADMIN_KEY=\n", "CONTROL_ADMIN_KEY=" + secrets.token_urlsafe(32) + "\n")
text = text.replace("DEEPSEEK_API_KEY=\n", "DEEPSEEK_API_KEY=" + key + "\n")
with target.open("x") as f:
    f.write(text)
target.chmod(0o600)
print("Created .env. Use its CHAT_API_KEYS key in the browser; do not commit or share this file.")
