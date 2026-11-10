"""Stage a minimal ECS Agent release, then activate with backup and rollback.

The privileged controller is a separate, capability-limited service. The public
website remains User=teaching. Run activation only after reviewing that boundary.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import time
import urllib.request

CURRENT = Path('/opt/shixunlab/current')
NODE = '/opt/node-v24.10.0-linux-x64/bin/node'


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def environments(live, release):
    if not live.get('DEEPSEEK_API_KEY'):
        raise ValueError('The existing model credential is required')
    shared = {name: secrets.token_hex(32) for name in
              ['AGENT_SIGNING_KEY', 'AGENT_TOOL_VERIFY_KEY', 'AGENT_PERSISTENCE_KEY']}
    deployment = live.get('TEACHING_DEPLOYMENT_ID', 'cc_dify_mcp-hangzhou')
    web = {**shared, 'ENABLE_TEACHER_CHAT': '1', 'TEACHER_AGENT_MODE': 'ecs-external',
           'OSS_SINGLE_WRITER': '1', 'TEACHING_DEPLOYMENT_ID': deployment}
    root = release/'services/teacher-agent'
    control = {
        'PATH': '/opt/node-v24.10.0-linux-x64/bin:/usr/bin:/bin',
        'PYTHONPATH': str(root/'python311')+':'+str(root),
        'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUNBUFFERED': '1',
        'DATA_DIR': '/var/lib/shixunlab-agent',
        'DATABASE_URL': 'sqlite:////var/lib/shixunlab-agent/agent.sqlite',
        'SANDBOX_PROVIDER': 'fc-internal', 'BLOB_BACKEND': 'fc-oss',
        'MAX_ACTIVE_EXECUTIONS': '1', 'MAX_TEACHER_ACTIVE': '1',
        'MAX_TEACHER_SESSIONS': '5', 'MAX_TEACHER_PENDING': '3',
        'MAX_RETAINED_SANDBOXES': '1', 'SANDBOX_LIFETIME_SECONDS': '28800',
        'SANDBOX_CONTROL_RESERVE_MIB': '256',
        'CODEX_SANDBOX_MODE': 'danger-full-access', 'ALLOW_EXTERNAL_SANDBOX': 'true',
        'TEACHING_MODE': '1', 'TEACHING_ENV': 'production',
        'TEACHING_BASE_URL': 'http://127.0.0.1:9000', 'TEACHING_DEPLOYMENT_ID': deployment,
        'TEACHING_VERIFY_KEY': shared['AGENT_SIGNING_KEY'],
        'TEACHING_TOOL_SIGNING_KEY': shared['AGENT_TOOL_VERIFY_KEY'],
        'AGENT_PERSISTENCE_KEY': shared['AGENT_PERSISTENCE_KEY'],
        'CAPABILITY_REGISTRY': str(root/'config/capabilities.json'),
        'BRIDGE_DIR': str(root/'bridge'), 'BRIDGE_SIGNING_KEY': secrets.token_hex(32),
        'BRIDGE_URL': 'http://127.0.0.1:9183', 'GATEWAY_URL': 'http://127.0.0.1:9181',
        'MODEL': live.get('TEACHER_AGENT_MODEL', 'deepseek-flash'),
        'MODEL_REASONING_EFFORT': live.get('TEACHER_AGENT_REASONING_EFFORT', 'low'),
        'ATTEMPT_SECONDS': '180', 'DEEPSEEK_API_KEY': live['DEEPSEEK_API_KEY'],
    }
    return web, control


def write_env(path, values):
    for value in values.values():
        if any(c in value for c in '\n\r\0'):
            raise ValueError('Invalid environment value')
    path.write_text(''.join(key+'='+json.dumps(value)+'\n' for key, value in values.items()))
    path.chmod(0o600)


def copy_release(source, destination):
    # Preserve native runtimes and symlinks, exclude host filesystem sidecars.
    shutil.copytree(source, destination, symlinks=True,
        ignore=shutil.ignore_patterns('._*', '.DS_Store', '__MACOSX', '__pycache__', '*.pyc', '*.pyo'))


def stage(source, release):
    manifest = json.loads((source/'manifest.json').read_text())
    for name, digest in manifest['base'].items():
        if hashlib.sha256((CURRENT/name).read_bytes()).hexdigest() != digest:
            raise ValueError('Live source changed: '+name)
    for name, digest in manifest['files'].items():
        if hashlib.sha256((source/name).read_bytes()).hexdigest() != digest:
            raise ValueError('Upload integrity failed: '+name)
    if release.exists():
        raise ValueError('Release already exists; choose a fresh path')
    copy_release(CURRENT.resolve(), release)
    for name in manifest['files']:
        target = release/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source/name, target)
        target.chmod(0o644)
    agent = release/'services/teacher-agent'
    # These directories contain only packaged source/runtime assets, never app.env.
    for directory, dirs, files in os.walk(agent):
        Path(directory).chmod(0o755)
        if (agent/'sandbox_runtime') in [Path(directory), *Path(directory).parents]:
            for name in files:
                (Path(directory)/name).chmod(0o644)
    if not (agent/'bin').exists():
        (agent/'bin').symlink_to('../../bin', target_is_directory=True)
    for name in ['bwrap', 'codex', 'rg']:
        if not (agent/'bin'/name).is_file():
            raise ValueError('Missing sandbox executable: '+name)
    with (release/'agent-dependency-install.log').open('w') as log:
        run('/usr/bin/python3.11', '-m', 'pip', 'install', '--only-binary=:all:',
            '--index-url', 'https://pypi.org/simple', '--target', str(agent/'python311'),
            '-r', str(release/'deploy/teacher-agent-ecs-requirements.txt'), stdout=log, stderr=log)
    for directory, _, files in os.walk(agent/'python311'):
        Path(directory).chmod(0o755)
        for name in files:
            (Path(directory)/name).chmod(0o644)
    for name in ['server.cjs', 'agent/chat-gateway.cjs', 'agent/runtime-config.cjs']:
        run(NODE, '--check', str(release/name))
    env = {**os.environ, 'PYTHONPATH': str(agent/'python311')+':'+str(agent), 'PYTHONDONTWRITEBYTECODE': '1'}
    run('/usr/bin/python3.11', '-c',
        'import agent_demo.fc_main,fastapi,sqlalchemy; print("ECS_AGENT_IMPORTS_OK")', env=env)
    print('ECS_AGENT_STAGED', release)


def switch(release):
    temporary = CURRENT.with_name('current.agent-next')
    temporary.symlink_to(release, target_is_directory=True)
    temporary.replace(CURRENT)


def activate(release):
    if not (release/'agent/runtime-config.cjs').is_file():
        raise ValueError('Run staging first')
    unit = Path('/etc/systemd/system/shixunlab-agent.service')
    dropin = Path('/etc/systemd/system/shixunlab.service.d/zz-agent-external.conf')
    if unit.exists() or dropin.exists():
        raise ValueError('Existing external controller needs an explicit upgrade plan')
    run('systemctl', 'start', 'shixunlab-backup.service')
    pid = subprocess.check_output(['systemctl', 'show', 'shixunlab', '-p', 'MainPID', '--value']).decode().strip()
    live = dict(item.decode().split('=', 1) for item in Path('/proc/'+pid+'/environ').read_bytes().split(b'\0') if b'=' in item)
    old = CURRENT.resolve()
    backup = Path('/var/backups/shixunlab-agent')/(release.name+'-'+secrets.token_hex(4))
    backup.mkdir(parents=True, mode=0o700)
    shutil.copytree('/etc/shixunlab', backup/'config')
    shutil.copytree('/etc/systemd/system/shixunlab.service.d', backup/'web-dropins')
    (backup/'previous-release').write_text(str(old))
    web, control = environments(live, release)
    write_env(Path('/etc/shixunlab/agent-web.env'), web)
    write_env(Path('/etc/shixunlab/agent-control.env'), control)
    Path('/var/lib/shixunlab-agent').mkdir(mode=0o700, exist_ok=True)
    shutil.copyfile(release/'deploy/ecs-teacher-agent.service', unit)
    dropin.write_text('[Unit]\nWants=shixunlab-agent.service\n[Service]\n'
                      'EnvironmentFile=/etc/shixunlab/agent-web.env\n'
                      'UnsetEnvironment=DEEPSEEK_API_KEY\nMemoryMax=768M\n')
    try:
        run('systemctl', 'daemon-reload')
        run('systemd-analyze', 'verify', str(unit), '/etc/systemd/system/shixunlab.service')
        switch(release)
        run('systemctl', 'restart', 'shixunlab')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(90):
            try:
                with opener.open('http://127.0.0.1:9000/healthz', timeout=3) as response:
                    health = json.load(response)
                if health.get('ok') and health.get('agent'):
                    print('ECS_AGENT_DEPLOYED', release, json.dumps(health))
                    return
            except OSError:
                pass
            time.sleep(1)
        raise RuntimeError('Agent did not become healthy')
    except BaseException:
        subprocess.run(['systemctl', 'stop', 'shixunlab-agent'], check=False)
        unit.replace(backup/'failed-agent.service')
        dropin.replace(backup/'failed-web-dropin.conf')
        switch(old)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'restart', 'shixunlab')
        print('ROLLED_BACK_TO', old)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['stage', 'activate'])
    parser.add_argument('release', type=Path)
    parser.add_argument('--source', type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0 or args.release.parent != Path('/opt/shixunlab/releases'):
        raise SystemExit('Requires root and an isolated /opt/shixunlab/releases/<name>')
    if args.action == 'stage':
        if not args.source:
            parser.error('--source required for staging')
        stage(args.source, args.release)
    else:
        activate(args.release)
