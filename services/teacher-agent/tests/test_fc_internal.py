from pathlib import Path
from types import SimpleNamespace
import pytest
from sqlalchemy import insert, select
from agent_demo.db import sessions
from agent_demo.fc_storage import FcDatabase
from agent_demo.config import Settings
from agent_demo import internal_sandbox


class Remote:
    value=b''
    writes=0
    fail=False
    def request(self,method,route,data=None):
        if method=='PUT':
            if self.fail:
                raise TimeoutError()
            self.value=data; self.writes+=1
        return self.value


def test_durable_sql_commit_recovery_and_poison(tmp_path):
    remote=Remote()
    db=FcDatabase(Settings(data_dir=tmp_path/'one'),remote); db.initialize()
    with db.tx() as conn:
        conn.execute(insert(sessions).values(id='session',tenant='teacher',revision=0,checkpoint={},created=1))
    writes=remote.writes
    with db.tx() as conn:
        assert conn.execute(select(sessions.c.tenant)).scalar()=='teacher'
    assert remote.writes==writes
    restored=FcDatabase(Settings(data_dir=tmp_path/'two'),remote)
    with restored.tx() as conn:
        assert conn.execute(select(sessions.c.id)).scalar()=='session'
    remote.fail=True
    with pytest.raises(RuntimeError,match='DURABILITY_UNKNOWN'):
        with db.tx() as conn:
            conn.execute(sessions.update().values(revision=1))
    with pytest.raises(RuntimeError,match='DURABILITY_UNKNOWN'):
        with db.tx(): pass


def test_internal_boundary_has_no_host_mount_or_network(monkeypatch,tmp_path):
    monkeypatch.setattr(internal_sandbox,'build_bwrap',lambda:Path('/trusted/bwrap'))
    args=internal_sandbox.command(tmp_path,['python3','/opt/runner/main.py'],socket_path=tmp_path/'gateway.sock')
    assert '--unshare-all' in args and '--clearenv' in args
    assert '--share-net' not in args
    assert args[args.index('--cap-drop')+1]=='ALL'
    assert ['--ro-bind','/','/'] not in [args[i:i+3] for i in range(len(args)-2)]
    assert '/code' not in args and '/tmp/teaching-cache' not in args
    assert '--proc' not in args
    i=args.index('--symlink')
    assert args[i:i+3]==['--symlink','/opt/agent-bin/codex','/proc/self/exe']
    assert args[-3:]==['--','python3','/opt/runner/main.py']


def test_internal_config_requires_durable_single_writer():
    with pytest.raises(ValueError,match='one active'):
        Settings(provider='fc-internal').validate()
    Settings(provider='fc-internal',blob_backend='fc-oss',max_active=1).validate()


def test_result_symlink_does_not_escape(tmp_path):
    provider=object.__new__(internal_sandbox.InternalProvider)
    root=tmp_path/'box';root.mkdir()
    secret=tmp_path/'outside';secret.write_text('{"ok":true}')
    (root/'result.json').symlink_to(secret)
    provider.boxes={'a':{'root':root,'process':None}}
    with pytest.raises(OSError): provider.inspect('a')


def test_workspace_cleanup_needs_no_mount_and_preserves_symlink_target(monkeypatch,tmp_path):
    import threading
    root=tmp_path/'work';root.mkdir()
    monkeypatch.setattr(internal_sandbox,'ROOT',root)
    monkeypatch.setattr(internal_sandbox.os,'chown',lambda *args:None)
    monkeypatch.setattr(internal_sandbox.subprocess,'run',lambda *args,**kw:pytest.fail('host mount is forbidden'))
    provider=object.__new__(internal_sandbox.InternalProvider)
    provider.boxes={};provider.lock=threading.RLock()
    aid='a'*32
    provider.create({'id':aid})
    outside=tmp_path/'outside';outside.write_text('preserve')
    (root/aid/'link').symlink_to(outside)
    provider.destroy({'id':aid})
    assert not (root/aid).exists() and outside.read_text()=='preserve'


def test_progress_batches_and_stale_snapshot_cannot_replace_final_commit(tmp_path):
    remote=Remote()
    db=FcDatabase(Settings(data_dir=tmp_path/'one'),remote); db.initialize()
    with db.tx() as conn:
        conn.execute(insert(sessions).values(id='s',tenant='teacher',revision=0,checkpoint={},created=1))
    before=remote.writes
    for revision in range(1,101):
        with db.tx(durable=False) as conn:
            conn.execute(sessions.update().values(revision=revision))
    assert remote.writes==before  # 100 draft updates perform zero synchronous OSS writes.
    old=db.snapshot()
    db.persist(old)
    assert remote.writes==before+1
    with db.tx() as conn:
        conn.execute(sessions.update().values(revision=101))
    db.persist(old)
    assert remote.writes==before+2
    restored=FcDatabase(Settings(data_dir=tmp_path/'restored'),remote)
    with restored.tx() as conn:
        assert conn.execute(select(sessions.c.revision)).scalar()==101


def test_background_upload_does_not_block_deltas_and_final_waits(tmp_path):
    import threading
    remote=Remote()
    db=FcDatabase(Settings(data_dir=tmp_path/'one'),remote); db.initialize()
    with db.tx() as conn:
        conn.execute(insert(sessions).values(id='s',tenant='teacher',revision=0,checkpoint={},created=1))
    with db.tx(durable=False) as conn:
        conn.execute(sessions.update().values(revision=1))
    entered,release,draft_done,final_done=(threading.Event() for _ in range(4))
    request=remote.request
    def blocked(method,route,data=None):
        if method=='PUT':
            entered.set()
            assert release.wait(5)
        return request(method,route,data)
    remote.request=blocked
    writer=threading.Thread(target=db.persist); writer.start()
    assert entered.wait(2)
    def draft():
        with db.tx(durable=False) as conn: conn.execute(sessions.update().values(revision=2))
        draft_done.set()
    t=threading.Thread(target=draft);t.start()
    def final():
        with db.tx() as conn: conn.execute(sessions.update().values(revision=3))
        final_done.set()
    f=threading.Thread(target=final)
    try:
        assert draft_done.wait(1), 'SSE progress blocked behind OSS network IO'
        f.start()
        assert not final_done.wait(.05), 'Final result acknowledged before durable commit'
    finally:
        release.set();writer.join(5);t.join(5)
        if f.ident: f.join(5)
    assert final_done.is_set()
    restored=FcDatabase(Settings(data_dir=tmp_path/'restored'),remote)
    with restored.tx() as conn: assert conn.execute(select(sessions.c.revision)).scalar()==3


def test_failed_background_upload_poison_and_notification(tmp_path):
    import threading
    remote=Remote();db=FcDatabase(Settings(data_dir=tmp_path),remote);db.initialize()
    revision=db.revision;woke=threading.Event()
    waiter=threading.Thread(target=lambda:(db.wait_for_change(revision,3),woke.set()));waiter.start()
    with db.tx(durable=False) as conn:
        conn.execute(insert(sessions).values(id='s',tenant='teacher',revision=0,checkpoint={},created=1))
    assert woke.wait(1);waiter.join(1)
    remote.fail=True
    with pytest.raises(RuntimeError,match='DURABILITY_UNKNOWN'): db.persist()
    with pytest.raises(RuntimeError,match='DURABILITY_UNKNOWN'):
        with db.tx(): pass


def test_startup_cleanup_is_scoped_and_does_not_follow_links(monkeypatch,tmp_path):
    root=tmp_path/'root';root.mkdir();outside=tmp_path/'keep';outside.mkdir()
    (outside/'saved').write_text('keep')
    (root/('a'*32)).mkdir();(root/('a'*32)/'spec.json').write_text('old')
    (root/('b'*32)).symlink_to(outside,target_is_directory=True)
    (root/('c'*32+'.sock')).touch();(root/'unrelated').write_text('keep')
    monkeypatch.setattr(internal_sandbox,'ROOT',root)
    provider=object.__new__(internal_sandbox.InternalProvider)
    provider.recover_workspaces()
    assert list(root.iterdir())==[root/'unrelated']
    assert (outside/'saved').read_text()=='keep'


def test_cleanup_cancels_deadline_and_kills_running_process(monkeypatch,tmp_path):
    from unittest.mock import Mock
    root=tmp_path/'box';root.mkdir()
    process=Mock(pid=43210);process.poll.return_value=None
    timer=Mock();kills=[]
    monkeypatch.setattr(internal_sandbox.os,'killpg',lambda pid,sig:kills.append(pid))
    provider=object.__new__(internal_sandbox.InternalProvider)
    provider.boxes={'a'*32:{'root':root,'process':process,'proxy':None,'timer':timer}}
    provider.destroy({'id':'a'*32})
    assert kills==[43210] and not root.exists() and not provider.boxes
    timer.cancel.assert_called_once();process.wait.assert_called_once()


def test_fc_gateway_streams_without_per_delta_remote_writes_and_final_is_durable(tmp_path,backend):
    import json
    import httpx
    from agent_demo.service import Service
    from agent_demo.storage import Blobs
    from agent_demo.gateway import Gateway
    from agent_demo.worker import Worker
    from agent_demo.db import executions
    settings=Settings(data_dir=tmp_path/'local',bridge_secret='s'*32,
        registry_path=Path(__file__).parents[1]/'config/capabilities.json')
    remote=Remote();db=FcDatabase(settings,remote);db.initialize()
    service=Service(settings,db,Blobs(settings))
    sid=service.create_session('teacher')['session_id']
    eid=service.submit({'tenant':'teacher'},sid,'request','hello',[],[],'default')
    worker=Worker(service,backend);attempt,token=worker.claim()
    items=[{'type':'response.output_text.delta','delta':'老师好。'}]*100+[{'type':'response.completed'}]
    handler=lambda req:httpx.Response(200,content=''.join('data: '+json.dumps(item)+'\n\n' for item in items))
    gateway=Gateway(service,lambda **kw:httpx.Client(transport=httpx.MockTransport(handler),**kw))
    _,_,stream=gateway.open(token,{'stream':True,'input':'hello'})
    before=remote.writes
    assert len(list(stream))==101
    assert remote.writes==before
    worker.finish(attempt['id'],{'ok':True,'answer':'老师好。'*100,'files':{}})
    assert remote.writes==before+1
    restored=FcDatabase(Settings(data_dir=tmp_path/'restored'),remote)
    with restored.tx() as conn:
        assert conn.execute(select(executions.c.state).where(executions.c.id==eid)).scalar()=='COMMITTED'
