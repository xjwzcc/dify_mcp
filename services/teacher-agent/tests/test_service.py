import base64
from concurrent.futures import ThreadPoolExecutor
import pytest
from sqlalchemy import insert, select, update
from agent_demo.db import executions, sessions, attempts, operations, events, row, uid
from agent_demo.worker import Worker
from agent_demo.storage import InputError


def setup(service, principal, backend):
    sid = service.create_session('a')['session_id']
    eid = service.submit(principal, sid, 'r1', 'Analyse the data', [], ['data-analysis'], 'default')
    worker = Worker(service, backend)
    attempt, token = worker.claim()
    worker.start(attempt, token)
    return sid, eid, worker, attempt, token


def test_tenant_and_request_id_isolation(service, principal):
    sid = service.create_session('a')['session_id']
    fn = lambda _: service.submit(principal, sid, 'same', 'hello', [], [], 'default')
    with ThreadPoolExecutor(max_workers=4) as pool:
        ids = list(pool.map(fn, range(4)))
    assert len(set(ids)) == 1
    with pytest.raises(InputError, match='REQUEST_ID_CONFLICT'):
        service.submit(principal, sid, 'same', 'changed', [], [], 'default')
    with service.db.tx() as c:
        with pytest.raises(KeyError): service.session(c, 'b', sid)
        with pytest.raises(KeyError): service.execution(c, 'b', ids[0])
    upload = service.upload('a', sid, 'data.csv', b'a,b\n1,2')
    other = service.create_session('b')['session_id']
    with pytest.raises(KeyError):
        service.submit({'tenant':'b'}, other, 'x', 'hello', [upload['artifact_id']], [], 'default')


def test_claim_is_single_writer_and_events_deduplicate(service, principal, backend):
    sid = service.create_session('a')['session_id']
    service.submit(principal, sid, '1', 'one', [], [], 'default')
    service.submit(principal, sid, '2', 'two', [], [], 'default')
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: Worker(service, backend).claim(), range(2)))
    a, token = next(c for c in claims if c)
    assert sum(c is not None for c in claims) == 1
    seq = service.emit(token, 'assistant.delta', {'text':'hello'}, 'stable')
    assert service.emit(token, 'assistant.delta', {'text':'hello'}, 'stable') == seq
    with pytest.raises(InputError): service.emit(token, 'turn.completed', {}, 'illegal')


def test_checkpoint_and_next_briefing(service, principal, backend):
    sid, eid, worker, attempt, token = setup(service, principal, backend)
    worker.finish(attempt['id'], {'ok':True, 'answer':'done', 'files':{
        'out.txt':base64.b64encode(b'real data').decode(),
        'skills/data-analysis/SKILL.md':base64.b64encode(b'stale').decode()}})
    worker.cleanup(attempt['id'])
    eid2 = service.submit(principal, sid, 'r2', 'continue', [], [], 'default')
    a2, t2 = worker.claim()
    worker.start(a2,t2)
    spec, files = backend.specs[a2['id']]
    assert a2['id'] != attempt['id'] and t2 != token
    assert files['out.txt'] == b'real data'
    assert not any(x.startswith('skills/') for x in files)
    assert 'Analyse the data' in spec['prompt'] and 'assistant_claim' in spec['prompt']
    with service.db.tx() as c:
        assert row(c, sessions, sessions.c.id == sid)['revision'] == 1
        with pytest.raises(PermissionError): service.lock_capability(c, token)


def test_cancel_fences_result_and_cleans_before_next(service, principal, backend):
    sid, eid, worker, attempt, token = setup(service, principal, backend)
    service.cancel('a', eid)
    service.submit(principal, sid, '2', 'next', [], [], 'default')
    assert worker.claim() is None
    worker.finish(attempt['id'], {'ok':True,'answer':'late','files':{}})
    with service.db.tx() as c:
        assert row(c, sessions, sessions.c.id == sid)['revision'] == 0
        with pytest.raises(PermissionError): service.lock_capability(c,token)
    worker.cleanup(attempt['id'])
    assert attempt['id'] in backend.destroyed
    assert worker.claim() is not None


def test_expired_attempt_retried_with_new_capability(service, principal, backend):
    sid, eid, worker, attempt, token = setup(service, principal, backend)
    with service.db.tx() as c:
        c.execute(update(attempts).where(attempts.c.id==attempt['id']).values(lease_until=0))
    worker.reconcile(attempt['id'])
    worker.cleanup(attempt['id'])
    with service.db.tx() as c:
        assert row(c,executions,executions.c.id==eid)['state']=='RETRY_WAIT'
        c.execute(update(executions).where(executions.c.id==eid).values(available=0))
    new, token2 = worker.claim()
    assert new['number']==2 and token2!=token
    with service.db.tx() as c:
        with pytest.raises(PermissionError): service.lock_capability(c,token)


def test_unknown_write_never_replayed(service, principal, backend, monkeypatch):
    sid, eid, worker, attempt, token = setup(service, principal, backend)
    tool={'name':'write_test','kind':'clock','description':'test','effect':'write',
          'schema':{'type':'object','properties':{},'additionalProperties':False}}
    with service.db.tx() as c:
        c.execute(update(executions).where(executions.c.id==eid).values(capabilities={'skills':[],'tools':[tool]}))
    calls=[]
    def uncertain(*args):
        calls.append(args)
        raise TimeoutError()
    monkeypatch.setattr('agent_demo.service.invoke_tool', uncertain)
    with pytest.raises(TimeoutError): service.tool_call(token,'write_test',{})
    with pytest.raises(InputError,match='UNKNOWN_EXTERNAL_RESULT'): service.tool_call(token,'write_test',{})
    assert len(calls)==1
    worker.fail(attempt['id'],'TIMEOUT')
    with service.db.tx() as c:
        assert row(c,executions,executions.c.id==eid)['state']=='WAITING_INPUT'


def test_model_budget_and_config_fence(service, principal, backend):
    _, _, _, _, token = setup(service, principal, backend)
    service.s.max_model_requests=1
    service.reserve_model_request(token)
    with pytest.raises(InputError,match='MODEL_REQUEST_BUDGET'): service.reserve_model_request(token)
    service.s.model='changed'
    with service.db.tx() as c:
        with pytest.raises(InputError,match='PROVIDER_CONFIG_MISMATCH'): service.lock_capability(c,token)


def test_cancel_during_allocation_cleanup_waits(service, principal, backend):
    sid=service.create_session('a')['session_id']
    eid=service.submit(principal,sid,'a','hi',[],[],'default')
    worker=Worker(service,backend)
    a,t=worker.claim()
    def create(attempt):
        service.cancel('a',eid)
        worker.cleanup(a['id'])
        assert not backend.destroyed
        return attempt['id']
    backend.create=create
    worker.start(a,t)
    worker.cleanup(a['id'])
    assert backend.destroyed==[a['id']]


def test_operator_resolution_requires_cleanup_and_can_resume(service, principal, backend):
    sid,eid,worker,a,t=setup(service,principal,backend)
    op=uid()
    with service.db.tx() as c:
        c.execute(insert(operations).values(id=op,execution_id=eid,attempt_id=a['id'],
            tool='write',args_hash='a'*64,args={},state='SENT'))
    worker.fail(a['id'],'TIMEOUT')
    with pytest.raises(InputError,match='UNKNOWN_EXTERNAL_RESULT'):service.resume('a',eid)
    with pytest.raises(InputError,match='cleanup'):service.resolve_operation(op,'confirmed',{'id':'external-1'})
    worker.cleanup(a['id'])
    service.resolve_operation(op,'confirmed',{'id':'external-1'})
    service.resume('a',eid)
    assert worker.claim() is not None


def test_unknown_write_fences_new_execution(service,principal,backend,monkeypatch):
    sid,eid,worker,a,t=setup(service,principal,backend)
    with service.db.tx() as c:
        c.execute(insert(operations).values(id=uid(),execution_id=eid,attempt_id=a['id'],
            tool='write',args_hash='b'*64,args={},state='UNKNOWN'))
    service.cancel('a',eid);worker.cleanup(a['id'])
    eid2=service.submit(principal,sid,'next','do another write',[],[],'default')
    a2,t2=worker.claim()
    with service.db.tx() as c:
        c.execute(update(executions).where(executions.c.id==eid2).values(capabilities={'skills':[],
            'tools':[{'name':'write','effect':'write','kind':'clock','schema':{'type':'object'}}]}))
    with pytest.raises(InputError,match='UNKNOWN_EXTERNAL_RESULT'):service.tool_call(t2,'write',{'different':1})


def test_mcp_write_is_error_stays_uncertain(service,principal,backend,monkeypatch):
    _,eid,worker,a,t=setup(service,principal,backend)
    with service.db.tx() as c:
        c.execute(update(executions).where(executions.c.id==eid).values(capabilities={'skills':[],
            'tools':[{'name':'write','effect':'write','kind':'clock','schema':{'type':'object'}}]}))
    monkeypatch.setattr('agent_demo.service.invoke_tool',lambda *args:{'isError':True,'content':[]})
    service.tool_call(t,'write',{})
    worker.fail(a['id'],'TOOL_ERROR')
    with service.db.tx() as c:
        assert row(c,executions,executions.c.id==eid)['state']=='WAITING_INPUT'


def test_empty_answer_cannot_commit(service,principal,backend):
    sid,eid,worker,a,t=setup(service,principal,backend)
    worker.finish(a['id'],{'ok':True,'answer':'','files':{}})
    with service.db.tx() as c:
        assert row(c,sessions,sessions.c.id==sid)['revision']==0
        assert row(c,executions,executions.c.id==eid)['state']=='RETRY_WAIT'
