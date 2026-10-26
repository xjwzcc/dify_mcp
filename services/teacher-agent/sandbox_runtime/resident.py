"""Retained namespace keeper controlled through private host pipes."""
import json
import signal
from pathlib import Path
import subprocess
import sys

from main import run

ROOT = Path('/runs')
CONTROL = Path('/control')


def turn():
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    spec = json.loads((CONTROL / 'spec.json').read_bytes())
    try:
        result = run(spec)
    except BaseException as error:
        result = {'ok':False, 'error':'RUNNER_' + type(error).__name__.upper()}
    result['attempt_id'] = spec['attempt_id']
    temporary = ROOT / 'result.pending'
    temporary.write_text(json.dumps(result))
    temporary.replace(ROOT / 'result.json')


def keep():
    from internal_entry import serve
    serve()
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    print('READY', flush=True)
    # stdin/stdout belong only to the trusted host. Model children receive neither
    # pipe; the synthetic /proc cannot expose another process's descriptors.
    for line in sys.stdin:
        command = json.loads(line)
        if command['action'] == 'run':
            subprocess.Popen(['/usr/bin/prlimit', '--cpu=180:180', '--',
                sys.executable, '/opt/runner/resident.py', '--turn'],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True)
        elif command['action'] != 'idle':
            raise ValueError('Unknown control command')
        print(command['id'], flush=True)


if __name__ == '__main__':
    turn() if '--turn' in sys.argv else keep()
