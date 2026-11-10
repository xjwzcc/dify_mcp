"""Non-destructive checks using the deployed controller's six-capability unit.

Runs an empty keeper and Codex --version inside bubblewrap, then a tiny model
probe against the existing Bridge. Does not modify classroom or Agent records.
"""
import hashlib
import hmac
import json
import os
import subprocess
import time
import urllib.request
import uuid

from agent_demo.config import Settings
from agent_demo.internal_sandbox import InternalProvider, command


def main():
    settings = Settings.from_env()
    settings.validate()
    provider = InternalProvider(settings)
    provider.preflight()
    print('SANDBOX_ISOLATION_PREFLIGHT_OK', flush=True)
    sid = uuid.uuid4().hex
    try:
        provider.create({'id': sid, 'sandbox_expires': time.time()+30})
        box = provider.boxes[sid]
        provider.launch(sid, box)
        print('SANDBOX_KEEPER_READY', flush=True)
        result = subprocess.run(command(box['root'], ['/opt/agent-bin/codex', '--version']),
            user=box['uid'], group=box['uid'], extra_groups=[],
            env={'PATH':'/usr/bin:/bin'}, capture_output=True, timeout=15, check=True)
        print('ISOLATED_CODEX_VERSION', result.stdout.decode().strip(), flush=True)
    finally:
        provider.end_session(sid)
    assert not provider.boxes
    print('SANDBOX_RECLAIMED', flush=True)

    scope = uuid.uuid4().hex
    token = hmac.new(settings.bridge_secret.encode(), ('expserver-codex:'+scope).encode(), hashlib.sha256).hexdigest()
    body = json.dumps({'model':settings.model, 'input':'计算2+2，只回复一个数字。',
                       'max_output_tokens':512, 'reasoning':{'effort':'low'}, 'stream':False}).encode()
    request = urllib.request.Request('http://127.0.0.1:9183/v1/responses', data=body,
        headers={'Content-Type':'application/json', 'Authorization':'Bearer '+token,
                 'X-Exp-Conversation-Id':scope})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=90) as response:
        value = json.load(response)
    answer = ''.join(part.get('text','') for item in value.get('output',[])
                     for part in item.get('content',[]) if part.get('type')=='output_text')
    assert answer.strip() == '4', 'MODEL_PROBE_INVALID_ANSWER'
    print('LIVE_DEEPSEEK_MODEL_RESPONSE_OK: 4', flush=True)


if __name__ == '__main__':
    main()
