"""Actual reused Node HTTP/SSE Bridge against a credential-free fake provider."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import hashlib
import hmac
import json
import os
import shutil
import socket
from contextlib import contextmanager
import httpx
import pytest
from agent_demo.bridge import managed_bridge


@contextmanager
def upstream(tool_turn=False):
    seen=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_POST(self):
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            seen.append((self.path,dict(self.headers),body))
            if self.path == '/internal/tools':
                value={'tools':[{'name':'current_time','description':'Return a fixed test clock',
                    'inputSchema':{'type':'object','properties':{},'additionalProperties':False}}]} if body['method']=='tools/list' else {'content':[{'type':'text','text':'2026-01-01T00:00:00Z'}]}
                self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
                self.wfile.write(json.dumps(value).encode());return
            text=json.dumps(body.get('input'))
            if 'status-error' in text:
                self.send_response(429);self.end_headers();self.wfile.write(b'{"error":{"message":"rate limit"}}');return
            response={'id':'resp_test','object':'response','status':'completed','model':body['model'],
                      'output':[{'type':'message','id':'msg_1','role':'assistant','status':'completed',
                                 'content':[{'type':'output_text','text':'hello','annotations':[]}]}],
                      'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}
            call_tool=tool_turn and not any(x.get('type')=='function_call_output' for x in body.get('input',[]))
            if call_tool:
                name=next(t['name'] for t in body['tools'] if 'current_time' in t.get('name',''))
                response['output']=[{'type':'function_call','id':'fc_1','call_id':'clock_call','name':name,'arguments':'{}','status':'completed'}]
            self.send_response(200)
            if body.get('stream'):
                self.send_header('Content-Type','text/event-stream');self.end_headers()
                values=[{'type':'response.created','response':{**response,'status':'in_progress','output':[]}},
                        {'type':'response.output_item.added','output_index':0,'item':{**response['output'][0],'status':'in_progress','content':[]}},
                        {'type':'response.content_part.added','item_id':'msg_1','output_index':0,'content_index':0,'part':{'type':'output_text','text':'','annotations':[]}},
                        {'type':'response.output_text.delta','item_id':'msg_1','output_index':0,'content_index':0,'delta':'hello'}]
                if call_tool:
                    values=[{'type':'response.created','response':{**response,'status':'in_progress','output':[]}},
                            {'type':'response.output_item.added','output_index':0,'item':{**response['output'][0],'arguments':''}},
                            {'type':'response.function_call_arguments.delta','item_id':'fc_1','output_index':0,'delta':'{}'},
                            {'type':'response.output_item.done','output_index':0,'item':response['output'][0]},
                            {'type':'response.completed','response':response}]
                elif 'truncate' not in text:
                    values.extend([{'type':'response.output_text.done','item_id':'msg_1','output_index':0,'content_index':0,'text':'hello'},
                                   {'type':'response.content_part.done','item_id':'msg_1','output_index':0,'content_index':0,'part':response['output'][0]['content'][0]},
                                   {'type':'response.output_item.done','output_index':0,'item':response['output'][0]}])
                    terminal='response.incomplete' if 'incomplete-case' in text else 'response.completed'
                    values.append({'type':terminal,'response':{**response,'status':terminal.split('.')[1]}})
                for i,event in enumerate(values):
                    event['sequence_number']=i
                    self.wfile.write(('event: '+event['type']+'\r\ndata: '+json.dumps(event)+'\r\n\r\n').encode())
                    self.wfile.flush()
            else:
                self.send_header('Content-Type','application/json');self.end_headers()
                self.wfile.write(json.dumps(response).encode())
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=Thread(target=server.serve_forever,daemon=True);thread.start()
    try: yield 'http://127.0.0.1:'+str(server.server_port),seen
    finally: server.shutdown();server.server_close();thread.join()


def credentials(secret,scope):
    return {'x-exp-conversation-id':scope,'Authorization':'Bearer '+hmac.new(secret.encode(),
            ('expserver-codex:'+scope).encode(),hashlib.sha256).hexdigest()}


def test_reused_bridge_real_http_sse_and_scope(service):
    if not shutil.which('node'):
        pytest.skip('Node 22 required')
    with socket.socket() as port:
        port.bind(('127.0.0.1',0)); bridge_port=port.getsockname()[1]
    with upstream() as (url,seen):
        service.s.deepseek_url=url
        service.s.bridge_url='http://127.0.0.1:'+str(bridge_port)
        with managed_bridge(service.s), httpx.Client(base_url=service.s.bridge_url,trust_env=False,timeout=10) as c:
            headers=credentials(service.s.bridge_secret,'a'*32)
            assert c.post('/v1/responses',json={'input':'hi'}).status_code==401
            response=c.post('/v1/responses',headers=headers,json={'input':[{'role':'developer','content':'trusted rules'},
                {'role':'user','content':'hello'}], 'tools':[{'type':'function','name':'clock','parameters':{'type':'object'}}]})
            assert response.status_code==200 and response.json()['status']=='completed'
            path,auth,body=seen[-1]
            assert path=='/responses' and auth['authorization']=='Bearer '+service.s.deepseek_key
            assert 'extra' not in body and body['input'][0]['role']=='system'
            assert body['tools'][0]['name']=='clock'
            assert c.get('/v1/responses/resp_test',headers=credentials(service.s.bridge_secret,'b'*32)).status_code==404
            response=c.post('/v1/responses',headers=headers,json={'input':'status-error'})
            assert response.status_code==429
            complete=c.post('/v1/responses',headers=headers,json={'input':'hello','stream':True})
            assert 'response.completed' in complete.text
            truncated=c.post('/v1/responses',headers=headers,json={'input':'truncate','stream':True})
            assert 'response.completed' not in truncated.text and 'upstream_error' in truncated.text
            incomplete=c.post('/v1/responses',headers=headers,json={'input':'incomplete-case','stream':True})
            assert 'response.incomplete' in incomplete.text and 'response.completed' not in incomplete.text
            assert c.post('/v1/responses/compact',headers=headers,json={}).status_code==400
