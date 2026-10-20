"""Preview, inspect or upload the public code-install directory over verified SFTP.

python -m pip install -r installer/upload-requirements.txt
python installer/upload.py --inspect
python installer/upload.py --remote-root /path/to/wordpress
python installer/upload.py --remote-root /path/to/wordpress --apply

Unknown SSH keys are rejected. Obtain the fingerprint from a trusted channel and
pass --host-key SHA256:... if the host is not already in your known_hosts file.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import posixpath
import stat
import sys
import urllib.request
import uuid
import struct
import os

HOSTING = Path(__file__).resolve().parent / "hosting"
PUBLIC_FILES = ("index.html", "style.css", "install.sh", "install.ps1", ".htaccess")


def windows_host_fingerprints(host):
    """Reuse an existing PuTTY/WinSCP trust decision; never trust a scanned key."""
    if os.name != "nt":
        return set()
    import winreg
    result = set()
    for location in (r"Software\SimonTatham\PuTTY\SshHostKeys", r"Software\Martin Prikryl\WinSCP 2\SshHostKeys"):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, location) as key:
                value, _ = winreg.QueryValueEx(key, "ssh-ed25519@22:" + host)
            x, y = [int(part, 16) for part in value.split(",")]
            encoded = (y | ((x & 1) << 255)).to_bytes(32, "little")
            name = b"ssh-ed25519"
            wire = struct.pack(">I", len(name)) + name + struct.pack(">I", len(encoded)) + encoded
            result.add("SHA256:" + base64.b64encode(hashlib.sha256(wire).digest()).decode().rstrip("="))
        except (OSError, ValueError, OverflowError):
            continue
    return result


def main():
    import paramiko
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="5018480546.ssh.w2.strato.hosting")
    parser.add_argument("--user", default="su1216743")
    parser.add_argument("--password-file", type=Path, default=HOSTING.parent.parent / "sftp.txt")
    parser.add_argument("--host-key", help="Trusted SHA256 SSH host-key fingerprint")
    parser.add_argument("--remote-root")
    parser.add_argument("--wordpress-content", action="store_true", help="The SFTP root is wp-content; install the fixed MU-plugin route instead of requiring web-root access")
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not args.inspect and not args.remote_root:
        parser.error("--remote-root is required; use --inspect to locate candidate WordPress roots first")
    password = args.password_file.read_text(encoding="utf-8-sig").rstrip("\r\n")
    if not password:
        raise ValueError("The local SFTP password file is empty. Nothing was uploaded.")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    known = Path.home() / ".ssh/known_hosts"
    if known.exists():
        client.load_host_keys(str(known))

    class TrustedKey(paramiko.MissingHostKeyPolicy):
        def missing_host_key(self, client, hostname, key):
            fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")
            trusted = {args.host_key} if args.host_key else windows_host_fingerprints(args.host)
            if fingerprint not in trusted:
                raise ValueError(f"SSH host key is not trusted. Observed fingerprint: {fingerprint}. Verify it with STRATO before using --host-key.")

    client.set_missing_host_key_policy(TrustedKey())
    client.connect(args.host, username=args.user, password=password, look_for_keys=False, allow_agent=False, timeout=15, auth_timeout=15)
    password = None
    try:
        with client.open_sftp() as sftp:
            if args.inspect:
                def inspect(directory, depth=0):
                    entries = sftp.listdir_attr(directory)
                    names = {entry.filename for entry in entries}
                    if "wp-config.php" in names or {"wp-admin", "wp-content"}.issubset(names):
                        print("WordPress root candidate:", sftp.normalize(directory))
                    for entry in entries:
                        print("  " * depth + posixpath.join(directory, entry.filename) + ("/" if stat.S_ISDIR(entry.st_mode) else ""))
                        if depth < 1 and stat.S_ISDIR(entry.st_mode) and not entry.filename.startswith("."):
                            inspect(posixpath.join(directory, entry.filename), depth + 1)
                print("SFTP working directory:", sftp.normalize("."))
                inspect(args.remote_root or ".")
                return
            if ".." in args.remote_root.split("/") or "\\" in args.remote_root:
                raise ValueError("Invalid remote root")
            root = sftp.normalize(args.remote_root)
            if not stat.S_ISDIR(sftp.lstat(root).st_mode):
                raise ValueError("Remote root must be a real directory")
            target = posixpath.join(root, "code-install")
            route_remote = None
            if args.wordpress_content:
                for name in ("themes", "plugins", "mu-plugins"):
                    if not stat.S_ISDIR(sftp.lstat(posixpath.join(root, name)).st_mode):
                        raise ValueError("The selected root is not a real wp-content directory")
                route_remote = posixpath.join(root, "mu-plugins/sterracode-installer.php")
            try:
                info = sftp.lstat(target)
                if not stat.S_ISDIR(info.st_mode):
                    raise ValueError("code-install must be a real directory, not a link")
            except FileNotFoundError:
                pass
            print(json.dumps({"mode": "APPLY" if args.apply else "PREVIEW", "target": target, "files": list(PUBLIC_FILES), "wordpressRoute": route_remote}, indent=2))
            if not args.apply:
                print("Preview only. No remote changes made.")
                return
            # Prove that the selected root serves sterra.online before replacing files.
            marker = "sterracode-install-root-" + uuid.uuid4().hex + ".txt"
            proof = uuid.uuid4().hex.encode()
            marker_path = posixpath.join(root, marker)
            try:
                with sftp.open(marker_path, "wx") as file:
                    file.write(proof)
                sftp.chmod(marker_path, 0o644)
                proof_base = "https://sterra.online/wp-content/" if args.wordpress_content else "https://sterra.online/"
                with urllib.request.urlopen(proof_base + marker, timeout=20) as response:
                    if response.geturl().split("/")[2] not in ("sterra.online", "www.sterra.online") or response.read() != proof:
                        raise ValueError("The selected directory does not serve the expected sterra.online URL")
            finally:
                sftp.remove(marker_path)
            try:
                sftp.mkdir(target, mode=0o755)
            except OSError:
                if not stat.S_ISDIR(sftp.lstat(target).st_mode):
                    raise
            backup = HOSTING.parent / ".upload-backups" / uuid.uuid4().hex
            backup.mkdir(parents=True, mode=0o700)
            # Preserve every old file before the first public replacement.
            for name in PUBLIC_FILES:
                remote = posixpath.join(target, name)
                try:
                    info = sftp.lstat(remote)
                    if not stat.S_ISREG(info.st_mode):
                        raise ValueError("Refusing a non-regular destination file: " + name)
                    sftp.get(remote, str(backup / name))
                except FileNotFoundError:
                    pass
            route_existed = False
            if route_remote:
                try:
                    if not stat.S_ISREG(sftp.lstat(route_remote).st_mode):
                        raise ValueError("Refusing a non-regular WordPress route file")
                    sftp.get(route_remote, str(backup / "sterracode-installer.php"))
                    route_existed = True
                except FileNotFoundError:
                    pass
            for name in PUBLIC_FILES:
                remote = posixpath.join(target, name)
                temporary = posixpath.join(target, "." + name + "." + uuid.uuid4().hex + ".tmp")
                try:
                    sftp.put(str(HOSTING / name), temporary)
                    sftp.chmod(temporary, 0o644)
                    # OpenSSH atomic rename replaces an existing public file in one step.
                    sftp.posix_rename(temporary, remote)
                finally:
                    try:
                        sftp.remove(temporary)
                    except FileNotFoundError:
                        pass
            if route_remote:
                temporary = route_remote + "." + uuid.uuid4().hex + ".tmp"
                sftp.put(str(HOSTING.parent / "wordpress/sterracode-installer.php"), temporary)
                sftp.chmod(temporary, 0o644)
                sftp.posix_rename(temporary, route_remote)
            try:
                for name in PUBLIC_FILES:
                    if name == ".htaccess":
                        continue
                    url = "https://sterra.online/code-install/" + name
                    with urllib.request.urlopen(url, timeout=30) as response:
                        if response.read() != (HOSTING / name).read_bytes():
                            raise ValueError("Public content verification failed: " + name)
                        if name.endswith((".sh", ".ps1")) and response.headers.get_content_type() != "text/plain":
                            raise ValueError("Installer must be served as text/plain: " + name)
                with urllib.request.urlopen("https://sterra.online/", timeout=30) as response:
                    if response.status != 200 or b"sterra-vscode" not in response.read():
                        raise ValueError("The original WordPress home page no longer matches the active theme")
            except Exception:
                # A route failure must not leave a broken global MU-plugin active.
                if route_remote:
                    if route_existed:
                        temporary = route_remote + "." + uuid.uuid4().hex + ".tmp"
                        sftp.put(str(backup / "sterracode-installer.php"), temporary)
                        sftp.posix_rename(temporary, route_remote)
                    else:
                        sftp.remove(route_remote)
                raise
            print("Upload and HTTPS content verification completed. Previous files saved locally in:", backup)
    finally:
        client.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("SFTP upload stopped:", str(error), file=sys.stderr)
        sys.exit(1)
