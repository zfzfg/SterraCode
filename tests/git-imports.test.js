import { beforeAll, afterAll, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateKeyPairSync } from "node:crypto";

let root, credentials, git;
const execute = promisify(execFile);
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-git-"));
  vi.stubEnv("STERRACODE_DATA_DIR", root);
  vi.stubEnv("STERRACODE_WORKSPACE_DIR", path.join(root, "workspaces"));
  credentials = await import("../server/services/gitCredentials.js");
  git = await import("../server/services/gitImports.js");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("encrypts synthetic tokens with authenticated version/host binding and exposes metadata only", async () => {
  const marker = "SYNTHETIC_SECRET_MUST_NOT_LEAK_83927";
  const saved = await credentials.saveGitCredential({
    name: "Test",
    host: "github.com",
    type: "https-token",
    repositoryPrefix: "/owner",
    secret: marker,
  });
  expect(JSON.stringify(saved)).not.toContain(marker);
  expect(JSON.stringify(await credentials.listGitCredentials())).not.toContain(
    marker,
  );
  expect(
    await fs.readFile(path.join(root, "credentials", "git.json"), "utf8"),
  ).not.toContain(marker);
  expect(
    (
      await credentials.useGitCredential(
        saved.id,
        new URL("https://github.com/owner/repo.git"),
      )
    ).secret,
  ).toBe(marker);
  for (const source of [
    "https://evil.test/owner/repo",
    "https://github.com/ownership/repo",
    "ssh://git@github.com/owner/repo",
  ])
    await expect(
      credentials.useGitCredential(saved.id, new URL(source)),
    ).rejects.toMatchObject({ code: "GIT_CREDENTIAL_HOST_MISMATCH" });
  await expect(
    credentials.saveGitCredential(
      { name: "Test", host: "github.com", type: "https-token", secret: marker },
      saved.id,
      999,
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const keyFile = path.join(root, "credentials", ".git-key"),
    bytes = await fs.readFile(keyFile);
  await fs.rename(keyFile, keyFile + ".saved");
  await expect(
    credentials.useGitCredential(
      saved.id,
      new URL("https://github.com/owner/repo.git"),
    ),
  ).rejects.toMatchObject({ code: "GIT_KEY_UNAVAILABLE" });
  await expect(
    credentials.saveGitCredential({
      name: "Test",
      host: "github.com",
      type: "https-token",
      secret: "another",
    }),
  ).rejects.toMatchObject({ code: "GIT_KEY_UNAVAILABLE" });
  await fs.writeFile(keyFile, bytes, { mode: 0o600 });
  await credentials.deleteGitCredential(saved.id, saved.version);
});
it("derives the SSH public fingerprint and consumes a transient passphrase once", async () => {
  const pair = generateKeyPairSync("ed25519");
  const secret = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const hostKey = "ssh-ed25519 " + Buffer.alloc(32, 7).toString("base64");
  const saved = await credentials.saveGitCredential({
    name: "SSH",
    host: "github.com",
    type: "ssh-key",
    secret,
    hostKey,
  });
  expect(saved.publicKey).toMatch(/^ssh-ed25519 /);
  expect(saved.fingerprint).toMatch(/^SHA256:/);
  expect(saved.hostFingerprint).not.toBe(saved.fingerprint);
  await credentials.unlockGitCredential(
    saved.id,
    "SYNTHETIC_PASSPHRASE",
    saved.version,
  );
  const source = new URL("ssh://git@github.com/owner/repo.git");
  expect(
    (await credentials.useGitCredential(saved.id, source)).passphrase,
  ).toBe("SYNTHETIC_PASSPHRASE");
  expect(
    (await credentials.useGitCredential(saved.id, source)).passphrase,
  ).toBeUndefined();
  expect(JSON.stringify(await credentials.listGitCredentials())).not.toContain(
    "SYNTHETIC_PASSPHRASE",
  );
  await credentials.deleteGitCredential(saved.id, saved.version);
});
it("accepts secret input only on actual TLS or loopback, ignoring forwarded claims", () => {
  expect(
    credentials.gitSecretTransportAllowed({
      socket: { remoteAddress: "192.168.1.2" },
      headers: { "x-forwarded-proto": "https" },
    }),
  ).toBe(false);
  expect(
    credentials.gitSecretTransportAllowed({
      socket: { remoteAddress: "127.0.0.1" },
    }),
  ).toBe(true);
  expect(
    credentials.gitSecretTransportAllowed({
      socket: { remoteAddress: "192.168.1.2", encrypted: true },
    }),
  ).toBe(true);
});
it("explicit SSH generation returns its public identity without returning the generated private key", async () => {
  const saved = await credentials.generateGitCredential({
    name: "Generated",
    host: "github.com",
    hostKey: "ssh-ed25519 " + Buffer.alloc(32, 9).toString("base64"),
  });
  expect(saved.publicKey).toMatch(/^ssh-ed25519 /);
  expect(saved.fingerprint).toMatch(/^SHA256:/);
  expect(JSON.stringify(saved)).not.toContain("PRIVATE KEY");
  expect(
    (await fs.readdir(path.join(root, "credentials"))).some((file) =>
      file.startsWith(".generate-"),
    ),
  ).toBe(false);
  await credentials.deleteGitCredential(saved.id, saved.version);
});
it.each([
  "file:///etc/passwd",
  "ext::sh -c bad",
  "git://github.com/a/b",
  "http://github.com/a/b",
  "https://token@github.com/a/b",
  "https://github.com/a/b?token=secret",
  "ssh://-oProxyCommand=bad@github.com/a/b",
  "https://github.com/a/b#x",
])("rejects unsafe repository source %s", (repositoryUrl) => {
  expect(() => git.parseGitSource({ repositoryUrl })).toThrow();
});
it.each([
  "--upload-pack=evil",
  "main~1",
  "main..branch",
  "main@{1}",
  "branch.lock",
  "branch\nother",
])("rejects Git revision expressions/options %s", (ref) => {
  expect(() =>
    git.parseGitSource({ repositoryUrl: "https://github.com/a/b", ref }),
  ).toThrow();
});
it("requires explicit host and private-network administration and pins the checked DNS result", async () => {
  for (const address of [
    "127.0.0.1",
    "10.1.1.1",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
  ])
    expect(git.publicGitAddress(address)).toBe(false);
  expect(git.publicGitAddress("8.8.8.8")).toBe(true);
  const lookup = vi
    .fn()
    .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  await expect(
    git.resolveGitTarget(new URL("https://github.com/a/b"), lookup),
  ).rejects.toMatchObject({ code: "GIT_HOST_DENIED" });
  vi.stubEnv("STERRACODE_GIT_ALLOWED_HOSTS", "repo.test:8443");
  vi.stubEnv("STERRACODE_GIT_PRIVATE_HOSTS", "repo.test:8443");
  expect(
    await git.resolveGitTarget(new URL("https://repo.test:8443/a/b"), lookup),
  ).toEqual({ hostname: "repo.test", port: 8443, address: "127.0.0.1" });
  expect(lookup).toHaveBeenLastCalledWith("repo.test", {
    all: true,
    verbatim: true,
  });
});
it("the CONNECT proxy connects to the pinned address and rejects another host", async () => {
  const upstream = net.createServer((socket) =>
    socket.on("data", (data) => socket.write(data)),
  );
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await git.pinnedGitProxy({
    hostname: "unresolvable.invalid",
    address: "127.0.0.1",
    port: upstream.address().port,
  });
  const port = new URL(proxy.url).port;
  try {
    const answer = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: Number(port) });
      let output = "";
      socket.on("error", reject);
      socket.on("connect", () =>
        socket.write(
          `CONNECT unresolvable.invalid:${upstream.address().port} HTTP/1.1\r\nHost: unresolvable.invalid\r\n\r\n`,
        ),
      );
      socket.on("data", (data) => {
        output += data.toString();
        if (output.includes("200") && !output.includes("echo-marker"))
          socket.write("echo-marker");
        if (output.includes("echo-marker")) {
          socket.destroy();
          resolve(output);
        }
      });
    });
    expect(answer).toContain("echo-marker");
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: Number(port) });
      socket.on("error", reject);
      socket.on("connect", () =>
        socket.write("CONNECT evil.invalid:443 HTTP/1.1\r\n\r\n"),
      );
      socket.on("close", resolve);
    });
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
it("materializes only selected immutable blobs and honors root mapping without copying .git", async () => {
  const directory = path.join(root, "snapshot"),
    repo = path.join(directory, "repository"),
    destination = path.join(root, "published");
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(destination);
  await execute("git", ["init", "--bare", repo], { windowsHide: true });
  const source = path.join(root, "source.bin"),
    bytes = Buffer.from([1, 0, 2, 255]);
  await fs.writeFile(source, bytes);
  const { stdout } = await execute(
    "git",
    ["-C", repo, "hash-object", "-w", source],
    { windowsHide: true },
  );
  const entry = {
    path: "root/source.bin",
    destinationPath: "source.bin",
    type: "file",
    oid: stdout.trim(),
    bytes: bytes.length,
  };
  await git.materializeGitSnapshot({
    directory,
    destination,
    entries: [entry],
  });
  expect(await fs.readFile(path.join(destination, "source.bin"))).toEqual(
    bytes,
  );
  expect(await fs.readdir(destination)).toEqual(["source.bin"]);
  await expect(
    git.materializeGitSnapshot({
      directory,
      destination,
      entries: [{ ...entry, destinationPath: "../escape" }],
    }),
  ).rejects.toBeTruthy();
});
