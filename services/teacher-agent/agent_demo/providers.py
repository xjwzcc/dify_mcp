"""Real isolated backends. There is deliberately no local subprocess execution backend."""
import base64
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import tempfile

from .storage import InputError


def encoded_spec(spec, files):
    return json.dumps({**spec, "files": {k: base64.b64encode(v).decode() for k, v in files.items()}}).encode()


def docker(*args, check=True):
    process = subprocess.run(["docker", *args], capture_output=True, timeout=30)
    if check and process.returncode:
        # Docker stderr can include user file names; no environment or key material is logged.
        raise RuntimeError("DOCKER_COMMAND_FAILED:" + args[0])
    return process


class DockerProvider:
    def __init__(self, settings):
        self.s = settings
        self.control = os.getenv("CONTROL_CONTAINER", "agent-demo-control")

    def name(self, attempt_id):
        if len(attempt_id) != 32 or any(c not in "0123456789abcdef" for c in attempt_id):
            raise ValueError("Invalid attempt")
        return "agent-demo-" + attempt_id

    def find(self, attempt_id):
        name = self.name(attempt_id)
        result = docker("container", "inspect", name, check=False)
        return name if result.returncode == 0 else None

    def create(self, attempt):
        name = self.name(attempt["id"])
        # Per-attempt network: sandbox peers never share a network.
        docker("network", "create", "--internal", "--label", "agent-demo=true", name)
        docker("network", "connect", "--alias", "control", name, self.control)
        docker("create", "--name", name, "--label", "agent-demo=true",
               "--label", "attempt=" + attempt["id"], "--network", name,
               "--read-only", "--user", "10001:10001", "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges:true", "--pids-limit", "128",
               "--memory", "4g", "--cpus", "2", "--ulimit", "nofile=1024:1024",
               "--tmpfs", "/runs:rw,nosuid,nodev,size=512m,mode=1777",
               "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
               "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=1",
               self.s.image)
        docker("start", name)
        return name

    def start(self, sandbox_id, spec, files):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "spec.json"
            path.write_bytes(encoded_spec(spec, files))
            path.chmod(0o644)
            docker("cp", str(path), sandbox_id + ":/runs/spec.pending")
            # docker cp creates root-owned files; /runs is a sticky tmpfs.
            docker("exec", "--user", "0", sandbox_id, "chown", "10001:10001", "/runs/spec.pending")
            docker("exec", sandbox_id, "mv", "/runs/spec.pending", "/runs/spec.json")

    def inspect(self, sandbox_id):
        value = json.loads(docker("inspect", sandbox_id).stdout)[0]
        with tempfile.TemporaryDirectory() as directory:
            result = docker("cp", sandbox_id + ":/runs/result.json", directory + "/result.json", check=False)
            if result.returncode:
                if value["State"]["Running"]:
                    return None
                raise RuntimeError("SANDBOX_EXIT_WITHOUT_RESULT")
            raw = (Path(directory) / "result.json").read_bytes()
            if len(raw) > 24_000_000:
                raise InputError("RESULT_LIMIT")
            return json.loads(raw)

    def destroy(self, attempt):
        name = self.name(attempt["id"])
        result = docker("container", "inspect", name, check=False)
        if result.returncode == 0:
            docker("rm", "-f", name)
        network = docker("network", "inspect", name, check=False)
        if network.returncode == 0:
            docker("network", "disconnect", "-f", name, self.control, check=False)
            docker("network", "rm", name)


class FcProvider:
    """E2B SDK 2.31.0 adapter for Aliyun FC Agent Sandbox."""
    def __init__(self, settings):
        self.s = settings
        if not settings.fc_template or not settings.fc_api_key or not settings.fc_api_url or not settings.fc_domain:
            raise ValueError("FC_TEMPLATE and E2B connection settings are required")
        if not settings.fc_network_verified or not settings.fc_egress_cidrs:
            raise ValueError("FC requires explicit, acceptance-tested egress policy")
        for cidr in settings.fc_egress_cidrs:
            network = ipaddress.ip_network(cidr, strict=False)
            blocked = ["169.254.0.0/16", "100.100.100.200/32"] if network.version == 4 else ["fe80::/10"]
            if network.prefixlen == 0 or any(network.overlaps(ipaddress.ip_network(x)) for x in blocked):
                raise ValueError("Broad or metadata egress is forbidden")
        from e2b import Sandbox
        self.sdk = Sandbox
        self.opts = dict(api_key=settings.fc_api_key, api_url=settings.fc_api_url,
                         domain=settings.fc_domain, request_timeout=20)

    def connect(self, sandbox_id):
        return self.sdk.connect(sandbox_id, **self.opts)

    def find(self, attempt_id):
        from e2b.sandbox.sandbox_api import SandboxQuery
        pages = self.sdk.list(query=SandboxQuery(metadata={"agent_demo_attempt": attempt_id}), **self.opts)
        ids = []
        while pages.has_next:
            ids.extend(s.sandbox_id for s in pages.next_items())
        if len(ids) > 1:
            raise RuntimeError("DUPLICATE_SANDBOX_ALLOCATION")
        return ids[0] if ids else None

    def create(self, attempt):
        box = self.sdk.create(template=self.s.fc_template,
            timeout=self.s.attempt_seconds + 120,
            metadata={"agent_demo_attempt": attempt["id"]},
            secure=True,
            network={"allow_out": self.s.fc_egress_cidrs, "allow_public_traffic": False},
            **self.opts)
        return box.sandbox_id

    def start(self, sandbox_id, spec, files):
        box = self.connect(sandbox_id)
        box.files.write("/runs/spec.pending", encoded_spec(spec, files), user="agent")
        box.commands.run("mv /runs/spec.pending /runs/spec.json", user="agent", timeout=10)
        box.commands.run("python3 /opt/runner/main.py", user="agent", background=True,
                         timeout=self.s.attempt_seconds + 60)

    def inspect(self, sandbox_id):
        from e2b.exceptions import NotFoundException
        box = self.connect(sandbox_id)
        try:
            raw = box.files.read("/runs/result.json", format="bytes", user="agent")
        except NotFoundException:
            return None
        if len(raw) > 24_000_000:
            raise InputError("RESULT_LIMIT")
        return json.loads(raw)

    def destroy(self, attempt):
        sandbox_id = attempt.get("sandbox_id") or self.find(attempt["id"])
        if sandbox_id:
            from e2b.exceptions import NotFoundException
            try:
                self.sdk.kill(sandbox_id, **self.opts)
            except NotFoundException:
                pass


def provider(settings):
    if settings.provider == 'fc-internal':
        from .internal_sandbox import InternalProvider
        return InternalProvider(settings)
    return DockerProvider(settings) if settings.provider == "docker" else FcProvider(settings)
