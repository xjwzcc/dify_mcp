import hashlib
import os
from pathlib import Path, PurePosixPath
import uuid


class InputError(ValueError):
    pass


def safe_path(name: str) -> str:
    if not isinstance(name, str) or not name or len(name) > 240 or "\\" in name or "\0" in name:
        raise InputError("Invalid relative path")
    p = PurePosixPath(name)
    if p.is_absolute() or any(x in {"", ".", ".."} for x in name.split("/")):
        raise InputError("Invalid relative path")
    if any(x in {".codex", ".agents", ".git", "node_modules", ".venv", "__pycache__"} for x in p.parts):
        raise InputError("Reserved directory")
    if p.name.lower() in {"agents.md", "agents.override.md"}:
        raise InputError("Project instructions cannot be uploaded")
    return str(p)


class Blobs:
    """Opaque immutable blobs; authorization is always enforced by the database caller."""
    def __init__(self, settings):
        self.settings = settings
        self.root = settings.data_dir / "blobs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.client = None
        if settings.blob_backend == "s3":
            import boto3
            self.client = boto3.client("s3", endpoint_url=settings.s3_endpoint,
                                      region_name=settings.s3_region)

    def put(self, data: bytes) -> dict:
        key = uuid.uuid4().hex
        sha = hashlib.sha256(data).hexdigest()
        if self.settings.blob_backend == "fc-oss":
            from .fc_storage import Persistence
            Persistence().request('PUT', '/blobs/' + key, data)
        elif self.settings.blob_backend == "oss":
            self.oss_bucket().put_object(self.settings.oss_prefix.strip("/") + "/" + key, data,
                headers={"Content-Type": "application/octet-stream", "x-oss-object-acl": "private", "x-oss-forbid-overwrite": "true"})
        elif self.client:
            self.client.put_object(Bucket=self.settings.s3_bucket, Key=key, Body=data,
                                   ContentType="application/octet-stream")
        else:
            target = self.root / key
            with target.open("xb") as f:
                f.write(data)
        return {"blob": key, "sha256": sha, "size": len(data)}

    def get(self, ref: dict) -> bytes:
        key = ref["blob"]
        if len(key) != 32 or any(c not in "0123456789abcdef" for c in key):
            raise InputError("Invalid blob")
        if self.settings.blob_backend == "fc-oss":
            from .fc_storage import Persistence
            data = Persistence().request('GET', '/blobs/' + key)
        elif self.settings.blob_backend == "oss":
            data = self.oss_bucket().get_object(self.settings.oss_prefix.strip("/") + "/" + key).read()
        elif self.client:
            data = self.client.get_object(Bucket=self.settings.s3_bucket, Key=key)["Body"].read()
        else:
            data = (self.root / key).read_bytes()
        if len(data) != ref["size"] or hashlib.sha256(data).hexdigest() != ref["sha256"]:
            raise InputError("Blob integrity check failed")
        return data

    def oss_bucket(self):
        import json
        import oss2
        # A mounted credential file can be atomically rotated by the host. Read it
        # per request so long-running workers do not keep expired STS credentials.
        source = os.getenv("AGENT_OSS_CREDENTIALS_FILE")
        creds = json.loads(Path(source).read_text()) if source else {
            "access_key_id": os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID"),
            "access_key_secret": os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET"),
            "security_token": os.getenv("ALIBABA_CLOUD_SECURITY_TOKEN")}
        if not creds.get("access_key_id") or not creds.get("access_key_secret"):
            raise InputError("OSS_CREDENTIALS_MISSING")
        if creds.get("security_token"):
            auth = oss2.StsAuth(creds["access_key_id"], creds["access_key_secret"], creds["security_token"], auth_version="v4")
        else:
            auth = oss2.AuthV4(creds["access_key_id"], creds["access_key_secret"])
        return oss2.Bucket(auth, self.settings.oss_endpoint, self.settings.oss_bucket, region=self.settings.oss_region, connect_timeout=10)

    def validate_files(self, files: dict[str, bytes]):
        s = self.settings
        if len(files) > s.max_files or sum(map(len, files.values())) > s.max_workspace_bytes:
            raise InputError("WORKSPACE_LIMIT")
        for name, data in files.items():
            safe_path(name)
            if len(data) > s.max_file_bytes:
                raise InputError("FILE_LIMIT")
