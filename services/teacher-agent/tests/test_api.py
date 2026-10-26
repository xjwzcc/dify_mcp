from fastapi.testclient import TestClient
from agent_demo.api import create_app


def test_auth_idempotence_attachments_and_sse_replay(service):
    with TestClient(create_app(service.s,service)) as c:
        assert c.post('/api/chat/sessions').status_code==403
        c.headers['Authorization']='Bearer '+'a'*32
        sid=c.post('/api/chat/sessions').json()['session_id']
        upload=c.post(f'/api/chat/sessions/{sid}/attachments?name=data.csv',content=b'a,b\n1,2')
        assert upload.status_code==200
        body={'request_id':'same','message':'hello','attachment_ids':[upload.json()['artifact_id']]}
        url=f'/api/chat/sessions/{sid}/messages'
        eid=c.post(url,json=body).json()['execution_id']
        assert c.post(url,json=body).json()['execution_id']==eid
        assert c.post(f'/api/chat/executions/{eid}/cancel').status_code==200
        stream=c.get(f'/api/chat/executions/{eid}/events?after=1')
        assert stream.status_code==200 and 'turn.cancelled' in stream.text and 'turn.queued' not in stream.text
        c.headers['Authorization']='Bearer '+'b'*32
        assert c.get(f'/api/chat/executions/{eid}').status_code==404
        assert c.get('/api/chat/artifacts/'+upload.json()['artifact_id']+'/download').status_code==404


def test_input_path_and_body_limits(service):
    service.s.max_file_bytes=2
    service.s.max_input_bytes=2
    with TestClient(create_app(service.s,service)) as c:
        c.headers['Authorization']='Bearer '+'a'*32
        sid=c.post('/api/chat/sessions').json()['session_id']
        assert c.post(f'/api/chat/sessions/{sid}/attachments?name=../escape',content=b'x').status_code==400
        assert c.post(f'/api/chat/sessions/{sid}/attachments?name=ok',content=b'xxx').status_code==400
        assert c.post('/api/chat/sessions',content=b'x'*65000).status_code==413
