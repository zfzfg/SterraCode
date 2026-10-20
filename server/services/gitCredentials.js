import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  AppError,
  DATA_DIR,
  readJSON,
  writeJSON,
  serial,
  validateSessionId,
} from "./storage.js";

const directory = path.join(DATA_DIR, "credentials");
const database = path.join(directory, "git.json");
const unlocks = new Map();
const generations = new Set();
let recovery;
const execute = promisify(execFile);
export const gitError = (key, code = "GIT_INVALID_REQUEST", status = 400) =>
  new AppError("Git operation could not be completed.", status, code, {
    messageKey: `serverFeature:git.${key}`,
    params: {},
  });

async function records() {
  await initializeGitCredentials();
  try {
    const value = await readJSON(database);
    if (value.schemaVersion !== 1 || !Array.isArray(value.credentials))
      throw gitError("storage", "GIT_CREDENTIAL_STORAGE", 503);
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, credentials: [] };
    throw error;
  }
}
export function initializeGitCredentials() {
  return (recovery ||= (async () => {
    let names;
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw gitError("storage", "GIT_CREDENTIAL_STORAGE", 503);
    }
    for (const name of names.filter((v) =>
      /^\.generate-[a-f0-9-]{36}$/i.test(v),
    )) {
      const temporary = path.join(directory, name);
      if (!generations.has(temporary))
        await fs.rm(temporary, { recursive: true, force: true });
    }
  })());
}
async function key({ create = false } = {}) {
  const file =
    process.env.STERRACODE_GIT_KEY_FILE || path.join(directory, ".git-key");
  try {
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (process.platform !== "win32" && stat.mode & 0o077)
    )
      throw gitError("key", "GIT_KEY_UNAVAILABLE", 503);
    const value = await fs.readFile(file);
    if (value.length !== 32) throw gitError("key", "GIT_KEY_UNAVAILABLE", 503);
    return value;
  } catch (error) {
    if (
      error.code !== "ENOENT" ||
      !create ||
      process.env.STERRACODE_GIT_KEY_FILE
    )
      throw gitError("key", "GIT_KEY_UNAVAILABLE", 503);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const value = randomBytes(32);
    await fs.writeFile(file, value, { mode: 0o600, flag: "wx" });
    return value;
  }
}
function metadata(record) {
  const { sealed, ...publicFields } = record;
  return publicFields;
}
function associated(record) {
  return Buffer.from(
    JSON.stringify([
      record.id,
      record.version,
      record.host,
      record.port,
      record.type,
      record.repositoryPrefix,
      record.username,
    ]),
  );
}
function seal(secret, record, master) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", master, iv);
  cipher.setAAD(associated(record));
  return {
    version: 1,
    iv: iv.toString("base64"),
    value: Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]).toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
function open(record, master) {
  try {
    if (record.sealed.version !== 1) throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      master,
      Buffer.from(record.sealed.iv, "base64"),
    );
    decipher.setAAD(associated(record));
    decipher.setAuthTag(Buffer.from(record.sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(record.sealed.value, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw gitError("key", "GIT_KEY_UNAVAILABLE", 503);
  }
}
export function normalizeGitHost(value) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9.-]+$/.test(value) ||
    value.startsWith(".") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.length > 253
  )
    throw gitError("host");
  return value.toLowerCase();
}
function validate(input) {
  if (
    !input ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 100 ||
    /[\x00-\x1f\x7f]/.test(input.name) ||
    !["https-token", "ssh-key"].includes(input.type)
  )
    throw gitError("credential");
  const host = normalizeGitHost(input.host),
    port = input.port || (input.type === "ssh-key" ? 22 : 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw gitError("host");
  const username = input.username || (input.type === "ssh-key" ? "git" : "git");
  if (!/^[a-zA-Z0-9_.@+-]{1,100}$/.test(username) || username.startsWith("-"))
    throw gitError("credential");
  const repositoryPrefix = input.repositoryPrefix || "/";
  if (
    typeof repositoryPrefix !== "string" ||
    !repositoryPrefix.startsWith("/") ||
    /[\x00-\x20\x7f?#\\]/.test(repositoryPrefix) ||
    repositoryPrefix.split("/").some((p) => p === "." || p === "..")
  )
    throw gitError("credential");
  if (
    typeof input.secret !== "string" ||
    !input.secret ||
    input.secret.length > 65536 ||
    (input.type === "https-token" && /[\r\n\0]/.test(input.secret))
  )
    throw gitError("credential");
  let hostKey = null,
    publicKey = null,
    fingerprint = null,
    hostFingerprint = null,
    encryptedKey = false;
  if (input.type === "ssh-key") {
    if (
      !/^-----BEGIN (?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+-----END (?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----\s*$/.test(
        input.secret,
      )
    )
      throw gitError("credential");
    if (
      typeof input.hostKey !== "string" ||
      !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}$/.test(
        input.hostKey,
      )
    )
      throw gitError("hostKey");
    hostKey = input.hostKey;
    hostFingerprint =
      "SHA256:" +
      createHash("sha256")
        .update(Buffer.from(hostKey.split(" ")[1], "base64"))
        .digest("base64")
        .replace(/=+$/, "");
    try {
      let publicBlob;
      const sshString = (value) => {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        return Buffer.concat([length, bytes]);
      };
      if (input.secret.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")) {
        const blob = Buffer.from(
          input.secret.replace(/-----[^\r\n]+-----|\s/g, ""),
          "base64",
        );
        let offset = 15;
        if (blob.subarray(0, offset).toString() !== "openssh-key-v1\0")
          throw new Error();
        const next = () => {
          if (offset + 4 > blob.length) throw new Error();
          const size = blob.readUInt32BE(offset);
          offset += 4;
          if (offset + size > blob.length) throw new Error();
          const value = blob.subarray(offset, offset + size);
          offset += size;
          return value;
        };
        encryptedKey = next().toString() !== "none";
        next();
        next();
        if (blob.readUInt32BE(offset) !== 1) throw new Error();
        offset += 4;
        publicBlob = next();
        if (!next().length || offset !== blob.length) throw new Error();
      } else {
        encryptedKey = /ENCRYPTED|Proc-Type: 4,ENCRYPTED/.test(input.secret);
        const jwk = createPublicKey(
          createPrivateKey({
            key: input.secret,
            ...(input.passphrase ? { passphrase: input.passphrase } : {}),
          }),
        ).export({ format: "jwk" });
        const bytes = (v) => Buffer.from(v, "base64url");
        const mpint = (v) => {
          const n = bytes(v);
          return sshString(
            n[0] & 0x80 ? Buffer.concat([Buffer.from([0]), n]) : n,
          );
        };
        if (jwk.kty === "OKP" && jwk.crv === "Ed25519")
          publicBlob = Buffer.concat([
            sshString("ssh-ed25519"),
            sshString(bytes(jwk.x)),
          ]);
        else if (jwk.kty === "RSA")
          publicBlob = Buffer.concat([
            sshString("ssh-rsa"),
            mpint(jwk.e),
            mpint(jwk.n),
          ]);
        else if (jwk.kty === "EC") {
          const curve = {
            "P-256": "nistp256",
            "P-384": "nistp384",
            "P-521": "nistp521",
          }[jwk.crv];
          if (!curve) throw new Error();
          publicBlob = Buffer.concat([
            sshString(`ecdsa-sha2-${curve}`),
            sshString(curve),
            sshString(
              Buffer.concat([Buffer.from([4]), bytes(jwk.x), bytes(jwk.y)]),
            ),
          ]);
        } else throw new Error();
      }
      const algorithm = publicBlob
        .subarray(4, 4 + publicBlob.readUInt32BE(0))
        .toString("ascii");
      if (
        !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(
          algorithm,
        )
      )
        throw new Error();
      publicKey = algorithm + " " + publicBlob.toString("base64");
      fingerprint =
        "SHA256:" +
        createHash("sha256")
          .update(publicBlob)
          .digest("base64")
          .replace(/=+$/, "");
    } catch {
      throw gitError("credential");
    }
  }
  return {
    name: input.name.trim(),
    host,
    port,
    type: input.type,
    username,
    repositoryPrefix,
    ...(hostKey
      ? { hostKey, hostFingerprint, publicKey, fingerprint, encryptedKey }
      : {}),
  };
}
export async function listGitCredentials() {
  return {
    credentials: (await records()).credentials.map(metadata),
    storage: {
      keySource: process.env.STERRACODE_GIT_KEY_FILE ? "external" : "local",
      backupWarning: true,
    },
  };
}
export async function saveGitCredential(
  input,
  id = null,
  expectedVersion = null,
) {
  return serial("git-credentials", async () => {
    const fields = validate(input),
      store = await records();
    const current = id
      ? store.credentials.find((c) => c.id === validateSessionId(id))
      : null;
    if (id && !current) throw gitError("notFound", "NOT_FOUND", 404);
    if (current && current.version !== expectedVersion)
      throw gitError("conflict", "CONFLICT", 409);
    const master = await key({ create: !store.credentials.length });
    const now = new Date().toISOString();
    const record = {
      ...fields,
      id: id || randomUUID(),
      version: (current?.version || 0) + 1,
      createdAt: current?.createdAt || now,
      updatedAt: now,
    };
    record.sealed = seal(input.secret, record, master);
    store.credentials = [
      ...store.credentials.filter((c) => c.id !== record.id),
      record,
    ];
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await writeJSON(database, store);
    if (record.type === "ssh-key" && record.encryptedKey && input.passphrase)
      await unlockGitCredential(record.id, input.passphrase, record.version);
    return metadata(record);
  });
}
export async function deleteGitCredential(id, expectedVersion) {
  return serial("git-credentials", async () => {
    validateSessionId(id);
    const store = await records(),
      current = store.credentials.find((c) => c.id === id);
    if (!current) throw gitError("notFound", "NOT_FOUND", 404);
    if (current.version !== expectedVersion)
      throw gitError("conflict", "CONFLICT", 409);
    store.credentials = store.credentials.filter((c) => c.id !== id);
    unlocks.delete(id);
    await writeJSON(database, store);
    return { ok: true };
  });
}
export async function generateGitCredential(input) {
  const temporary = path.join(directory, `.generate-${randomUUID()}`);
  await initializeGitCredentials();
  generations.add(temporary);
  try {
    await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
    const identity = path.join(temporary, "identity");
    try {
      await execute(
        "ssh-keygen",
        ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", identity],
        {
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 4096,
          env: {
            PATH: process.env.PATH || process.env.Path,
            ...(process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
            ...(process.platform === "win32" && process.env.ProgramData
              ? { ProgramData: process.env.ProgramData }
              : {}),
          },
        },
      );
    } catch {
      throw gitError("unavailable", "GIT_UNAVAILABLE", 503);
    }
    return await saveGitCredential({
      ...input,
      type: "ssh-key",
      secret: await fs.readFile(identity, "utf8"),
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
    generations.delete(temporary);
  }
}
export async function unlockGitCredential(id, passphrase, expectedVersion) {
  validateSessionId(id);
  const record = (await records()).credentials.find((c) => c.id === id);
  if (!record) throw gitError("notFound", "NOT_FOUND", 404);
  if (record.version !== expectedVersion)
    throw gitError("conflict", "CONFLICT", 409);
  if (
    record.type !== "ssh-key" ||
    typeof passphrase !== "string" ||
    !passphrase ||
    passphrase.length > 4096 ||
    /[\r\n\0]/.test(passphrase)
  )
    throw gitError("credential");
  unlocks.set(id, {
    version: record.version,
    passphrase,
    expiresAt: Date.now() + 300000,
  });
  const timer = setTimeout(() => {
    if (unlocks.get(id)?.expiresAt < Date.now()) unlocks.delete(id);
  }, 300001);
  timer.unref?.();
  return { ok: true, expiresInSeconds: 300, oneUse: true };
}
// Backend-only. Callers must never serialize this result or send it to a runner/model.
export async function useGitCredential(id, source) {
  if (!id) return null;
  validateSessionId(id);
  const record = (await records()).credentials.find((c) => c.id === id);
  if (!record) throw gitError("notFound", "NOT_FOUND", 404);
  if (
    record.host !== source.hostname ||
    record.port !==
      Number(source.port || (source.protocol === "ssh:" ? 22 : 443)) ||
    (record.type === "ssh-key") !== (source.protocol === "ssh:") ||
    !(
      source.pathname === record.repositoryPrefix ||
      source.pathname.startsWith(
        record.repositoryPrefix.endsWith("/")
          ? record.repositoryPrefix
          : record.repositoryPrefix + "/",
      )
    )
  )
    throw gitError("binding", "GIT_CREDENTIAL_HOST_MISMATCH", 403);
  const unlock = unlocks.get(id);
  unlocks.delete(id);
  return {
    ...metadata(record),
    secret: open(record, await key()),
    ...(unlock &&
    unlock.version === record.version &&
    unlock.expiresAt > Date.now()
      ? { passphrase: unlock.passphrase }
      : {}),
  };
}
export function gitSecretTransportAllowed(req) {
  const remote = req.socket?.remoteAddress;
  return (
    req.secure === true ||
    req.socket?.encrypted === true ||
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)
  );
}
