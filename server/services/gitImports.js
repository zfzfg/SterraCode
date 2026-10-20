import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import dns from "node:dns/promises";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  gitError,
  normalizeGitHost,
  useGitCredential,
} from "./gitCredentials.js";
import { withSafeEntry, treeBytesSafe } from "./safeFiles.js";
import { normalizePath } from "./workspace.js";

const helper = fileURLToPath(new URL("./gitAskpass.cjs", import.meta.url));
const safeConfig = [
  "protocol.allow=never",
  "protocol.https.allow=always",
  "protocol.ssh.allow=always",
  "protocol.file.allow=never",
  "credential.helper=",
  "core.hooksPath=/dev/null",
  "core.autocrlf=false",
  "http.followRedirects=false",
  "http.sslVerify=true",
  "submodule.recurse=false",
  "fetch.recurseSubmodules=false",
  "filter.lfs.required=false",
  "credential.interactive=false",
  "gc.auto=0",
  "maintenance.auto=false",
];
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const gitArgs = (args) => [...safeConfig.flatMap((v) => ["-c", v]), ...args];
const repository = (directory) => path.join(directory, "repository");
function environment(directory, extra = {}) {
  return {
    PATH: process.env.PATH || process.env.Path || "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.platform === "win32" && process.env.ProgramData
      ? { ProgramData: process.env.ProgramData }
      : {}),
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ALLOW_PROTOCOL: "https:ssh",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    ...extra,
  };
}
export function parseGitSource(source) {
  const value = source?.repositoryUrl;
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\x00-\x20\x7f\\]/.test(value)
  )
    throw gitError("source");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw gitError("source");
  }
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === "https:" && url.username) ||
    (url.username && !/^[A-Za-z0-9_.+-]{1,100}$/.test(url.username)) ||
    url.username.startsWith("-")
  )
    throw gitError("source");
  normalizeGitHost(url.hostname);
  if (
    !url.pathname ||
    url.pathname === "/" ||
    /%2f|%5c|%00|%0[ad]/i.test(url.pathname) ||
    url.pathname.split("/").some((s) => {
      try {
        return [".", ".."].includes(decodeURIComponent(s));
      } catch {
        return true;
      }
    })
  )
    throw gitError("source");
  const ref = source.ref || null;
  if (
    ref !== null &&
    (typeof ref !== "string" ||
      ref.length > 200 ||
      ref.startsWith("-") ||
      ref.startsWith("/") ||
      ref.endsWith("/") ||
      ref.endsWith(".") ||
      ref.endsWith(".lock") ||
      /[\x00-\x20\x7f~^:?*[\\]/.test(ref) ||
      ref.includes("..") ||
      ref.includes("@{") ||
      ref.includes("//"))
  )
    throw gitError("ref");
  return { url, ref };
}
export function publicGitAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  return (
    net.isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(?:0*:|db8:|0?2[0-9a-f]:)/i.test(address) &&
    !/^2002:/i.test(address)
  );
}
export async function resolveGitTarget(url, lookup = dns.lookup) {
  const port = Number(url.port || (url.protocol === "ssh:" ? 22 : 443)),
    target = `${url.hostname}:${port}`;
  const allowed = (
    process.env.STERRACODE_GIT_ALLOWED_HOSTS ||
    "github.com:443,gitlab.com:443,bitbucket.org:443,github.com:22,gitlab.com:22,bitbucket.org:22"
  )
    .split(",")
    .map((v) => v.trim().toLowerCase());
  if (!allowed.includes(target)) throw gitError("host", "GIT_HOST_DENIED", 403);
  const privateAllowed = (process.env.STERRACODE_GIT_PRIVATE_HOSTS || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .includes(target);
  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw gitError("network", "GIT_NETWORK_FAILED", 503);
  }
  if (
    !addresses.length ||
    addresses.some(
      (v) =>
        !net.isIP(v.address) ||
        (!privateAllowed && !publicGitAddress(v.address)),
    )
  )
    throw gitError("host", "GIT_HOST_DENIED", 403);
  // The connection uses this exact address; Git/SSH never resolve it again.
  return { hostname: url.hostname, port, address: addresses[0].address };
}
export async function pinnedGitProxy(target) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(403);
    res.end();
  });
  server.on("connect", (req, client, head) => {
    if (req.url?.toLowerCase() !== `${target.hostname}:${target.port}`) {
      client.destroy();
      return;
    }
    const upstream = net.connect({ host: target.address, port: target.port });
    sockets.add(upstream);
    upstream.setTimeout(120000, () => upstream.destroy());
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
async function runGit(
  args,
  {
    directory,
    env,
    signal,
    limit = 32 * 1024 * 1024,
    timeout = 120000,
    output,
    diskBudget,
    prefixBytes,
    input,
  } = {},
) {
  if (signal?.aborted) throw gitError("cancelled", "IMPORT_CANCELLED", 409);
  return new Promise((resolve, reject) => {
    const child = spawn("git", gitArgs(args), {
      cwd: directory,
      env: env || environment(directory),
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (input) { child.stdin.on("error", () => {}); child.stdin.end(input); }
    const chunks = [];
    let size = 0,
      failure = null,
      prefixComplete = false;
    let forceTimer;
    const kill = (signal) => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/t", "/f"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("error", () => child.kill(signal));
      } else
        try {
          process.kill(-child.pid, signal);
        } catch {}
    };
    const stop = (error) => {
      failure ||= error;
      kill("SIGTERM");
      if (!forceTimer) {
        forceTimer = setTimeout(() => kill("SIGKILL"), 1500);
        forceTimer.unref?.();
      }
    };
    const abort = () => stop(gitError("cancelled", "IMPORT_CANCELLED", 409));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => stop(gitError("timeout", "GIT_TIMEOUT", 408)),
      timeout,
    );
    let checking = false;
    const budgetTimer = diskBudget
      ? setInterval(async () => {
          if (checking) return;
          checking = true;
          try {
            const stat = await fs.statfs(directory),
              occupied = await treeBytesSafe(diskBudget.directory);
            if (
              Number(stat.bavail) * Number(stat.bsize) <
                diskBudget.minFreeBytes ||
              occupied > diskBudget.maxBytes
            )
              stop(gitError("limit", "IMPORT_RESOURCE_LIMIT", 507));
          } catch (e) {
            if (e.code !== "ENOENT")
              stop(gitError("limit", "IMPORT_RESOURCE_LIMIT", 507));
          } finally {
            checking = false;
          }
        }, 500)
      : null;
    // Raw Git diagnostics can contain URLs, usernames or remote-controlled text.
    child.stderr.resume();
    const outputDone = output
      ? output(child.stdout).catch((e) => {
          stop(e);
          throw e;
        })
      : Promise.resolve();
    // Attach rejection immediately; close awaits the same promise below.
    outputDone.catch(() => {});
    if (!output)
      child.stdout.on("data", (chunk) => {
        if (prefixBytes) {
          const accepted = chunk.subarray(0, Math.max(0, prefixBytes - size));
          chunks.push(accepted);
          size += accepted.length;
          if (size >= prefixBytes && !prefixComplete) {
            prefixComplete = true;
            kill("SIGTERM");
            forceTimer = setTimeout(() => kill("SIGKILL"), 1500);
            forceTimer.unref?.();
          }
          return;
        }
        size += chunk.length;
        if (size > limit) stop(gitError("limit", "IMPORT_RESOURCE_LIMIT", 413));
        else chunks.push(chunk);
      });
    child.on("error", () => {
      failure = gitError("unavailable", "GIT_UNAVAILABLE", 503);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearInterval(budgetTimer);
      signal?.removeEventListener("abort", abort);
      try {
        await outputDone;
      } catch {}
      if (failure) reject(failure);
      else if (code !== 0 && !prefixComplete)
        reject(gitError("failed", "GIT_FETCH_FAILED", 422));
      else resolve(Buffer.concat(chunks));
    });
  });
}
export async function getGitImportCapabilities() {
  try {
    await runGit(["--version"], {
      directory: process.cwd(),
      limit: 1024,
      timeout: 10000,
    });
    const small = entries.filter((entry) => entry.type === "file" && entry.bytes <= 1024);
    for (let start = 0; start < small.length; start += 1000) {
      const batch = small.slice(start, start + 1000);
      const blobs = await runGit(["-C", repository(directory), "cat-file", "--batch"], { directory, signal, input: batch.map((entry) => entry.oid).join("\n") + "\n", limit: 2 * 1024 * 1024 });
      let offset = 0;
      for (const entry of batch) {
        const newline = blobs.indexOf(10, offset);
        if (newline < 0 || blobs.subarray(offset, newline).toString("ascii") !== `${entry.oid} blob ${entry.bytes}`) throw gitError("failed");
        const content = blobs.subarray(newline + 1, newline + 1 + entry.bytes).toString("utf8");
        offset = newline + 1 + entry.bytes + 1;
        const pointer = /^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n(?:ext-[^\n]*\r?\n)*oid sha256:[a-f0-9]{64}\r?\nsize (\d+)\r?\n?$/.exec(content);
        if (pointer) { entry.lfsPointer = true; entry.lfsObjectBytes = pointer[1]; warnings.push({ path: entry.path, code: "GIT_LFS_POINTER_NOT_DOWNLOADED" }); }
      }
    }
    return {
      available: true,
      protocols: ["https", "ssh"],
      allowedHosts: (
        process.env.STERRACODE_GIT_ALLOWED_HOSTS ||
        "github.com:443,gitlab.com:443,bitbucket.org:443,github.com:22,gitlab.com:22,bitbucket.org:22"
      ).split(","),
    };
  } catch {
    return { available: false, protocols: [], reasonCode: "GIT_UNAVAILABLE" };
  }
}
export async function inspectGitSnapshot({
  source,
  directory,
  signal,
  onProgress,
  budget = {},
}) {
  const { url, ref } = parseGitSource(source),
    target = await resolveGitTarget(url),
    credential = await useGitCredential(source.credentialId, url);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const privateDirectory = path.join(directory, ".git-private");
  await fs.mkdir(privateDirectory, { mode: 0o700 });
  let proxy;
  try {
    const extra = {};
    if (url.protocol === "https:") {
      proxy = await pinnedGitProxy(target);
      extra.https_proxy = proxy.url;
      extra.HTTPS_PROXY = proxy.url;
      if (credential) {
        const credentialFile = path.join(privateDirectory, "askpass.json");
        await fs.writeFile(
          credentialFile,
          JSON.stringify({
            host: url.host,
            username: credential.username,
            secret: credential.secret,
          }),
          { mode: 0o600, flag: "wx" },
        );
        const wrapper = path.join(
          privateDirectory,
          process.platform === "win32" ? "askpass.cmd" : "askpass",
        );
        await fs.writeFile(
          wrapper,
          process.platform === "win32"
            ? `@echo off\r\n"${process.execPath}" "${helper}" %*\r\n`
            : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(helper)} "$@"\n`,
          { mode: 0o700, flag: "wx" },
        );
        extra.GIT_ASKPASS = wrapper;
        extra.STERRACODE_GIT_ASKPASS_FILE = credentialFile;
      }
    } else {
      if (!credential || credential.type !== "ssh-key")
        throw gitError("hostKey", "GIT_HOST_KEY_REQUIRED", 403);
      const keyFile = path.join(privateDirectory, "identity"),
        knownHosts = path.join(privateDirectory, "known_hosts");
      await fs.writeFile(keyFile, credential.secret, {
        mode: 0o600,
        flag: "wx",
      });
      await fs.writeFile(
        knownHosts,
        `${target.port === 22 ? target.hostname : `[${target.hostname}]:${target.port}`} ${credential.hostKey}\n`,
        { mode: 0o600, flag: "wx" },
      );
      if (credential.passphrase) {
        const passphraseFile = path.join(privateDirectory, "askpass.json"),
          wrapper = path.join(
            privateDirectory,
            process.platform === "win32" ? "askpass.cmd" : "askpass",
          );
        await fs.writeFile(
          passphraseFile,
          JSON.stringify({
            type: "ssh",
            keyFile,
            secret: credential.passphrase,
          }),
          { mode: 0o600, flag: "wx" },
        );
        await fs.writeFile(
          wrapper,
          process.platform === "win32"
            ? `@echo off\r\n"${process.execPath}" "${helper}" %*\r\n`
            : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(helper)} "$@"\n`,
          { mode: 0o700, flag: "wx" },
        );
        extra.SSH_ASKPASS = wrapper;
        extra.SSH_ASKPASS_REQUIRE = "force";
        extra.DISPLAY = "sterracode-import";
        extra.STERRACODE_GIT_ASKPASS_FILE = passphraseFile;
      }
      const ssh = [
        "ssh",
        "-F",
        process.platform === "win32" ? "NUL" : "/dev/null",
        "-o",
        `BatchMode=${credential.passphrase ? "no" : "yes"}`,
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${knownHosts}`,
        "-o",
        `GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "IdentityAgent=none",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "ProxyCommand=none",
        "-o",
        "ProxyJump=none",
        "-o",
        `HostKeyAlias=${target.port === 22 ? target.hostname : `[${target.hostname}]:${target.port}`}`,
        "-o",
        `HostName=${target.address}`,
        "-p",
        String(target.port),
        "-l",
        credential.username,
        "-i",
        keyFile,
      ];
      extra.GIT_SSH_COMMAND = ssh.map(quote).join(" ");
    }
    const env = environment(privateDirectory, extra);
    await onProgress?.({ phase: "fetching" });
    await runGit(
      [
        ...(proxy ? ["-c", `http.proxy=${proxy.url}`] : []),
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--no-tags",
        "--no-checkout",
        "--template=",
        ...(ref ? ["--branch", ref] : []),
        "--",
        url.href,
        repository(directory),
      ],
      {
        directory,
        env,
        signal,
        timeout: 300000,
        diskBudget: {
          directory: repository(directory),
          maxBytes: budget.maxBytes || 8 * 1024 ** 3,
          minFreeBytes: 128 * 1024 ** 2,
        },
      },
    );
    const commit = (
      await runGit(
        ["-C", repository(directory), "rev-parse", "--verify", "HEAD^{commit}"],
        { directory, signal, limit: 100 },
      )
    )
      .toString("ascii")
      .trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw gitError("failed");
    const raw = await runGit(
      [
        "-C",
        repository(directory),
        "ls-tree",
        "-r",
        "-l",
        "-z",
        "--full-tree",
        commit,
      ],
      { directory, signal, limit: budget.maxManifestBytes || 64 * 1024 * 1024 },
    );
    const entries = [],
      warnings = [];
    for (const chunk of raw
      .subarray(0, raw.length - (raw.at(-1) === 0 ? 1 : 0))
      .toString("binary")
      .split("\0")) {
      if (!chunk) continue;
      const tab = chunk.indexOf("\t"),
        fields = chunk.slice(0, tab).trim().split(/ +/),
        name = Buffer.from(chunk.slice(tab + 1), "binary");
      let filename;
      try {
        filename = new TextDecoder("utf-8", { fatal: true }).decode(name);
      } catch {
        throw gitError("path", "GIT_PATH_UNSUPPORTED", 422);
      }
      const [mode, , oid, bytes] = fields;
      const type =
        mode === "160000"
          ? "submodule"
          : mode === "120000"
            ? "symlink"
            : /^(?:100644|100755)$/.test(mode)
              ? "file"
              : "unsupported";
      if (type !== "file")
        warnings.push({
          path: filename,
          code:
            type === "submodule"
              ? "GIT_SUBMODULE_SKIPPED"
              : "GIT_SPECIAL_FILE_SKIPPED",
        });
      entries.push({
        path: filename,
        bytes: type === "file" ? Number(bytes) : 0,
        type,
        oid,
      });
      if (entries.length > (budget.maxEntries || 100000))
        throw gitError("limit", "IMPORT_RESOURCE_LIMIT", 413);
    }
    return {
      entries,
      warnings,
      source: {
        kind: "git",
        repositoryUrl: url.href,
        ref,
        commit,
        importedAt: new Date().toISOString(),
      },
    };
  } finally {
    if (credential) {
      credential.secret = "";
      credential.passphrase = "";
    }
    await proxy?.close();
    await fs.rm(privateDirectory, { recursive: true, force: true });
  }
}
export async function materializeGitSnapshot({
  directory,
  entries,
  destination,
  signal,
  onProgress,
}) {
  // This destination is the import service's private staging directory. The
  // caller validates every portable path and collision before invoking us.
  let completedBytes = 0;
  for (const entry of entries) {
    if (entry.type !== "file" || !/^[a-f0-9]{40,64}$/.test(entry.oid))
      throw gitError("path");
    const relative = normalizePath(entry.destinationPath || entry.path);
    const target = path.resolve(destination, ...relative.split("/"));
    if (
      path.relative(destination, target).startsWith("..") ||
      path.isAbsolute(path.relative(destination, target)) ||
      /[\\\x00]/.test(entry.path) ||
      entry.path.split("/").some((v) => !v || v === "." || v === "..")
    )
      throw gitError("path");
    let written = 0;
    await withSafeEntry(
      destination,
      relative,
      (full) =>
        runGit(["-C", repository(directory), "cat-file", "blob", entry.oid], {
          directory,
          signal,
          output: async (stream) => {
            stream.on("data", (chunk) => {
              written += chunk.length;
              if (written > entry.bytes)
                stream.destroy(gitError("limit", "IMPORT_RESOURCE_LIMIT", 413));
            });
            await pipeline(
              stream,
              createWriteStream(full, { mode: 0o660, flags: "wx" }),
            );
          },
        }),
      { parents: true },
    );
    if (written !== entry.bytes)
      throw gitError("failed", "GIT_BLOB_SIZE_MISMATCH", 422);
    completedBytes += written;
    await onProgress?.({ phase: "materializing", completedBytes });
  }
}
export async function readGitPreview({
  directory,
  entry,
  maxBytes = 65536,
  signal,
}) {
  if (entry.type !== "file" || !/^[a-f0-9]{40,64}$/.test(entry.oid))
    throw gitError("path");
  return runGit(["-C", repository(directory), "cat-file", "blob", entry.oid], {
    directory,
    signal,
    prefixBytes: Math.max(1, Math.min(65536, maxBytes)),
    timeout: 10000,
  });
}
