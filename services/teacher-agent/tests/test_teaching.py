import hashlib
import json
import time
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from agent_demo.api import create_app
from agent_demo.db import executions, attempts, sessions, row
from agent_demo.storage import InputError
from agent_demo.teaching import TeachingService, initialize_teaching, sign, verify, scope_table, page_query
from agent_demo.worker import Worker


@pytest.fixture
def teaching(service, monkeypatch):
    s = replace(service.s, teaching_mode=True, teaching_url='http://127.0.0.1:9000',
                teaching_deployment='test', teaching_verify_key='v' * 32, teaching_tool_key='t' * 32, max_active=2)
    initialize_teaching(service.db)
    value = TeachingService(s, service.db, service.blobs)
    monkeypatch.setattr(value, 'teaching_request', lambda identity, action, **kw: {
        'scope': {'course': identity['course']}, 'retrieved_at': '2026-10-26T00:00:00Z', 'source_version': {'revision': 1}, 'data': {}})
    return value


def signed(service, path, body=b'', method='GET', teacher='t1', course='hotel', **changes):
    now = int(time.time())
    claims = {'v': 1, 'iss': 'teaching-platform', 'aud': 'teacher-agent', 'deployment_id': 'test',
              'method': method, 'path': path, 'body_sha256': hashlib.sha256(body).hexdigest(),
              'iat': now, 'exp': now + 60, 'role': 'teacher', 'sub': teacher, 'course': course,
              'login_ref': 'a' * 64, 'login_expires_at': now + 3600, **changes}
    return sign(claims, service.s.teaching_verify_key)


def who(service, teacher='t1', course='hotel'):
    return verify(signed(service, '/', teacher=teacher, course=course), service.s.teaching_verify_key, 'GET', '/', b'', 'test')


def submit(service, principal=None, request_id='m1', sid=None, context=None):
    p = principal or who(service)
    p = {**p, 'page_context': context or {}}
    sid = sid or service.create_teacher_session(p, request_id)['session_id']
    eid = service.submit(p, sid, request_id, '总结课堂进度', [], ['teaching-assistant'], p['profiles'][0])
    return sid, eid


def test_signed_api_isolation_idempotency_and_history(teaching):
    client = TestClient(create_app(teaching.s, teaching))
    def call(path, obj=None, **claims):
        body = json.dumps(obj, ensure_ascii=False).encode() if obj is not None else b''
        method = 'POST' if obj is not None else 'GET'
        return client.request(method, path, content=body, headers={'Content-Type': 'application/json',
            'X-Teacher-Assertion': signed(teaching, path, body, method, **claims)})
    assert client.get('/api/chat/sessions', headers={'Authorization': 'Bearer ' + 'a'*32}).status_code == 403
    assert client.get('/').status_code == 404
    sid = call('/api/chat/sessions', {'request_id': 'session1'}).json()['session_id']
    assert call('/api/chat/sessions', {'request_id': 'session1'}).json()['session_id'] == sid
    msg = {'request_id': 'm1', 'message': '你好', 'page_context': {'page': 'teacher'}}
    path = f'/api/chat/sessions/{sid}/messages'
    first = call(path, msg)
    assert first.status_code == 202, first.text
    assert first.json() == call(path, msg).json()
    assert call(path, {**msg, 'message': '修改'}).status_code == 409
    assert call(path, {**msg, 'capability_profile': 'default'}).status_code == 400
    assert call(path, {**msg, 'teacher_id': 'evil'}).status_code == 422
    for claims in [{'teacher': 't2'}, {'course': 'catering'}]:
        assert call(f'/api/chat/sessions/{sid}/history', **claims).status_code == 404
    history = call(f'/api/chat/sessions/{sid}/history?limit=1').json()
    assert history['items'][0]['message'] == '你好'
    assert len(call('/api/chat/sessions').json()['items']) == 1
    tampered = client.get('/api/chat/sessions?limit=2', headers={'X-Teacher-Assertion': signed(teaching, '/api/chat/sessions')})
    assert tampered.status_code == 403


def test_teacher_capacity_and_cleanup_hold_slots(teaching, backend):
    worker = Worker(teaching, backend)
    _, a = submit(teaching, request_id='a')
    _, b = submit(teaching, request_id='b')
    _, c = submit(teaching, who(teaching, 't2'), 'c')
    _, d = submit(teaching, who(teaching, 't3'), 'd')
    first, _ = worker.claim()
    second, _ = worker.claim()
    assert {first['execution_id'], second['execution_id']} == {a, c}
    assert worker.claim() is None
    teaching.cancel(who(teaching)['tenant'], a)
    assert worker.claim() is None
    # An allocation in flight retains its slot until its fence expires/returns.
    worker.cleanup(first['id'])
    assert worker.claim() is None
    with teaching.db.tx() as conn:
        conn.execute(update(attempts).where(attempts.c.id == first['id']).values(poll_until=0))
    worker.cleanup(first['id'])
    assert worker.claim()[0]['execution_id'] == b


def test_authorization_fences_tools_and_late_commit(teaching, backend, monkeypatch):
    sid, eid = submit(teaching, context={'page': 'teacher', 'student_id': 'S1'})
    worker = Worker(teaching, backend)
    attempt, token = worker.claim()
    worker.start(attempt, token)
    spec, files = backend.specs[attempt['id']]
    assert b'login_ref' not in b''.join(files.values())
    assert json.loads(files['context/teaching.json'])['selection']['student_id'] == 'S1'
    result = teaching.tool_call(token, 'get_course_overview', {})
    assert 'evidence' in result['content'][0]['text']
    with pytest.raises(PermissionError):
        teaching.tool_call(token, 'publish_workorder', {})
    with pytest.raises(InputError, match='TOOL_ARGUMENT_SCHEMA'):
        teaching.tool_call(token, 'get_course_overview', {'teacher_id': 'evil'})
    with teaching.db.tx() as conn:
        conn.execute(update(scope_table).where(scope_table.c.execution_id == eid).values(valid_until=0))
    with pytest.raises(InputError, match='AUTHORIZATION_EXPIRED'):
        teaching.reserve_model_request(token)
    worker.finish(attempt['id'], {'ok': True, 'answer': '迟到的答案', 'files': {}})
    with teaching.db.tx() as conn:
        ex = row(conn, executions, executions.c.id == eid)
        assert ex['state'] == 'WAITING_INPUT' and ex['result'] is None
        assert row(conn, sessions, sessions.c.id == sid)['revision'] == 0
    worker.cleanup(attempt['id'])
    teaching.resume_teacher(who(teaching), eid)
    monkeypatch.setattr(teaching, 'teaching_request', lambda *a, **kw: (_ for _ in ()).throw(InputError('AUTHORIZATION_REVOKED')))
    again, token = worker.claim()
    worker.start(again, token)
    assert again['id'] not in backend.specs


def test_pending_limit_pagination_and_attachment_boundaries(teaching):
    p = who(teaching)
    sid, eid = submit(teaching, request_id='a')
    submit(teaching, request_id='b')
    submit(teaching, request_id='c')
    with pytest.raises(InputError, match='TEACHER_QUEUE_FULL'):
        submit(teaching, request_id='d')
    page1 = page_query(teaching, p['tenant'], limit=2)
    page2 = page_query(teaching, p['tenant'], limit=2, cursor=page1['next_cursor'])
    assert not {s['id'] for s in page1['items']} & {s['id'] for s in page2['items']}
    for name, data in [('a.exe', b'a'), ('../x.txt', b'a'), ('x.txt', b'\xff')]:
        with pytest.raises(InputError):
            teaching.upload(p['tenant'], sid, name, data)
    a = teaching.upload(p['tenant'], sid, '成绩.csv', '姓名,成绩\n样例,90'.encode())
    assert a['name'] == '成绩.csv'


def test_authorization_renewal_does_not_wait_for_allocation(teaching, backend, monkeypatch):
    import threading
    from agent_demo import teaching_worker
    _, eid = submit(teaching)
    allocating, release, checked, stop = (threading.Event() for _ in range(4))
    original_request = teaching.teaching_request
    checks = []

    def authorize(*args, **kwargs):
        checks.append(time.monotonic())
        if allocating.is_set():
            checked.set()
        return original_request(*args, **kwargs)

    def slow_create(attempt):
        allocating.set()
        assert release.wait(5), 'test allocation gate timed out'
        backend.boxes[attempt['id']] = None
        return attempt['id']

    monkeypatch.setattr(teaching, 'teaching_request', authorize)
    monkeypatch.setattr(backend, 'create', slow_create)
    monkeypatch.setattr(teaching_worker, 'Worker', lambda service: Worker(service, backend))
    runner = threading.Thread(target=teaching_worker.run, args=(teaching, stop))
    runner.start()
    try:
        assert allocating.wait(3)
        assert checked.wait(3), 'authorization renewal was blocked by allocation'
        assert len(checks) >= 2
        teaching.cancel(who(teaching)['tenant'], eid)
    finally:
        release.set()
        stop.set()
        runner.join(5)
    assert not runner.is_alive()


def test_simultaneous_claims_respect_four_slots_and_unclean_attempts(teaching,backend):
    from concurrent.futures import ThreadPoolExecutor
    teaching.s.max_active=4
    for index in range(8):
        submit(teaching,who(teaching,'t'+str(index)),str(index))
    with ThreadPoolExecutor(max_workers=8) as pool:
        claimed=list(pool.map(lambda _:Worker(teaching,backend).claim(),range(8)))
    active=[value[0] for value in claimed if value]
    assert len(active)==4 and len({a['id'] for a in active})==4
    first=active[0]
    with teaching.db.tx() as conn:
        ex=row(conn,executions,executions.c.id==first['execution_id'])
    teaching.cancel(ex['tenant'],ex['id'])
    assert Worker(teaching,backend).claim() is None
    with teaching.db.tx() as conn:
        conn.execute(update(attempts).where(attempts.c.id==first['id']).values(poll_until=0))
    Worker(teaching,backend).cleanup(first['id'])
    assert Worker(teaching,backend).claim() is not None


def test_sessions_parallel_but_turns_ordered_and_checkpoint_restored(teaching,backend):
    import base64
    teaching.s.max_active=4;teaching.s.max_teacher_active=2
    principal=who(teaching)
    sid,a=submit(teaching,request_id='first',context={'student_id':'S1'})
    _,followup=submit(teaching,request_id='followup',sid=sid,context={'student_id':'S2'})
    other_sid,b=submit(teaching,request_id='other')
    worker=Worker(teaching,backend)
    first,t1=worker.claim();second,t2=worker.claim()
    assert [first['execution_id'],second['execution_id']]==[a,b]
    worker.start(first,t1);worker.start(second,t2)
    assert worker.claim() is None  # Same session cannot overtake its first turn.
    worker.finish(first['id'],{'ok':True,'answer':'本会话代号蓝帆',
        'files':{'outputs/note.txt':base64.b64encode(b'blue-sail').decode()}})
    worker.cleanup(first['id'])
    third,t3=worker.claim()
    assert third['execution_id']==followup and third['id']!=first['id']
    worker.start(third,t3)
    _,files=backend.specs[third['id']]
    assert files['outputs/note.txt']==b'blue-sail'
    assert '蓝帆' in files['context/briefing.json'].decode()
    assert json.loads(files['context/teaching.json'])['selection']=={'student_id':'S2'}
    assert 'outputs/note.txt' not in backend.specs[second['id']][1]
    teaching.cancel(principal['tenant'],followup)
    worker.cleanup(third['id'])
    assert second['id'] in backend.boxes
    with teaching.db.tx() as conn:
        assert row(conn,executions,executions.c.id==b)['state']=='RUNNING'
        assert row(conn,sessions,sessions.c.id==other_sid)['revision']==0


def test_slow_allocation_does_not_block_another_teacher(teaching,backend,monkeypatch):
    import threading
    from agent_demo import teaching_worker
    _,first=submit(teaching,request_id='first')
    _,second=submit(teaching,who(teaching,'t2'),'second')
    blocked,release,started,stop=(threading.Event() for _ in range(4))
    def create(attempt):
        if attempt['execution_id']==first:
            blocked.set();assert release.wait(8)
        else:
            started.set()
        backend.boxes[attempt['id']]=None
        return attempt['id']
    monkeypatch.setattr(backend,'create',create)
    monkeypatch.setattr(teaching_worker,'Worker',lambda s:Worker(s,backend))
    thread=threading.Thread(target=teaching_worker.run,args=(teaching,stop));thread.start()
    try:
        assert blocked.wait(3)
        assert started.wait(3),'Second teacher was blocked by the first sandbox allocation'
    finally:
        release.set();stop.set();thread.join(8)
    assert not thread.is_alive()


def test_five_open_sessions_close_fences_queue_and_releases_slot(teaching, backend):
    principal=who(teaching)
    ids=[teaching.create_teacher_session(principal,'session-'+str(i))['session_id'] for i in range(5)]
    with pytest.raises(InputError,match='TEACHER_SESSION_LIMIT'):
        teaching.create_teacher_session(principal,'sixth')
    # Same teacher in another course and another teacher have independent limits.
    teaching.create_teacher_session(who(teaching,course='catering'),'independent-course')
    teaching.create_teacher_session(who(teaching,'t2'),'independent-teacher')
    _,eid=submit(teaching,sid=ids[0])
    worker=Worker(teaching,backend);attempt,token=worker.claim();worker.start(attempt,token)
    _,queued=submit(teaching,sid=ids[0],request_id='queued')
    with pytest.raises(KeyError):teaching.close_session(who(teaching,'t2')['tenant'],ids[0])
    teaching.close_session(principal['tenant'],ids[0])
    teaching.close_session(principal['tenant'],ids[0])  # Idempotent.
    with teaching.db.tx() as conn:
        assert row(conn,executions,executions.c.id==eid)['state']=='CANCELLED'
        assert row(conn,executions,executions.c.id==queued)['state']=='CANCELLED'
    with pytest.raises(PermissionError):teaching.reserve_model_request(token)
    with pytest.raises(InputError,match='SESSION_CLOSED'):submit(teaching,sid=ids[0],request_id='late')
    with pytest.raises(InputError,match='SESSION_CLOSED'):teaching.upload(principal['tenant'],ids[0],'x.txt',b'x')
    assert page_query(teaching,principal['tenant'],sid=ids[0])['session']['closed']
    assert len(page_query(teaching,principal['tenant'],sid=ids[0])['items'])==2
    teaching.create_teacher_session(principal,'replacement')


def test_thirty_parallel_slots_across_six_teachers_and_three_pending(teaching,backend):
    from concurrent.futures import ThreadPoolExecutor
    teaching.s.max_active=30;teaching.s.max_teacher_active=5
    worker=Worker(teaching,backend)
    # Interleave submissions and claims so per-teacher queue length never exceeds three.
    claimed=[]
    for round_number in range(5):
        for index in range(6):
            submit(teaching,who(teaching,'teacher-'+str(index)),f'round-{round_number}')
        with ThreadPoolExecutor(max_workers=6) as pool:
            claimed.extend(pool.map(lambda _:worker.claim(),range(6)))
    assert len([a for a in claimed if a])==30
    _,extra=submit(teaching,who(teaching,'overflow'),'overflow')
    assert worker.claim() is None
    teacher=who(teaching,'teacher-0')
    with teaching.db.tx() as conn:
        sid=conn.execute(select(sessions.c.id).where(sessions.c.tenant==teacher['tenant'])).scalar()
    for i in range(3):submit(teaching,teacher,'pending-'+str(i),sid=sid)
    with pytest.raises(InputError,match='TEACHER_QUEUE_FULL'):
        submit(teaching,teacher,'pending-4',sid=sid)


def test_close_endpoint_is_owner_scoped_and_durable(teaching):
    client=TestClient(create_app(teaching.s,teaching))
    principal=who(teaching);sid=teaching.create_teacher_session(principal,'end-test')['session_id']
    path=f'/api/chat/sessions/{sid}/close';body=b'{}'
    def close(teacher):return client.post(path,content=body,headers={
        'X-Teacher-Assertion':signed(teaching,path,body,'POST',teacher=teacher),'Content-Type':'application/json'})
    assert close('t2').status_code==404
    assert close('t1').json()=={'ok':True,'closed':True}
    assert close('t1').status_code==200


def test_fc_capacity_counts_retained_and_allocating_but_not_lost_namespaces(teaching,backend,monkeypatch):
    from types import SimpleNamespace
    from agent_demo.teaching import session_lifecycle
    from agent_demo import providers
    teaching.s.provider='fc-internal';teaching.s.max_sandboxes=1
    teaching.runtime=SimpleNamespace(watching=lambda _:True)
    retained=set()
    monkeypatch.setattr(providers,'provider',lambda _:SimpleNamespace(
        has_capacity=lambda sid:sid in retained or len(retained)<1,
        retained_sessions=lambda:set(retained)))
    old=teaching.create_teacher_session(who(teaching,'old'),'old')['session_id']
    with teaching.db.tx() as conn:
        conn.execute(update(session_lifecycle).where(session_lifecycle.c.session_id==old)
                     .values(sandbox_expires=time.time()+28800))
    _,first=submit(teaching,who(teaching,'new'),'new')
    retained.add(old)
    worker=Worker(teaching,backend)
    assert worker.claim() is None
    retained.clear()  # FC restart/resource failure reclaimed the old namespace.
    assert worker.claim()[0]['execution_id']==first
    submit(teaching,who(teaching,'another'),'another')
    assert worker.claim() is None  # Allocation reserves a slot before create().
