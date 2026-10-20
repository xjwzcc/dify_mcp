"""Build an FC ZIP from repository sources and the existing Python dependencies."""
import argparse
import hashlib
from pathlib import Path, PurePosixPath
import stat
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NODE_ARCHIVE = "node-v24.10.0-linux-x64.tar.xz"


def build(backup, node, checksums, output):
    expected = dict((line.split()[1], line.split()[0]) for line in checksums.read_text().splitlines())
    if hashlib.sha256(node.read_bytes()).hexdigest() != expected[NODE_ARCHIVE]:
        raise ValueError("Node archive SHA256 mismatch")
    files = {}
    with zipfile.ZipFile(backup) as previous:
        prefix = "cc_dify_mcp/"
        names = {name[len(prefix):] for name in previous.namelist() if name.startswith(prefix)}
        packages = {name.split("/")[0] for name in names if name.endswith(".dist-info/METADATA")}
        packages.update(name.split("/")[0] for name in names if name.count("/") == 1 and name.endswith("/__init__.py"))
        for name in sorted(names):
            parts = PurePosixPath(name).parts
            if not parts or ".." in parts or any(part.startswith(".") for part in parts):
                continue
            if name.endswith("/") or "__pycache__" in parts or name.endswith(".pyc"):
                continue
            if parts[0] in packages or (len(parts) == 1 and name.endswith((".py", ".so"))):
                files[name] = (previous.read(prefix + name), 0o644)
    for relative in ["app.py", "requirements.txt", "server.cjs", "package.json", "portal/index.html", "deploy/bootstrap",
                     "README.md", "deploy/README.md", "deploy/FEISHU.md", "deploy/feishu.env.example"]:
        files[relative] = ((ROOT / relative).read_bytes(), 0o755 if relative == "deploy/bootstrap" else 0o644)
    for source in sorted((ROOT / "storage").glob("*.cjs")):
        files[source.relative_to(ROOT).as_posix()] = (source.read_bytes(), 0o644)
    for source in sorted((ROOT / "scripts").glob("*.cjs")):
        files[source.relative_to(ROOT).as_posix()] = (source.read_bytes(), 0o644)
    for app in ["catering", "hotel"]:
        app_root = ROOT / "apps" / app
        for source in sorted(app_root.glob("*.cjs")):
            if source.name.startswith(("test", "build", "preview", "make-entry")):
                continue
            files[source.relative_to(ROOT).as_posix()] = (source.read_bytes(), 0o644)
        for source in sorted((app_root / "public").rglob("*")):
            if source.is_file() and not source.name.startswith("."):
                files[source.relative_to(ROOT).as_posix()] = (source.read_bytes(), 0o644)
    with tarfile.open(node) as archive:
        binary = archive.extractfile("node-v24.10.0-linux-x64/bin/node")
        files["bin/node"] = (binary.read(), 0o755)
    for required in ["uvicorn/__init__.py", "starlette/__init__.py", "mcp/__init__.py"]:
        if required not in files:
            raise ValueError("Original backup is missing required dependency: " + required)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as result:
        for name, (content, mode) in sorted(files.items()):
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            result.writestr(info, content)
    print(f"Built {output.name}: {len(files)} files, {output.stat().st_size} bytes")
    print("SHA256:", hashlib.sha256(output.read_bytes()).hexdigest())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ["backup", "node", "checksums", "output"]:
        parser.add_argument("--" + option, type=Path, required=True)
    build(**vars(parser.parse_args()))
