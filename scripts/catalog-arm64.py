"""Regenerate ARM64 candidate pins from signed package indexes and vendor metadata.

Requires Python 3.11+ and GnuPG. Native full CI acceptance is still required.
"""
import argparse
import gzip
import hashlib
import json
import lzma
from pathlib import Path
import subprocess
import tempfile
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def get(url):
    with urllib.request.urlopen(url, timeout=180) as response:
        return response.read()


def generate(gpg):
    lock = json.loads((ROOT / "runner/catalog/versions.lock").read_text())
    lock.update(architecture="arm64", approvedArchitectures=["arm64"])
    with tempfile.TemporaryDirectory(prefix="sterra-catalog-") as temporary:
        folder = Path(temporary)
        def gp(file):
            value = str(file).replace("\\", "/")
            return "/" + value[0].lower() + value[2:] if "Git" in gpg and len(value) > 1 and value[1] == ":" else value

        def verify(content, signature, key):
            for name, value in (("key.asc", key), ("content", content), ("signature", signature)):
                (folder / name).write_bytes(value)
            base = [gpg, "--homedir", gp(folder), "--batch", "--yes"]
            imported = subprocess.run(base + ["--import", gp(folder / "key.asc")], capture_output=True)
            if imported.returncode:
                raise ValueError(imported.stderr.decode(errors="replace"))
            result = subprocess.run(base + ["--status-fd", "1", "--verify", gp(folder / "signature"), gp(folder / "content")], capture_output=True)
            if b"[GNUPG:] VALIDSIG " not in result.stdout or b"[GNUPG:] BADSIG " in result.stdout:
                raise ValueError("Publisher signature verification failed: " + result.stderr.decode(errors="replace"))

        def index(base, name, key):
            release = get(base + "/Release")
            verify(release, get(base + "/Release.gpg"), key)
            checksums = release.decode().split("SHA256:\n", 1)[1].split("\nSHA", 1)[0]
            checksum = next(line.split()[0] for line in checksums.splitlines() if len(line.split()) == 3 and line.split()[2] == name)
            data = get(base + "/" + name)
            if hashlib.sha256(data).hexdigest() != checksum:
                raise ValueError("Signed index checksum mismatch")
            text = (lzma.decompress(data) if name.endswith(".xz") else gzip.decompress(data)).decode()
            return [dict(line.split(": ", 1) for line in paragraph.splitlines() if line and not line[0].isspace() and ": " in line) for paragraph in text.split("\n\n")]

        debian = index("https://deb.debian.org/debian/dists/bookworm", "main/binary-arm64/Packages.xz", get("https://ftp-master.debian.org/keys/archive-key-12.asc"))
        microsoft = index("https://packages.microsoft.com/debian/12/prod/dists/bookworm", "main/binary-arm64/Packages.gz", (ROOT / "runner/catalog/microsoft-key").read_bytes())
        dotnet_version = lock["apt"].pop("dotnet-sdk-8.0")["version"].split("-")[0]
        for name, old in lock["apt"].items():
            matches = [p for p in debian + microsoft if p.get("Package") == name and p.get("Version") == old["version"] and p.get("Architecture") in ("arm64", "all")]
            if not matches:
                raise ValueError(f"Exact ARM64 package missing: {name}={old['version']}")
            p = matches[-1]
            lock["apt"][name] = dict(name=name, version=p["Version"], architecture=p["Architecture"], sha256=p["SHA256"], filename=p["Filename"])
        go = next(r for r in json.loads(get(lock["go"]["provenance"])) if r["version"] == "go" + lock["go"]["version"])
        artifact = next(f for f in go["files"] if f["os"] == "linux" and f["arch"] == "arm64" and f["kind"] == "archive")
        lock["go"].update(url="https://go.dev/dl/" + artifact["filename"], sha256=artifact["sha256"])
        rust = get(lock["rust"]["manifestURL"])
        if hashlib.sha256(rust).hexdigest() != lock["rust"]["manifestSHA256"]:
            raise ValueError("Rust manifest checksum mismatch")
        verify(rust, get(lock["rust"]["manifestURL"] + ".asc"), (ROOT / "runner/catalog/rust-key").read_bytes())
        manifest = tomllib.loads(rust.decode())
        lock["rust"]["artifacts"] = [dict(name=name, url=manifest["pkg"][name]["target"]["aarch64-unknown-linux-gnu"]["xz_url"], sha256=manifest["pkg"][name]["target"]["aarch64-unknown-linux-gnu"]["xz_hash"]) for name in ("rustc", "cargo", "rust-std")]
        metadata_url = "https://builds.dotnet.microsoft.com/dotnet/release-metadata/8.0/releases.json"
        metadata = json.loads(get(metadata_url))
        sdk = next(sdk for release in metadata["releases"] for sdk in release.get("sdks", [release.get("sdk", {})]) if sdk.get("version") == dotnet_version)
        artifact = next(f for f in sdk["files"] if f["rid"] == "linux-arm64" and f["name"].endswith(".tar.gz"))
        archive = get(artifact["url"])
        if hashlib.sha512(archive).hexdigest() != artifact["hash"].lower():
            raise ValueError("Official .NET SHA512 mismatch")
        lock["csharp"] = dict(version=dotnet_version, url=artifact["url"], sha256=hashlib.sha256(archive).hexdigest(), sha512=artifact["hash"].lower(), provenance=metadata_url)
    (ROOT / "runner/catalog/versions.arm64.lock").write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
    print("ARM64 candidate catalog generated from verified sources. Native acceptance is required before publication.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gpg", default="gpg")
    generate(parser.parse_args().gpg)
