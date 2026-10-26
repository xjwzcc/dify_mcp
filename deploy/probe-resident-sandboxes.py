"""Manual Linux/FC probe: temporary isolated tasks, no model API or classroom data.

Run with PROBE_COUNT=30 and the deployed teacher-agent on PYTHONPATH.
Requires root for the same per-sandbox UID drop used by the FC provider.
"""
import concurrent.futures,json,os,shutil,tempfile,time,uuid
from pathlib import Path
from agent_demo.config import Settings
from agent_demo import internal_sandbox as module

if os.geteuid()!=0:
 raise SystemExit('Run only inside the authorized FC/Linux instance')
count=int(os.environ.get('PROBE_COUNT','30'))
if not 1<=count<=30:raise SystemExit('PROBE_COUNT must be 1..30')
original=module.BASE
probe=Path(tempfile.mkdtemp(prefix='teacher-resident-probe-',dir='/tmp'))
probe.chmod(0o755)
(probe/'bin').mkdir();(probe/'sandboxes').mkdir(mode=0o711)
(probe/'bin'/'bwrap').symlink_to(original/'bin'/'bwrap')
fake=probe/'bin'/'codex'
fake.write_text('''#!/usr/bin/python3
import json,sys,time,os
from pathlib import Path
os.chdir(sys.argv[sys.argv.index('-C')+1])
prompt=sys.stdin.read()
Path('probe.txt').write_text('retained-probe')
time.sleep(20 if prompt=='batch' else 1)
Path(sys.argv[sys.argv.index('-o')+1]).write_text('sandbox-probe-ok')
print(json.dumps({'type':'turn.completed'}),flush=True)
''');fake.chmod(0o755)
module.BASE=probe;module.ROOT=probe/'sandboxes'
s=Settings(max_active=30,max_sandboxes=30)
p=module.InternalProvider(s)
original_popen=module.subprocess.Popen
def logged_popen(*args,**kwargs):
 kwargs['stderr']=open(probe/'stderr.log','ab');return original_popen(*args,**kwargs)
module.subprocess.Popen=logged_popen
ids=[uuid.uuid4().hex for _ in range(count)]
probe_uid_base=100000+os.getpid()*32
spec={'seconds':180,'token':'isolated-probe-token','model':'deepseek-flash','reasoning_effort':'low','sandbox_mode':'danger-full-access','prompt':'batch','instructions':'controlled sandbox lifecycle probe','tool_names':[]}
started=time.monotonic()
try:
 def start(index):
  sid=ids[index];aid=uuid.uuid4().hex
  p.create({'id':aid,'session_id':sid,'sandbox_expires':time.time()+28800})
  box=p.boxes[sid];box['uid']=probe_uid_base+index;os.chown(box['root'],box['uid'],box['uid'])
  p.start(sid,{**spec,'attempt_id':aid},{})
  return sid,aid,box['process'].pid
 pool=concurrent.futures.ThreadPoolExecutor(max_workers=count)
 jobs=list(pool.map(start,range(count)))
 live=sum(box['process'].poll() is None for box in p.boxes.values())
 print(json.dumps({'started':len(jobs),'live_namespaces':live,'startup_seconds':round(time.monotonic()-started,2)}),flush=True)
 if live!=count:
  print('PROBE_FAILURE',[(p.boxes[sid]['process'].returncode,p.boxes[sid]['failure'],sorted(p.boxes[sid]['baseline'])) for sid,_,_ in jobs],flush=True)
  print((probe/'stderr.log').read_text(),flush=True)
 assert live==count
 for sid,aid,pid in jobs:
  until=time.monotonic()+60
  result=None
  while time.monotonic()<until:
   result=p.inspect(sid)
   if result:break
   time.sleep(.1)
  assert result and result['ok'],result
  p.destroy({'id':aid,'session_id':sid,'state':'COMMITTED'})
  assert p.boxes[sid]['process'].pid==pid
 sid,_,pid=jobs[0];aid=uuid.uuid4().hex
 assert (p.boxes[sid]['root']/'workspace/probe.txt').read_text()=='retained-probe'
 p.start(sid,{**spec,'prompt':'second','attempt_id':aid},{})
 assert p.boxes[sid]['process'].pid==pid
 until=time.monotonic()+20
 while time.monotonic()<until:
  result=p.inspect(sid)
  if result:break
  time.sleep(.1)
 assert result['ok'];p.destroy({'id':aid,'session_id':sid,'state':'COMMITTED'})
 print(json.dumps({'completed':count,'second_turn_same_pid':True,'retained':len(p.boxes),'memory_bytes':Path('/sys/fs/cgroup/memory/memory.usage_in_bytes').read_text().strip()}),flush=True)
 p.start(sid,{**spec,'attempt_id':uuid.uuid4().hex},{})
 p.end_session(sid);assert sid not in p.boxes
 print('EXPLICIT_CLOSE_OK',flush=True)
finally:
 if (probe/'stderr.log').exists():print('PROBE_STDERR', (probe/'stderr.log').read_text(),flush=True)
 keeper_pids=set().union(*(box['baseline'] for box in p.boxes.values()))
 for sid in list(p.boxes):p.end_session(sid)
 assert not list(module.ROOT.iterdir())
 assert not any(Path('/proc/'+str(pid)).exists() for pid in keeper_pids),'UNREAPED_KEEPER'
 print('NO_KEEPER_ZOMBIES',flush=True)
 shutil.rmtree(probe)
 if 'pool' in locals():pool.shutdown()
 print('PROBE_CLEANUP_OK',flush=True)
