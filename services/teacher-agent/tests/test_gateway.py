import json
import hashlib
import hmac
import httpx
from sqlalchemy import select
from agent_demo.gateway import Gateway, RedactedDelta, sse_events
from agent_demo.db import events
from agent_demo.worker import Worker


def gateway(service,principal,backend,handler):
    sid=service.create_session('a')['session_id']
    eid=service.submit(principal,sid,'one','hello',[],[],'default')
    a,t=Worker(service,backend).claim()
    factory=lambda **kw: httpx.Client(transport=httpx.MockTransport(handler),**kw)
    return Gateway(service,factory),a,t,eid


def test_forward_signature_and_actual_http_status(service,principal,backend):
    def handler(req):
        body=json.loads(req.content)
        assert body['model']==service.s.model and body['max_output_tokens']==8192
        scope=req.headers['x-exp-conversation-id']
        signed=hmac.new(service.s.bridge_secret.encode(),('expserver-codex:'+scope).encode(),hashlib.sha256).hexdigest()
        assert req.headers['authorization']=='Bearer '+signed
        assert service.s.deepseek_key not in str(req.headers)
        return httpx.Response(429,json={'error':{'message':service.s.deepseek_key}})
    g,_,t,_=gateway(service,principal,backend,handler)
    code,value,it=g.open(t,{'input':'hello','max_output_tokens':100000})
    assert code==429 and it is None and service.s.deepseek_key not in json.dumps(value)


def test_stream_only_public_text_and_interruption(service,principal,backend):
    items=[{'type':'response.reasoning_text.delta','delta':'private reasoning'},
           {'type':'response.output_text.delta','delta':'hello'},
           {'type':'response.completed','response':{'status':'completed','output':[]}}]
    handler=lambda req:httpx.Response(200,content=''.join('data: '+json.dumps(x)+'\r\n\r\n' for x in items))
    g,_,t,eid=gateway(service,principal,backend,handler)
    _,_,it=g.open(t,{'input':'hello','stream':True})
    assert b'response.completed' in b''.join(it)
    with service.db.tx() as c:
        values=list(c.execute(select(events.c.payload).where(events.c.type=='assistant.delta')).scalars())
    assert ''.join(x['text'] for x in values)=='hello'
    assert 'private reasoning' not in json.dumps(values)


def test_truncated_stream_never_completes(service,principal,backend):
    handler=lambda req:httpx.Response(200,content='data: {"type":"response.created"}\n\n')
    g,_,t,_=gateway(service,principal,backend,handler)
    _,_,it=g.open(t,{'input':'hello','stream':True})
    value=b''.join(it)
    assert b'UPSTREAM_STREAM_INTERRUPTED' in value and b'response.completed' not in value


def test_secret_split_at_every_boundary():
    secret='sensitive-unique-credential'
    for at in range(len(secret)+1):
        b=RedactedDelta([secret])
        result=b.feed('prefix '+secret[:at])+b.feed(secret[at:]+' suffix')+b.feed('',final=True)
        assert result=='prefix [REDACTED] suffix'


def test_regular_text_is_forwarded_without_key_length_delay():
    b=RedactedDelta(['a-long-secret-key', 'another-secret'])
    assert b.feed('老师好！')=='老师好！'
    assert b.feed('a-long-')==''
    assert b.feed('secret-key。')=='[REDACTED]。'


def test_overlapping_secret_prefixes_and_unicode_chunks():
    b=RedactedDelta(['abcde', 'abcdefghi'])
    text='前文abcde后文'
    assert ''.join(b.feed(char) for char in text)+b.feed('',final=True)=='前文[REDACTED]后文'
