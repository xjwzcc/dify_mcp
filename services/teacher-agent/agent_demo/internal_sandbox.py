"""FC-internal bubblewrap provider; no model command runs outside the boundary."""
import json
import os
from pathlib import Path
import shutil
import signal
import socketserver
import subprocess
import sys
import threading
import http.client
import time

from .providers import encoded_spec
from .storage import InputError

BASE = Path(__file__).resolve().parents[1]
RUNTIME = BASE / 'sandbox_runtime'
ROOT = Path('/dev/shm/teacher-agent-sandboxes')
_instances = {}


def build_bwrap():
    target = BASE / 'bin/bwrap'
    if not target.is_file():
        raise RuntimeError('BUBBLEWRAP_NOT_PACKAGED')
    return target


def command(directory, executable, *, uid=20001, socket_path=None):
    args = [str(build_bwrap()), '--die-with-parent', '--unshare-all', '--new-session',
        '--cap-drop', 'ALL', '--uid', '10001', '--gid', '10001', '--dir', '/proc',
        # Rust current_exe() requires this path. It is a fixed synthetic link,
        # never a bind of host procfs or a view of another process.
        '--dir', '/proc/self', '--symlink', '/opt/agent-bin/codex', '/proc/self/exe',
        '--dev', '/dev', '--tmpfs', '/tmp', '--clearenv', '--setenv', 'LANG', 'C.UTF-8',
        '--setenv', 'PATH', '/opt/agent-bin:'+str(Path(sys.executable).parent)+':/usr/bin:/bin',
        '--bind', str(directory), '/runs', '--chdir', '/runs']
    mounted = []
    for root in [Path('/usr'), Path('/lib'), Path('/lib64'), Path('/bin'), Path(sys.base_prefix)]:
        if root.exists() and not any(root == old or old in root.parents for old in mounted):
            args += ['--ro-bind', str(root), str(root)]
            mounted.append(root)
    args += ['--ro-bind', str(RUNTIME), '/opt/runner', '--ro-bind', str(BASE / 'bin'), '/opt/agent-bin']
    if socket_path:
        args += ['--ro-bind', str(socket_path), '/gateway.sock']
    return [*args, '--', *executable]


class Proxy(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


class Handler(__import__('http.server', fromlist=['BaseHTTPRequestHandler']).BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_):
        pass

    def do_POST(self):
        # Fixed destination and allowlist. No TCP forwarding, CONNECT or SSRF.
        if self.path not in {'/v1/responses', '/internal/events', '/internal/tools'}:
            self.send_error(404); return
        size = int(self.headers.get('Content-Length', '-1'))
        if not 0 <= size <= 2_064_000 or self.headers.get('Transfer-Encoding'):
            self.send_error(413); return
        upstream = http.client.HTTPConnection('127.0.0.1', 9181, timeout=190)
        try:
            upstream.request('POST', self.path, body=self.rfile.read(size), headers={
                'Content-Type':'application/json', 'Authorization':'Bearer '+self.server.token})
            reply = upstream.getresponse()
            self.send_response(reply.status)
            self.send_header('Content-Type', reply.getheader('Content-Type','application/json'))
            self.send_header('Connection','close'); self.end_headers()
            while chunk := reply.read1(16384):
                self.wfile.write(chunk); self.wfile.flush()
        finally:
            self.close_connection = True
            upstream.close()


class InternalProvider:
    def __new__(cls, settings):
        if id(settings) not in _instances:
            value = super().__new__(cls)
            value.s = settings; value.boxes = {}; value.lock = threading.RLock()
            ROOT.mkdir(mode=0o711, exist_ok=True)
            _instances[id(settings)] = value
        return _instances[id(settings)]

    @staticmethod
    def name(aid):
        if len(aid) != 32 or any(c not in '0123456789abcdef' for c in aid):
            raise ValueError('Invalid attempt')
        return aid

    def find(self, aid):
        return aid if self.name(aid) in self.boxes else None

    def create(self, attempt):
        aid = self.name(attempt['id'])
        with self.lock:
            if aid in self.boxes:
                return aid
            root = ROOT / aid
            root.mkdir(mode=0o700)
            # One active execution globally; changing UID also separates stale descendants.
            uid = 20000 + int(aid[:6],16) % 40000
            # FC grants no CAP_SYS_ADMIN to its worker. Reuse its pre-mounted
            # 64 MiB tmpfs; only this directory is visible inside the sandbox.
            os.chown(root,uid,uid)
            self.boxes[aid] = {'root':root, 'uid':uid, 'process':None, 'proxy':None,
                               'deadline':attempt.get('deadline'), 'timer':None}
        return aid

    def start(self, aid, spec, files):
        box = self.boxes[aid]
        root, uid = box['root'], box['uid']
        path = root / 'spec.json'
        path.write_bytes(encoded_spec({**spec, 'gateway':'http://127.0.0.1:8080'}, files))
        os.chown(path,uid,uid); path.chmod(0o600)
        sock = ROOT / (aid+'.sock')
        proxy = Proxy(str(sock), Handler); proxy.token = spec['token']
        os.chown(sock,uid,uid); sock.chmod(0o600)
        box['proxy'] = proxy; box['socket'] = sock
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        box['process'] = subprocess.Popen(['/usr/bin/prlimit', '--nproc=96:96', '--nofile=256:256',
            '--fsize=24000000:24000000', '--as=1500000000:1500000000', '--cpu=180:180', '--core=0:0', '--',
            *command(root, [sys.executable, '/opt/runner/internal_entry.py'], socket_path=sock)],
            env={'PATH':'/usr/bin:/bin'}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, user=uid, group=uid, extra_groups=[], start_new_session=True)
        # Independent host-side wall-clock guard, even if the runner or OSS stalls.
        seconds = max(0.1, (box['deadline'] or time.time()+spec['seconds']) - time.time())
        box['timer'] = threading.Timer(seconds + 5, self.stop_process, args=(box,))
        box['timer'].daemon = True
        box['timer'].start()

    @staticmethod
    def stop_process(box):
        process = box['process']
        if process and process.poll() is None:
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            process.wait(timeout=5)

    def recover_workspaces(self):
        # Called once, before accepting work, after a fresh control process starts.
        # bwrap --die-with-parent fences the previous control process's children.
        for path in ROOT.iterdir():
            name = path.name.removesuffix('.sock')
            if len(name) != 32 or any(c not in '0123456789abcdef' for c in name):
                continue
            if path.is_symlink() or not path.is_dir():
                path.unlink(missing_ok=True)
            else:
                shutil.rmtree(path)

    def inspect(self, aid):
        box = self.boxes.get(aid)
        if not box:
            raise InputError('INSTANCE_RESTARTED')
        path = box['root'] / 'result.json'
        # Read the untrusted result without following symlinks out of its workspace.
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            if box['process'] and box['process'].poll() is not None:
                raise InputError('SANDBOX_EXIT_WITHOUT_RESULT')
            return None
        with os.fdopen(fd,'rb') as stream:
            import stat
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise InputError('INVALID_RESULT')
            raw = stream.read(24_000_001)
            if len(raw) > 24_000_000:
                raise InputError('RESULT_LIMIT')
            return json.loads(raw)

    def destroy(self, attempt):
        aid = self.name(attempt['id'])
        box = self.boxes.get(aid)
        if not box:
            return
        if box.get('timer'):
            box['timer'].cancel()
            if box['timer'] is not threading.current_thread():
                box['timer'].join(timeout=6)
        self.stop_process(box)
        if box['proxy']:
            box['proxy'].shutdown(); box['proxy'].server_close()
            box['socket'].unlink(missing_ok=True)
        shutil.rmtree(box['root'])
        self.boxes.pop(aid,None)

    def preflight(self):
        import tempfile
        mounts = [line.split() for line in Path('/proc/mounts').read_text().splitlines()]
        fs = os.statvfs(ROOT)
        if not any(row[1:3] == ['/dev/shm', 'tmpfs'] for row in mounts) or not 0 < fs.f_blocks * fs.f_frsize <= 64 * 1024 * 1024:
            raise RuntimeError('BOUNDED_SHM_UNAVAILABLE')
        with tempfile.TemporaryDirectory(prefix='preflight-',dir=ROOT) as work:
            directory=Path(work); os.chown(directory,20001,20001)
            source = ("import os,socket,pathlib; "
                "assert not pathlib.Path('/code').exists(); "
                "assert not pathlib.Path('/tmp/teaching-cache').exists(); "
                "assert 'DEEPSEEK_API_KEY' not in os.environ; "
                "assert os.getuid()==10001; "
                "s=socket.socket();s.settimeout(.2);assert s.connect_ex(('100.100.100.200',80))!=0; "
                "pathlib.Path('/runs/ok').write_text('ok');print('SANDBOX_OK')")
            result = subprocess.run(command(directory,[sys.executable,'-c',source]),
                env={'PATH':'/usr/bin:/bin'},user=20001,group=20001,extra_groups=[],
                capture_output=True, timeout=10)
            if result.returncode or result.stdout.strip() != b'SANDBOX_OK':
                raise RuntimeError('INTERNAL_SANDBOX_PREFLIGHT_FAILED: '+result.stderr.decode(errors='replace')[:300])
