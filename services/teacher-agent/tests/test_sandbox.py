import base64
import importlib.util
from pathlib import Path
import os
import pytest
from agent_demo.providers import DockerProvider, FcProvider
from agent_demo.storage import safe_path,InputError


def test_docker_has_outer_isolation_and_no_credentials(service,monkeypatch):
    calls=[]
    monkeypatch.setattr('agent_demo.providers.docker',lambda *a,**k:calls.append(a))
    p=DockerProvider(service.s)
    p.create({'id':'a'*32})
    command=next(c for c in calls if c[0]=='create')
    assert '--read-only' in command and '--cap-drop' in command and '--memory' in command
    assert '--user' in command and '--pids-limit' in command
    assert not any('sock' in x or service.s.deepseek_key in x for x in command)
    assert calls[0][:3]==('network','create','--internal')
    with pytest.raises(ValueError): p.name('../../escape')


def test_fc_fails_closed_without_network_policy(service):
    service.s.fc_template='test'
    service.s.fc_api_key='test'
    service.s.fc_api_url='https://example.invalid'
    service.s.fc_domain='example.invalid'
    with pytest.raises(ValueError,match='egress'): FcProvider(service.s)
    service.s.fc_network_verified=True
    for cidr in ['0.0.0.0/0','169.254.0.0/16','100.100.100.200/32','::/0']:
        service.s.fc_egress_cidrs=[cidr]
        with pytest.raises(ValueError): FcProvider(service.s)


def test_export_skips_links_and_configuration(tmp_path,monkeypatch):
    path=Path(__file__).parents[1]/'sandbox_runtime/main.py'
    spec=importlib.util.spec_from_file_location('runner',path)
    runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
    work=tmp_path/'workspace';work.mkdir()
    monkeypatch.setattr(runner,'WORK',work)
    (work/'out.txt').write_bytes(b'good')
    (tmp_path/'secret').write_text('secret')
    (work/'link').symlink_to(tmp_path/'secret')
    os.link(tmp_path/'secret',work/'hardlink')
    (work/'.codex').mkdir();(work/'.codex/config.toml').write_text('bad')
    (work/'AGENTS.md').write_text('bad')
    assert runner.collect()=={'out.txt':base64.b64encode(b'good').decode()}
    for value in ['../x','/etc/passwd','a/../x','.codex/config.toml','AGENTS.md','x\\y']:
        with pytest.raises(InputError):safe_path(value)


def test_docker_stage_chowns_sticky_tmpfs_file(service,monkeypatch):
    calls=[]
    monkeypatch.setattr('agent_demo.providers.docker',lambda *a,**k:calls.append(a))
    DockerProvider(service.s).start('box',{'token':'temporary'},{'a.txt':b'hello'})
    assert calls[0][0]=='cp'
    assert calls[1]==('exec','--user','0','box','chown','10001:10001','/runs/spec.pending')
    assert calls[2]==('exec','box','mv','/runs/spec.pending','/runs/spec.json')
