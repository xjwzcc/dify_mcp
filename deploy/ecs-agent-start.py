"""Wait for the unprivileged OSS broker before starting the sandbox controller."""
import os
import sys
import time
import urllib.request


if __name__ == '__main__':
    if sys.version_info < (3, 11):
        raise SystemExit('Python 3.11 or newer required')
    request = urllib.request.Request('http://127.0.0.1:9182/database',
        headers={'Authorization': 'Bearer ' + os.environ['AGENT_PERSISTENCE_KEY']})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(60):
        try:
            with opener.open(request, timeout=2) as response:
                if response.status == 200:
                    break
        except OSError:
            if attempt == 59:
                raise SystemExit('Agent persistence broker did not become ready')
            time.sleep(1)
    os.execv(sys.executable, [sys.executable, '-m', 'agent_demo.fc_main'])
