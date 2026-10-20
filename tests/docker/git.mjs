import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const marker = "SYNTHETIC_GIT_PAT_642987";
async function command(binary, args, options = {}) {
  const result = await exec(binary, args, {
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  return result.stdout;
}
async function fixture() {
  await fs.mkdir("/fixtures/repos", { recursive: true });
  await fs.mkdir("/run/sshd", { recursive: true });
  await command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=SterraCode disposable test CA",
    "-keyout",
    "/fixtures/ca.key",
    "-out",
    "/fixtures/ca.crt",
  ]);
  await command("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=git-fixture",
    "-keyout",
    "/fixtures/server.key",
    "-out",
    "/fixtures/server.csr",
  ]);
  await fs.writeFile(
    "/fixtures/extensions",
    "subjectAltName=DNS:git-fixture\n",
  );
  await command("openssl", [
    "x509",
    "-req",
    "-in",
    "/fixtures/server.csr",
    "-CA",
    "/fixtures/ca.crt",
    "-CAkey",
    "/fixtures/ca.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    "/fixtures/extensions",
    "-out",
    "/fixtures/server.crt",
  ]);
  for (const name of ["host_key", "user_key"])
    await command("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      `/fixtures/${name}`,
    ]);
  await command("git", ["init", "--initial-branch=main", "/fixtures/work"]);
  await fs.writeFile("/fixtures/work/main.py", 'print("GIT_SNAPSHOT_OK")\n');
  await fs.writeFile(
    "/fixtures/work/large.dat",
    "version https://git-lfs.github.com/spec/v1\noid sha256:" +
      "a".repeat(64) +
      "\nsize 987654321\n",
  );
  await fs.symlink("main.py", "/fixtures/work/link.py");
  await command("git", ["-C", "/fixtures/work", "add", "."]);
  await command("git", [
    "-C",
    "/fixtures/work",
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "fixture",
  ]);
  const commit = (
    await command("git", ["-C", "/fixtures/work", "rev-parse", "HEAD"])
  ).trim();
  await command("git", [
    "-C",
    "/fixtures/work",
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${commit},external`,
  ]);
  await command("git", [
    "-C",
    "/fixtures/work",
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "external component",
  ]);
  await command("git", ["-C", "/fixtures/work", "tag", "v1"]);
  await command("git", [
    "clone",
    "--bare",
    "/fixtures/work",
    "/fixtures/repos/demo.git",
  ]);
  // sshd runs upload-pack as git. The HTTPS backend runs as root, so both
  // the owning user and an explicit safe directory are required.
  await command("chown", ["-R", "git:git", "/fixtures/repos"]);
  await command("git", ["config", "--system", "--add", "safe.directory", "*"]);
  const gitUid = Number((await command("id", ["-u", "git"])).trim());
  const gitGid = Number((await command("id", ["-g", "git"])).trim());
  await fs.mkdir("/home/git/.ssh", { mode: 0o700 });
  await fs.writeFile(
    "/home/git/.ssh/authorized_keys",
    "restrict " + (await fs.readFile("/fixtures/user_key.pub", "utf8")),
    { mode: 0o600 },
  );
  await command("chown", ["-R", "git:git", "/home/git/.ssh"]);
  await fs.writeFile(
    "/fixtures/sshd_config",
    "Port 2222\nListenAddress 0.0.0.0\nHostKey /fixtures/host_key\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin no\nAllowUsers git\nStrictModes yes\nForceCommand git-upload-pack /fixtures/repos/demo.git\nLogLevel ERROR\n",
  );
  const sshd = spawn(
    "/usr/sbin/sshd",
    ["-D", "-e", "-f", "/fixtures/sshd_config"],
    { stdio: "ignore" },
  );
  sshd.once("exit", (code) => {
    if (code) process.exit(code);
  });
  const server = https.createServer(
    {
      key: await fs.readFile("/fixtures/server.key"),
      cert: await fs.readFile("/fixtures/server.crt"),
    },
    (req, res) => {
      const url = new URL(req.url, "https://git-fixture:8443");
      if (url.pathname.startsWith("/redirect/")) {
        res.writeHead(302, { location: "https://127.0.0.1/blocked" });
        res.end();
        return;
      }
      if (
        !url.pathname.startsWith("/public/") &&
        req.headers.authorization !==
          "Basic " + Buffer.from("git:" + marker).toString("base64")
      ) {
        res.writeHead(401, {
          "www-authenticate": 'Basic realm="disposable Git fixture"',
        });
        res.end();
        return;
      }
      const child = spawn("git", ["http-backend"], {
        uid: gitUid,
        gid: gitGid,
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: "/fixtures/repos",
          GIT_HTTP_EXPORT_ALL: "1",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "safe.directory",
          GIT_CONFIG_VALUE_0: "*",
          REQUEST_METHOD: req.method,
          QUERY_STRING: url.search.slice(1),
          PATH_INFO: url.pathname.replace(/^\/(?:private|public)\//, "/"),
          CONTENT_TYPE: req.headers["content-type"] || "",
          CONTENT_LENGTH: req.headers["content-length"] || "",
          REMOTE_USER: "git",
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      req.pipe(child.stdin);
      let header = Buffer.alloc(0),
        ready = false;
      child.stdout.on("data", (data) => {
        if (ready) {
          res.write(data);
          return;
        }
        header = Buffer.concat([header, data]);
        const end = header.indexOf("\r\n\r\n");
        if (end < 0) return;
        let status = 200;
        const headers = {};
        for (const line of header
          .subarray(0, end)
          .toString("utf8")
          .split("\r\n")) {
          const colon = line.indexOf(":");
          if (colon < 0) continue;
          const name = line.slice(0, colon),
            value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status")
            status = Number(value.slice(0, 3));
          else headers[name] = value;
        }
        res.writeHead(status, headers);
        res.write(header.subarray(end + 4));
        ready = true;
      });
      child.stdout.on("end", () => res.end());
      child.on("error", () => res.destroy());
    },
  );
  await new Promise((resolve) => server.listen(8443, "0.0.0.0", resolve));
  await fs.writeFile("/fixtures/ready", "ready");
}
async function client() {
  const { inspectGitSnapshot, materializeGitSnapshot } =
    await import("/app/server/services/gitImports.js");
  const { saveGitCredential } =
    await import("/app/server/services/gitCredentials.js");
  const token = await saveGitCredential({
    name: "Synthetic PAT",
    type: "https-token",
    host: "git-fixture",
    port: 8443,
    repositoryPrefix: "/private",
    secret: marker,
  });
  const hostKey = (await fs.readFile("/fixture-host.pub", "utf8"))
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");
  const privateKey = await fs.readFile("/fixture-user", "utf8");
  const ssh = await saveGitCredential({
    name: "Synthetic SSH",
    type: "ssh-key",
    host: "git-fixture",
    port: 2222,
    username: "git",
    repositoryPrefix: "/fixtures/repos",
    secret: privateKey,
    hostKey,
  });
  for (const [label, source] of [
    [
      "public-https",
      { repositoryUrl: "https://git-fixture:8443/public/demo.git" },
    ],
    [
      "private-pat",
      {
        repositoryUrl: "https://git-fixture:8443/private/demo.git",
        credentialId: token.id,
        ref: "v1",
      },
    ],
    [
      "private-ssh",
      {
        repositoryUrl: "ssh://git@git-fixture:2222/fixtures/repos/demo.git",
        credentialId: ssh.id,
        ref: "main",
      },
    ],
  ]) {
    const directory = `/tmp/git-test/${label}`,
      destination = `/tmp/git-test/${label}-out`;
    await fs.mkdir(destination, { recursive: true });
    const snapshot = await inspectGitSnapshot({
      source,
      directory,
      budget: { maxBytes: 1024 * 1024, maxEntries: 100 },
    });
    assert.match(snapshot.source.commit, /^[a-f0-9]{40}$/);
    assert(!JSON.stringify(snapshot).includes(marker));
    assert(!snapshot.source.credentialId);
    assert(snapshot.warnings.some((w) => w.code === "GIT_SUBMODULE_SKIPPED"));
    assert(
      snapshot.warnings.some((w) => w.code === "GIT_SPECIAL_FILE_SKIPPED"),
    );
    assert(
      snapshot.warnings.some(
        (w) =>
          w.code === "GIT_LFS_POINTER_NOT_DOWNLOADED" && w.path === "large.dat",
      ),
    );
    assert.equal(
      snapshot.entries.find((entry) => entry.path === "large.dat")?.lfsPointer,
      true,
    );
    await materializeGitSnapshot({
      directory,
      destination,
      entries: snapshot.entries.filter(
        (e) => e.path === "main.py" || e.path === "large.dat",
      ),
    });
    assert.equal(
      await fs.readFile(path.join(destination, "main.py"), "utf8"),
      'print("GIT_SNAPSHOT_OK")\n',
    );
    assert.match(
      await fs.readFile(path.join(destination, "large.dat"), "utf8"),
      /^version https:\/\/git-lfs/,
    );
    assert.deepEqual((await fs.readdir(destination)).sort(), [
      "large.dat",
      "main.py",
    ]);
    await assert.rejects(fs.access(path.join(directory, ".git-private")));
    console.log(
      `PASS: ${label}, fixed commit, selected blobs, no checkout, cleanup.`,
    );
  }
  const bad = await saveGitCredential({
    name: "Wrong PAT",
    type: "https-token",
    host: "git-fixture",
    port: 8443,
    repositoryPrefix: "/private",
    secret: "SYNTHETIC_WRONG_PAT",
  });
  await assert.rejects(
    inspectGitSnapshot({
      source: {
        repositoryUrl: "https://git-fixture:8443/private/demo.git",
        credentialId: bad.id,
      },
      directory: "/tmp/git-test/bad-pat",
    }),
    { code: "GIT_FETCH_FAILED" },
  );
  const wrongHost = (await fs.readFile("/fixture-user.pub", "utf8"))
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");
  const badSsh = await saveGitCredential({
    name: "Wrong host key",
    type: "ssh-key",
    host: "git-fixture",
    port: 2222,
    repositoryPrefix: "/fixtures/repos",
    secret: privateKey,
    hostKey: wrongHost,
  });
  await assert.rejects(
    inspectGitSnapshot({
      source: {
        repositoryUrl: "ssh://git@git-fixture:2222/fixtures/repos/demo.git",
        credentialId: badSsh.id,
      },
      directory: "/tmp/git-test/bad-hostkey",
    }),
    { code: "GIT_FETCH_FAILED" },
  );
  await assert.rejects(
    inspectGitSnapshot({
      source: { repositoryUrl: "https://git-fixture:8443/redirect/demo.git" },
      directory: "/tmp/git-test/redirect",
    }),
    { code: "GIT_FETCH_FAILED" },
  );
  assert(
    !(
      await fs.readFile(
        path.join(process.env.STERRACODE_DATA_DIR, "credentials/git.json"),
        "utf8",
      )
    ).includes(marker),
  );
  console.log(
    "PASS: wrong PAT, wrong SSH host key, HTTPS redirect rejected; no plaintext persisted token.",
  );
}
async function main() {
  const image = process.env.STERRACODE_TEST_APP_IMAGE;
  if (!image)
    throw new Error(
      "STERRACODE_TEST_APP_IMAGE is required for exact-image Git acceptance.",
    );
  const id = randomUUID().slice(0, 8),
    network = `sterra-git-${id}`,
    fixtureName = `${network}-fixture`,
    clientName = `${network}-client`,
    fixtureImage = `${network}:fixture`;
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "sterra-git-fixture-"),
  );
  try {
    await fs.copyFile(
      fileURLToPath(import.meta.url),
      path.join(directory, "git.mjs"),
    );
    await fs.writeFile(
      path.join(directory, "Dockerfile"),
      'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends openssh-server openssl && rm -rf /var/lib/apt/lists/* && useradd --create-home --shell /bin/sh --password x git\nCOPY git.mjs /git.mjs\nENTRYPOINT ["node","/git.mjs"]\n',
    );
    await command("docker", [
      "build",
      "--build-arg",
      `BASE_IMAGE=${image}`,
      "-t",
      fixtureImage,
      directory,
    ]);
    await command("docker", ["network", "create", network]);
    await command("docker", [
      "run",
      "-d",
      "--name",
      fixtureName,
      "--network",
      network,
      "--network-alias",
      "git-fixture",
      fixtureImage,
      "--fixture",
    ]);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        await command("docker", [
          "exec",
          fixtureName,
          "test",
          "-f",
          "/fixtures/ready",
        ]);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!ready) throw new Error("Disposable Git fixture did not become ready.");
    for (const file of ["ca.crt", "host_key.pub", "user_key", "user_key.pub"])
      await command("docker", [
        "cp",
        `${fixtureName}:/fixtures/${file}`,
        path.join(directory, file),
      ]);
    await command("docker", [
      "run",
      "-d",
      "--name",
      clientName,
      "--network",
      network,
      "-e",
      "STERRACODE_DATA_DIR=/tmp/git-test-data",
      "-e",
      "STERRACODE_GIT_ALLOWED_HOSTS=git-fixture:8443,git-fixture:2222",
      "-e",
      "STERRACODE_GIT_PRIVATE_HOSTS=git-fixture:8443,git-fixture:2222",
      fixtureImage,
      "--idle",
    ]);
    for (const [file, target] of [
      ["ca.crt", "/usr/local/share/ca-certificates/git-fixture.crt"],
      ["host_key.pub", "/fixture-host.pub"],
      ["user_key", "/fixture-user"],
      ["user_key.pub", "/fixture-user.pub"],
    ])
      await command("docker", [
        "cp",
        path.join(directory, file),
        `${clientName}:${target}`,
      ]);
    await command("docker", ["exec", clientName, "update-ca-certificates"]);
    await command("docker", [
      "exec",
      clientName,
      "chown",
      "10001:10001",
      "/fixture-user",
    ]);
    const output = await command("docker", [
      "exec",
      "--user",
      "10001:10001",
      clientName,
      "node",
      "/git.mjs",
      "--client",
    ]);
    if (output.includes(marker) || output.includes("BEGIN OPENSSH PRIVATE KEY"))
      throw new Error("Synthetic secret leaked in Git acceptance output.");
    process.stdout.write(output);
  } finally {
    for (const container of [clientName, fixtureName])
      await command("docker", ["rm", "-f", container]).catch(() => {});
    await command("docker", ["network", "rm", network]).catch(() => {});
    await command("docker", ["image", "rm", fixtureImage]).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
}
if (process.argv.includes("--fixture")) await fixture();
else if (process.argv.includes("--client")) await client();
else if (process.argv.includes("--idle")) setInterval(() => {}, 60000);
else await main();
