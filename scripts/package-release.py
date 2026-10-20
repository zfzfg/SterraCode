"""Create the public installer archive and immutable release metadata after CI."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
for kind in ("app", "runner", "updater"):
    parser.add_argument("--" + kind, required=True, help="Published multi-architecture SHA256 digest")
parser.add_argument("--output", type=Path, default=root / "installer/dist")
args = parser.parse_args()
version = json.loads((root / "package.json").read_text())["version"]
if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version):
    raise ValueError("A stable semantic version is required")
policy = json.loads((root / "installer/release-policy.json").read_text())
images = {}
for kind in ("app", "runner", "updater"):
    digest = getattr(args, kind)
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise ValueError("Invalid image digest")
    images[kind] = f"ghcr.io/zfzfg/sterracode-{kind}@{digest}"
dist = args.output.resolve()
dist.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(dist / "installer.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    for folder in ("hosting",):
        for file in sorted((root / "installer" / folder).iterdir()):
            if file.is_file():
                archive.write(file, folder + "/" + file.name)
    for name in ("README.md", "manage.sh", "manage.ps1", "windows-zones.json", "THIRD-PARTY.md", "UNICODE-LICENSE.txt"):
        archive.write(root / "installer" / name, name)
    archive.writestr("version.json", json.dumps({"version": version}))
metadata = {**policy, "version": version, "architectures": ["amd64", "arm64"], "images": images,
            "packageURL": f"https://github.com/zfzfg/SterraCode/releases/download/v{version}/installer.zip",
            "packageSHA256": hashlib.sha256((dist / "installer.zip").read_bytes()).hexdigest()}
(dist / "release.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
print(f"Release artifacts prepared in {dist}. Publish only after all native acceptance jobs pass.")
