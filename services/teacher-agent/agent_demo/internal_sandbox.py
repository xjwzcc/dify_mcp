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
import stat
import time
import secrets
import selectors

from .providers import encoded_spec
from .storage import InputError

BASE = Path(__file__).resolve().parents[1]
RUNTIME = BASE / 'sandbox_runtime'
ROOT = Path('/tmp/teacher-agent-sandboxes')
LEGACY_ROOT = Path('/dev/shm/teacher-agent-sandboxes')
MEMORY_BYTES = 512 * 1024 * 1024
WORKSPACE_BYTES = 64 * 1024 * 1024
_instances = {}


def build_bwrap():
    target = BASE / 'bin/bwrap'
    if not target.is_file():
        raise RuntimeError('BUBBLEWRAP_NOT_PACKAGED')
    return target


def command(directory, executable, *, uid=20001, socket_path=None, control_path=None):
    args = [str(build_bwrap()), '--die-with-parent', '--unshare-all', '--new-session',
        '--cap-drop', 'ALL', '--uid', '10001', '--gid', '10001', '--dir', '/proc',
        # Rust current_exe() requires this path. It is a fixed synthetic link,
        # never a bind of host procfs or a view of another process.
        '--dir', '/proc/self', '--symlink', '/opt/agent-bin/codex', '/proc/self/exe',
        '--dev', '/dev', '--size', str(WORKSPACE_BYTES), '--tmpfs', '/tmp', '--clearenv', '--setenv', 'LANG', 'C.UTF-8',
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
    if control_path:
        args += ['--ro-bind', str(control_path), '/control']
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
        token = self.server.token
        if not token or not secrets.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
            self.send_error(403); return
        size = int(self.headers.get('Content-Length', '-1'))
        if not 0 <= size <= 2_064_000 or self.headers.get('Transfer-Encoding'):
            self.send_error(413); return
        upstream = http.client.HTTPConnection('127.0.0.1', 9181, timeout=190)
        try:
            upstream.request('POST', self.path, body=self.rfile.read(size), headers={
                'Content-Type':'application/json', 'Authorization':'Bearer '+token})
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
            if sys.platform == 'linux':
                import ctypes
                # Adopt orphaned namespace init processes instead of leaving them
                # to FC's PID 1, which does not reliably reap nested bwrap children.
                if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0):
                    raise RuntimeError('SANDBOX_SUBREAPER_SETUP_FAILED')
            value = super().__new__(cls)
            value.s = settings; value.boxes = {}; value.ended = set(); value.lock = threading.RLock()
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

    def has_capacity(self, sid):
        with self.lock:
            return sid in self.boxes or len(self.boxes) < self.s.max_sandboxes

    def retained_sessions(self):
        with self.lock:
            return set(self.boxes)

    def create(self, attempt):
        sid = self.name(attempt.get('session_id') or attempt['id'])
        with self.lock:
            if sid in getattr(self, 'ended', set()):
                raise InputError('SESSION_CLOSED')
            if sid in self.boxes:
                return sid
            if len(self.boxes) >= getattr(getattr(self, 's', None), 'max_sandboxes', 30):
                raise InputError('SANDBOX_CAPACITY')
            root = ROOT / sid
            root.mkdir(mode=0o700)
            uid = 20000 + int(sid[:6],16) % 40000
            used = {box['uid'] for box in list(self.boxes.values())}
            while uid in used:
                uid = 20000 + (uid - 20000 + 1) % 40000
            os.chown(root,uid,uid)
            self.boxes[sid] = {'root':root, 'uid':uid, 'process':None, 'proxy':None,
                'timer':None, 'guard_stop':threading.Event(), 'failure':None,
                'cleanup_lock':threading.RLock(), 'baseline':set(), 'attempt_id':None,
                'expires':attempt.get('sandbox_expires') or time.time()+28800, 'reset':False}
        return sid

    @staticmethod
    def processes(box):
        result = set()
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                status = (path/'status').read_text()
                uid = next(line.split()[1] for line in status.splitlines() if line.startswith('Uid:'))
                if int(uid) == box['uid']:
                    result.add(int(path.name))
            except FileNotFoundError:
                pass
        return result

    @staticmethod
    def signal_pids(pids, sig):
        for pid in pids:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass

    @staticmethod
    def acknowledgement(box, expected):
        stream = box['process'].stdout
        with selectors.DefaultSelector() as selector:
            selector.register(stream, selectors.EVENT_READ)
            if not selector.select(5):
                raise InputError('SANDBOX_KEEPER_UNRESPONSIVE')
            if stream.readline(256).decode().strip() != expected:
                raise InputError('SANDBOX_KEEPER_PROTOCOL_ERROR')

    def control(self, box, action):
        nonce = secrets.token_hex(16)
        box['process'].stdin.write((json.dumps({'id':nonce, 'action':action})+'\n').encode())
        box['process'].stdin.flush()
        self.acknowledgement(box, nonce)

    def quiesce(self, box):
        # A private pipe acknowledgement fences dispatch before killing every other
        # process of this UID, including children that escaped using setsid().
        self.control(box, 'idle')
        for _ in range(50):
            children = self.processes(box) - box['baseline']
            if not children:
                return
            self.signal_pids(children, signal.SIGKILL)
            time.sleep(.02)
        raise InputError('SANDBOX_QUIESCE_FAILED')

    def launch(self, sid, box):
        root, uid = box['root'], box['uid']
        control = ROOT / (sid + '.control')
        control.mkdir(mode=0o755)
        box['control'] = control
        sock = ROOT / (sid+'.sock')
        proxy = Proxy(str(sock), Handler); proxy.token = ''
        os.chown(sock,uid,uid); sock.chmod(0o600)
        box['proxy'] = proxy; box['socket'] = sock
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        box['process'] = subprocess.Popen(['/usr/bin/prlimit', '--nproc=96:96', '--nofile=256:256',
            '--fsize=24000000:24000000', '--as=1500000000:1500000000', '--core=0:0', '--',
            *command(root, [sys.executable, '/opt/runner/resident.py'], socket_path=sock, control_path=control)],
            env={'PATH':'/usr/bin:/bin'}, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, user=uid, group=uid, extra_groups=[], start_new_session=True)
        self.acknowledgement(box, 'READY')
        box['baseline'] = self.processes(box)
        if not box['baseline']:
            raise InputError('SANDBOX_KEEPER_START_FAILED')
        box['lifetime_timer'] = threading.Timer(max(0, box['expires']-time.time()), self.expire,
            args=(box, 'SANDBOX_LIFETIME_EXPIRED'))
        box['lifetime_timer'].daemon = True
        box['lifetime_timer'].start()
        box['guard'] = threading.Thread(target=self.guard, args=(box,), daemon=True)
        box['guard'].start()

    @staticmethod
    def remove(path):
        if path.is_symlink() or not path.is_dir():
            path.unlink(missing_ok=True)
        else:
            shutil.rmtree(path)

    def start(self, sid, spec, files):
        box = self.boxes[sid]
        with box['cleanup_lock']:
            if self.boxes.get(sid) is not box or sid in getattr(self, 'ended', set()):
                raise InputError('SESSION_CLOSED')
            if box['expires'] <= time.time():
                raise InputError('SANDBOX_LIFETIME_EXPIRED')
            if not box['process']:
                self.launch(sid, box)
            if box['failure'] or box['process'].poll() is not None:
                raise InputError(box['failure'] or 'SANDBOX_EXIT_WITHOUT_RESULT')
            self.quiesce(box)
            root, uid = box['root'], box['uid']
            # Keep the actual namespace/workspace. Refresh private CLI config and
            # control files each turn; reset failed drafts from durable checkpoint.
            for path in root.iterdir():
                if path.name == 'workspace' and not box['reset']:
                    continue
                self.remove(path)
            box['reset'] = False
            box['attempt_id'] = spec['attempt_id']
            payload = encoded_spec({**spec, 'gateway':'http://127.0.0.1:8080'}, files)
            (box['control']/'spec.json').write_bytes(payload)
            (box['control']/'spec.json').chmod(0o644)
            box['proxy'].token = spec['token']
            box['timer'] = threading.Timer(spec['seconds']+5, self.expire, args=(box,'ATTEMPT_TIMEOUT'))
            box['timer'].daemon = True; box['timer'].start()
            self.control(box, 'run')

    @staticmethod
    def usage(box):
        # Host-side sampling includes descendants after setsid/fork by their unique UID.
        rss = 0
        for process in Path('/proc').iterdir():
            if not process.name.isdigit():
                continue
            try:
                fields = dict(line.split(':', 1) for line in (process / 'status').read_text().splitlines() if ':' in line)
                if int(fields['Uid'].split()[0]) == box['uid']:
                    rss += int(fields.get('VmRSS', '0 kB').split()[0]) * 1024
            except (FileNotFoundError, ProcessLookupError):
                continue
        size = 0
        # Never follow workspace links or read model-created special files.
        for directory, _, names in os.walk(box['root'], followlinks=False):
            for name in names:
                try:
                    info = os.lstat(Path(directory) / name)
                    if stat.S_ISREG(info.st_mode):
                        size += info.st_size
                except FileNotFoundError:
                    pass
        return rss, size

    def guard(self, box):
        # Independent of DB/OSS locks. These are sampled guards, not cgroup quotas.
        while not box['guard_stop'].wait(.5 if box.get('attempt_id') else 5):
            try:
                memory, disk = self.usage(box)
                if memory > MEMORY_BYTES or disk > WORKSPACE_BYTES:
                    self.expire(box, 'SANDBOX_MEMORY_LIMIT' if memory > MEMORY_BYTES else 'SANDBOX_WORKSPACE_LIMIT')
                    return
            except Exception:
                self.expire(box, 'SANDBOX_RESOURCE_GUARD_FAILED')
                return

    def expire(self, box, reason):
        box['failure'] = reason
        if box.get('proxy'):
            box['proxy'].token = ''
        self.stop_process(box)
        if reason == 'SANDBOX_LIFETIME_EXPIRED':
            sid = box['root'].name
            with box['cleanup_lock']:
                if self.boxes.get(sid) is box:
                    self._destroy(sid, box)

    @staticmethod
    def stop_process(box):
        process = box['process']
        if process and process.poll() is None:
            # EOF lets the keeper exit and bubblewrap reap its namespace init.
            # Killing the outer monitor first leaves a zombie with FC's PID 1.
            try:
                if process.stdin:
                    process.stdin.close()
                process.wait(timeout=2)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                try: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                process.wait(timeout=5)
        if process and 'uid' in box:
            InternalProvider.reap(box)

    @staticmethod
    def reap(box):
        for pid in InternalProvider.processes(box):
            try:
                fields = dict(line.split(':',1) for line in Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)
                if int(fields['PPid']) == os.getpid() and fields['State'].strip().startswith('Z'):
                    os.waitpid(pid, os.WNOHANG)
            except (FileNotFoundError, ProcessLookupError, ChildProcessError):
                pass

    def recover_workspaces(self):
        # Called once, before accepting work, after a fresh control process starts.
        # bwrap --die-with-parent fences the previous control process's children.
        for root in (ROOT, LEGACY_ROOT):
            if not root.exists() or root.is_symlink():
                continue
            for path in root.iterdir():
                name = path.name.removesuffix('.sock').removesuffix('.control')
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
        if box.get('failure'):
            raise InputError(box['failure'])
        path = box['root'] / 'result.json'
        # Read the untrusted result without following symlinks out of its workspace.
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            if box['process'] and box['process'].poll() is not None:
                raise InputError('SANDBOX_EXIT_WITHOUT_RESULT')
            return None
        with os.fdopen(fd,'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise InputError('INVALID_RESULT')
            raw = stream.read(24_000_001)
            if len(raw) > 24_000_000:
                raise InputError('RESULT_LIMIT')
            result = json.loads(raw)
            if box.get('attempt_id') and result.get('attempt_id') != box['attempt_id']:
                raise InputError('STALE_SANDBOX_RESULT')
            return result

    def destroy(self, attempt):
        sid = self.name(attempt.get('session_id') or attempt['id'])
        box = self.boxes.get(sid)
        if not box:
            return
        with box['cleanup_lock']:
            if self.boxes.get(sid) is not box:
                return
            if (not attempt.get('state') or box['failure'] or box['expires'] <= time.time()
                or (box['process'] and box['process'].poll() is not None)):
                self._destroy(sid, box)
                return
            if box['attempt_id'] not in {None, attempt['id']}:
                return  # Delayed cleanup must never stop a later turn.
            if box.get('proxy'):
                box['proxy'].token = ''
            if box.get('timer'):
                box['timer'].cancel()
                box['timer'].join(timeout=6)
                box['timer'] = None
            try:
                if box['process']:
                    self.quiesce(box)
            except Exception:
                self._destroy(sid, box)
                return
            box['attempt_id'] = None
            box['reset'] = attempt['state'] != 'COMMITTED'

    def end_session(self, sid):
        with self.lock:
            self.ended.add(sid)
            box = self.boxes.get(sid)
        if box:
            with box['cleanup_lock']:
                if self.boxes.get(sid) is box:
                    self._destroy(sid, box)

    def sweep(self):
        for sid, box in list(self.boxes.items()):
            if box['expires'] <= time.time() or box['failure']:
                with box['cleanup_lock']:
                    if self.boxes.get(sid) is box:
                        self._destroy(sid, box)

    def _destroy(self, sid, box):
        box['guard_stop'].set()
        if box.get('proxy'):
            box['proxy'].token = ''
        for key in ('timer', 'lifetime_timer'):
            timer = box.get(key)
            if timer:
                timer.cancel()
                if timer is not threading.current_thread():
                    timer.join(timeout=6)
        if box.get('guard') and box['guard'] is not threading.current_thread():
            box['guard'].join(timeout=6)
        self.stop_process(box)
        if box['process']:
            for stream in (box['process'].stdin, box['process'].stdout):
                if stream:
                    stream.close()
        if box['proxy']:
            box['proxy'].shutdown(); box['proxy'].server_close()
            box['socket'].unlink(missing_ok=True)
        self.remove(box['root'])
        if box.get('control'):
            self.remove(box['control'])
        with self.lock:
            self.boxes.pop(sid,None)

    def preflight(self):
        import tempfile
        if shutil.disk_usage(ROOT).free < (self.s.max_sandboxes + 2) * WORKSPACE_BYTES:
            raise RuntimeError('INSUFFICIENT_SANDBOX_DISK_CAPACITY')
        limits = [Path('/sys/fs/cgroup/memory.max'), Path('/sys/fs/cgroup/memory/memory.limit_in_bytes')]
        memory_limit = next((int(p.read_text()) for p in limits if p.exists() and p.read_text().strip().isdigit()), 0)
        if memory_limit < (self.s.max_active + 4) * MEMORY_BYTES + self.s.max_sandboxes * WORKSPACE_BYTES:
            raise RuntimeError('INSUFFICIENT_FC_MEMORY_FOR_CONCURRENCY')
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
