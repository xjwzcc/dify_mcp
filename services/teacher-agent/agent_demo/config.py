from dataclasses import dataclass, field
from pathlib import Path
import hashlib
import json
import os


@dataclass
class Settings:
    database_url: str = "sqlite:///data/agent.db"
    data_dir: Path = Path("data")
    api_keys: dict = field(default_factory=dict)
    provider: str = "docker"
    model: str = "deepseek-flash"
    reasoning_effort: str = "high"
    deepseek_url: str = "https://api.deepseek.com"
    deepseek_key: str = ""
    gateway_url: str = "http://control:8080"
    image: str = "agent-demo-runner:0.1.0"
    docker_network: str = "agent-demo-exec"
    fc_template: str = ""
    fc_api_key: str = ""
    fc_api_url: str = ""
    fc_domain: str = ""
    fc_egress_cidrs: list = field(default_factory=list)
    fc_network_verified: bool = False
    sandbox_mode: str = "workspace-write"
    allow_external_sandbox: bool = False
    attempt_seconds: int = 300
    lease_seconds: int = 60
    max_attempts: int = 3
    max_model_requests: int = 64
    max_output_tokens: int = 8192
    max_input_bytes: int = 2_000_000
    max_files: int = 200
    max_file_bytes: int = 4_000_000
    max_workspace_bytes: int = 16_000_000
    max_event_bytes: int = 8_000_000
    registry_path: Path = Path("config/capabilities.json")
    blob_backend: str = "local"
    s3_bucket: str = ""
    s3_endpoint: str | None = None
    s3_region: str = "us-east-1"
    admin_key: str = ""
    bridge_url: str = "http://127.0.0.1:8787"
    bridge_secret: str = ""
    teaching_mode: bool = False
    production: bool = False
    teaching_url: str = ""
    teaching_deployment: str = ""
    teaching_verify_key: str = ""
    teaching_tool_key: str = ""
    max_active: int = 4
    max_teacher_active: int = 1
    max_teacher_pending: int = 3
    max_teacher_sessions: int = 5
    max_sandboxes: int = 30
    sandbox_lifetime_seconds: int = 28800
    oss_bucket: str = ""
    oss_endpoint: str = ""
    oss_prefix: str = "teacher-agent/v1/"
    oss_region: str = "cn-hangzhou"

    @classmethod
    def from_env(cls):
        return cls(
            database_url=os.getenv("DATABASE_URL", "sqlite:///data/agent.db"),
            data_dir=Path(os.getenv("DATA_DIR", "data")),
            api_keys=json.loads(os.getenv("CHAT_API_KEYS", "{}")),
            provider=os.getenv("SANDBOX_PROVIDER", "docker"),
            model=os.getenv("MODEL", "deepseek-flash"),
            reasoning_effort=os.getenv("MODEL_REASONING_EFFORT", "high"),
            deepseek_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/"),
            deepseek_key=os.getenv("DEEPSEEK_API_KEY", ""),
            gateway_url=os.getenv("GATEWAY_URL", "http://control:8080").rstrip("/"),
            image=os.getenv("RUNNER_IMAGE", "agent-demo-runner:0.1.0"),
            docker_network=os.getenv("DOCKER_NETWORK", "agent-demo-exec"),
            fc_template=os.getenv("FC_TEMPLATE", ""),
            fc_api_key=os.getenv("E2B_API_KEY", ""),
            fc_api_url=os.getenv("E2B_API_URL", ""),
            fc_domain=os.getenv("E2B_DOMAIN", ""),
            fc_egress_cidrs=json.loads(os.getenv("FC_EGRESS_CIDRS", "[]")),
            fc_network_verified=os.getenv("FC_NETWORK_VERIFIED") == "true",
            sandbox_mode=os.getenv("CODEX_SANDBOX_MODE", "workspace-write"),
            allow_external_sandbox=os.getenv("ALLOW_EXTERNAL_SANDBOX") == "true",
            attempt_seconds=int(os.getenv("ATTEMPT_SECONDS", "300")),
            lease_seconds=int(os.getenv("LEASE_SECONDS", "60")),
            registry_path=Path(os.getenv("CAPABILITY_REGISTRY", "config/capabilities.json")),
            blob_backend=os.getenv("BLOB_BACKEND", "local"),
            s3_bucket=os.getenv("S3_BUCKET", ""),
            s3_endpoint=os.getenv("S3_ENDPOINT") or None,
            s3_region=os.getenv("AWS_DEFAULT_REGION", "us-east-1"),
            admin_key=os.getenv("CONTROL_ADMIN_KEY", ""),
            bridge_url=os.getenv("BRIDGE_URL", "http://127.0.0.1:8787"),
            bridge_secret=os.getenv("BRIDGE_SIGNING_KEY", ""),
            teaching_mode=os.getenv("TEACHING_MODE") == "1",
            production=os.getenv("TEACHING_ENV") == "production",
            teaching_url=os.getenv("TEACHING_BASE_URL", "").rstrip("/"),
            teaching_deployment=os.getenv("TEACHING_DEPLOYMENT_ID", ""),
            teaching_verify_key=os.getenv("TEACHING_VERIFY_KEY", ""),
            teaching_tool_key=os.getenv("TEACHING_TOOL_SIGNING_KEY", ""),
            max_active=int(os.getenv("MAX_ACTIVE_EXECUTIONS", "4")),
            max_teacher_active=int(os.getenv("MAX_TEACHER_ACTIVE", "1")),
            max_teacher_pending=int(os.getenv("MAX_TEACHER_PENDING", "3")),
            max_teacher_sessions=int(os.getenv("MAX_TEACHER_SESSIONS", "5")),
            max_sandboxes=int(os.getenv("MAX_RETAINED_SANDBOXES", "30")),
            sandbox_lifetime_seconds=int(os.getenv("SANDBOX_LIFETIME_SECONDS", "28800")),
            oss_bucket=os.getenv("AGENT_OSS_BUCKET", ""),
            oss_endpoint=os.getenv("AGENT_OSS_ENDPOINT", ""),
            oss_prefix=os.getenv("AGENT_OSS_PREFIX", "teacher-agent/v1/"),
            oss_region=os.getenv("AGENT_OSS_REGION", "cn-hangzhou"),
        )

    def validate(self):
        if self.reasoning_effort not in {'low', 'high', 'max'}:
            raise ValueError('MODEL_REASONING_EFFORT must be low, high or max')
        if self.provider not in {"docker", "fc", "fc-internal"}:
            raise ValueError("SANDBOX_PROVIDER must be docker, fc or fc-internal; no host-process fallback")
        if self.sandbox_mode not in {"workspace-write", "danger-full-access"}:
            raise ValueError("Unsupported sandbox mode")
        if self.sandbox_mode == "danger-full-access" and not self.allow_external_sandbox:
            raise ValueError("External sandbox mode requires explicit ALLOW_EXTERNAL_SANDBOX=true")
        if not 30 <= self.attempt_seconds <= 3600:
            raise ValueError("ATTEMPT_SECONDS must be between 30 and 3600")
        if not 30 <= self.lease_seconds <= 300:
            raise ValueError("LEASE_SECONDS must be between 30 and 300")
        if self.blob_backend not in {"local", "s3", "oss", "fc-oss"}:
            raise ValueError("Unsupported blob backend")
        if self.provider == 'fc-internal' and (self.blob_backend != 'fc-oss' or not 1 <= self.max_active <= self.max_sandboxes <= 30):
            raise ValueError('FC internal sandbox requires durable fc-oss and 1 to 30 bounded sandboxes')
        if not 1 <= self.max_teacher_sessions <= 20 or not 60 <= self.sandbox_lifetime_seconds <= 28800:
            raise ValueError('Invalid session capacity or sandbox lifetime')
        if self.blob_backend == "oss" and (not self.oss_bucket or not self.oss_endpoint.startswith("https://") or not self.oss_prefix.strip("/")):
            raise ValueError("OSS requires bucket, HTTPS endpoint and a dedicated nonempty prefix")
        if self.teaching_mode:
            from urllib.parse import urlparse
            url = urlparse(self.teaching_url)
            if (url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1"})) or url.path or url.query or url.fragment or url.username:
                raise ValueError("TEACHING_BASE_URL must be an HTTPS origin (localhost HTTP allowed)")
            if not self.teaching_deployment or min(len(self.teaching_verify_key), len(self.teaching_tool_key)) < 32:
                raise ValueError("Teaching deployment and two strong service signing keys required")
            if not 1 <= self.max_active <= 32 or not 1 <= self.max_teacher_pending <= 20 or not 1 <= self.max_teacher_active <= self.max_active:
                raise ValueError("Invalid teaching capacity limits")
            if self.production and self.provider != 'fc-internal' and (not self.database_url.startswith("mysql+pymysql://") or self.blob_backend != "oss" or self.provider != "fc"):
                raise ValueError("Production teaching requires independent MySQL, native OSS and FC sandbox")
        if self.blob_backend == "s3" and not self.s3_bucket:
            raise ValueError("S3_BUCKET required")
        for key, principal in self.api_keys.items():
            if len(key) < 24 or not isinstance(principal, dict) or not principal.get("tenant"):
                raise ValueError("CHAT_API_KEYS requires strong keys and tenant principals")

    def fingerprint(self):
        payload = {"provider": "deepseek", "endpoint": self.deepseek_url, "model": self.model,
                   "protocol": "responses", "adapter": 1, "image": self.image,
                   "sandbox_mode": self.sandbox_mode, "reasoning_effort": self.reasoning_effort}
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
