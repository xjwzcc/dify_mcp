"""Real pinned Codex CLI + real Bridge; only deterministic model text, no shell tool call."""
import json
import os
from pathlib import Path
import socket
import subprocess
import pytest
from agent_demo.bridge import managed_bridge
from test_bridge import upstream, credentials


@pytest.mark.parametrize("tool_turn", [False, True])
def test_pinned_cli_model_catalog_and_responses(service,tmp_path,tool_turn):
    root=Path(__file__).parents[1]
    cli=root/'sandbox_runtime/node_modules/.bin/codex'
    if not cli.exists():pytest.skip('Install pinned sandbox_runtime npm dependencies')
    home=tmp_path/'codex-home';home.mkdir()
    workspace=tmp_path/'workspace';workspace.mkdir()
    with socket.socket() as port:
        port.bind(('127.0.0.1',0));bridge_port=port.getsockname()[1]
    service.s.bridge_url='http://127.0.0.1:'+str(bridge_port)
    with upstream(tool_turn) as (url,seen):
        service.s.deepseek_url=url
        headers=credentials(service.s.bridge_secret,'a'*32)
        q=json.dumps
        config='\n'.join([
            'model_provider = "gateway"', 'model = "deepseek-flash"',
            'approval_policy = "never"','web_search = "disabled"', 'project_doc_max_bytes = 0',
            'model_catalog_json = '+q(str(root/'sandbox_runtime/models.json')),
            '[model_providers.gateway]','name = "Test Gateway"',
            'wire_api = "responses"','requires_openai_auth = false','env_key = "TEST_TOKEN"',
            'base_url = '+q(service.s.bridge_url+'/v1'),
            '[model_providers.gateway.http_headers]','x-exp-conversation-id = "'+'a'*32+'"'])
        if tool_turn:
            config+='\n[mcp_servers.business]\ncommand = '+q(str(root/'.venv/bin/python'))+'\nargs = ['+q(str(root/'sandbox_runtime/mcp.py'))+']\n[mcp_servers.business.env]\nATTEMPT_TOKEN = "test-token"\nGATEWAY_URL = '+q(url)+'\n'
        if tool_turn:
            config+='\n[mcp_servers.business.tools.current_time]\napproval_mode = \"approve\"\n'
        (home/'config.toml').write_text(config)
        env={'PATH':os.environ['PATH'],'HOME':str(home),'CODEX_HOME':str(home),
             'TMPDIR':str(tmp_path),'TEST_TOKEN':headers['Authorization'][7:]}
        with managed_bridge(service.s):
            result=subprocess.run([str(cli),'exec','--json','--skip-git-repo-check','--sandbox','read-only',
                '-C',str(workspace),'-o',str(tmp_path/'answer'),'-'],input='Say hello',text=True,
                capture_output=True,env=env,timeout=35)
        assert result.returncode==0,(result.stdout,result.stderr)
        assert seen
        if tool_turn:
            calls=[x[2] for x in seen if x[0]=='/internal/tools' and x[2].get('method')=='tools/call']
            assert len(calls)==1 and calls[0]['params']['name']=='current_time', (result.stdout, result.stderr, [x[2].get('input',[]) [-2:] for x in seen if x[0]=='/responses'])
        assert '"type":"turn.completed"' in result.stdout
        assert (tmp_path/'answer').read_text().strip()=='hello'
