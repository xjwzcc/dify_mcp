"""Local contract integration, with real CLI/MCP/Gateway/Bridge and a scripted model.
This does not test container or cloud isolation and never requests shell execution.
"""
import base64
import importlib.util
from pathlib import Path
import os
import socket
from threading import Thread
import time
import httpx
import uvicorn
from sqlalchemy import select
from agent_demo.api import create_app
from agent_demo.bridge import managed_bridge
from agent_demo.worker import Worker
from agent_demo.db import executions,events,row
from test_bridge import upstream


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0));return s.getsockname()[1]


def test_real_runner_mcp_gateway_commit(service,principal,backend,tmp_path,monkeypatch):
    service.s.reasoning_effort='low'
    root=Path(__file__).parents[1]
    module=importlib.util.spec_from_file_location('integration_runner',root/'sandbox_runtime/main.py')
    runner=importlib.util.module_from_spec(module);module.loader.exec_module(runner)
    monkeypatch.setattr(runner,'ROOT',tmp_path/'run')
    monkeypatch.setattr(runner,'WORK',tmp_path/'run/workspace')
    monkeypatch.setenv('PATH',str(root/'sandbox_runtime/node_modules/.bin')+os.pathsep+os.environ['PATH'])
    service.s.bridge_url='http://127.0.0.1:'+str(free_port())
    port=free_port();service.s.gateway_url='http://127.0.0.1:'+str(port)
    app=create_app(service.s,service)
    server=uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=port,log_level='error',access_log=False))
    thread=Thread(target=server.run,daemon=True)
    with upstream(tool_turn=True) as (url,seen):
        service.s.deepseek_url=url
        with managed_bridge(service.s):
            thread.start()
            try:
                for _ in range(100):
                    if server.started:break
                    time.sleep(.05)
                assert server.started
                sid=service.create_session('a')['session_id']
                eid=service.submit(principal,sid,'real-cli','Check current time then say hello',[],[],'default')
                worker=Worker(service,backend)
                attempt,token=worker.claim();worker.start(attempt,token)
                spec,files=backend.specs[attempt['id']]
                spec={**spec,'sandbox_mode':'read-only','seconds':30,
                      'files':{n:base64.b64encode(v).decode() for n,v in files.items()}}
                result=runner.run(spec)
                assert result['ok'] and result['answer'].strip()=='hello'
                worker.finish(attempt['id'],result)
                with service.db.tx() as c:
                    assert row(c,executions,executions.c.id==eid)['state']=='COMMITTED'
                    types=list(c.execute(select(events.c.type).where(events.c.execution_id==eid)).scalars())
                    assert 'tool.completed' in types and 'assistant.delta' in types
                assert any(any(i.get('type')=='function_call_output' for i in body.get('input',[]))
                           for _,_,body in seen)
                assert seen and all(body.get('reasoning',{}).get('effort')=='low' for _,_,body in seen)
            finally:
                server.should_exit=True;thread.join(timeout=10)
