import fs from "node:fs/promises";
import path from "node:path";
import {
  randomBytes,
  createHash,
  timingSafeEqual,
  scrypt as scryptCallback,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const DAY = 86400000,
  IDLE = 14 * DAY,
  MAX_AGE = 90 * DAY;
export const SESSION_COOKIE = "sterracode.session";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const error = (message, status, code, metadata = {}) =>
  Object.assign(new Error(message), { status, code, ...metadata });
function sameHash(left, right) {
  const a = Buffer.from(String(left || ""), "hex"),
    b = Buffer.from(String(right || ""), "hex");
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}
function validatePassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 1024
  )
    throw error(
      "Das Passwort muss zwischen 12 und 1024 Zeichen lang sein.",
      400,
      "INVALID_PASSWORD",
      { messageKey: "serverFeature:auth.passwordLength", params: {} },
    );
}
async function passwordRecord(password) {
  validatePassword(password);
  const salt = randomBytes(32).toString("hex");
  const hash = Buffer.from(await scrypt(password, salt, 64)).toString("hex");
  return { algorithm: "scrypt", salt, hash };
}
async function passwordMatches(password, record) {
  if (
    typeof password !== "string" ||
    password.length > 1024 ||
    !record ||
    record.algorithm !== "scrypt"
  )
    return false;
  const candidate = Buffer.from(await scrypt(password, record.salt, 64));
  const expected = Buffer.from(record.hash, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}
async function read(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600);
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export function createAuthService({ dataDir, now = Date.now } = {}) {
  if (!dataDir) throw new Error("Auth benötigt ein Datenverzeichnis.");
  const authFile = path.join(dataDir, "auth.json"),
    setupFile = path.join(dataDir, "setup-key.json");
  let queue = Promise.resolve();
  const failures = new Map();
  const serial = (fn) => {
    const next = queue.catch(() => {}).then(fn);
    queue = next;
    return next;
  };
  function throttle(ip) {
    const stamp = now(),
      recent = (failures.get(ip) || []).filter((t) => stamp - t < 15 * 60000);
    if (recent.length >= 8)
      throw error(
        "Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.",
        429,
        "AUTH_RATE_LIMITED",
        { messageKey: "serverFeature:auth.rateLimited", params: {} },
      );
    recent.push(stamp);
    failures.set(ip, recent);
    if (failures.size > 10000) failures.delete(failures.keys().next().value);
  }
  function issue(record) {
    const token = randomBytes(32).toString("base64url"),
      stamp = now();
    record.sessions = (record.sessions || [])
      .filter((s) => s.expiresAt > stamp && s.absoluteExpiresAt > stamp)
      .slice(-49);
    record.sessions.push({
      hash: digest(token),
      createdAt: stamp,
      lastUsedAt: stamp,
      expiresAt: stamp + IDLE,
      absoluteExpiresAt: stamp + MAX_AGE,
    });
    return token;
  }
  async function status() {
    return { setupRequired: !(await read(authFile)) };
  }
  return {
    status,
    createSetupKey: ({ reset = false } = {}) =>
      serial(async () => {
        if (await read(authFile)) {
          if (!reset) return null;
          // Reset is an offline administrator operation. Keep the old password hash
          // out of service immediately and revoke every browser session.
          await fs.rm(authFile, { force: true });
        }
        const token = randomBytes(32).toString("base64url"),
          stamp = now();
        await write(setupFile, {
          version: 1,
          hash: digest(token),
          createdAt: stamp,
          expiresAt: stamp + 30 * 60000,
        });
        return token;
      }),
    setup: ({ setupKey, password }, ip = "unknown") =>
      serial(async () => {
        throttle(ip);
        if (await read(authFile))
          throw error(
            "Die Einrichtung ist bereits abgeschlossen.",
            409,
            "SETUP_COMPLETE",
            { messageKey: "serverFeature:auth.setupComplete", params: {} },
          );
        const key = await read(setupFile);
        if (
          !key ||
          key.expiresAt <= now() ||
          typeof setupKey !== "string" ||
          !sameHash(digest(setupKey), key.hash)
        )
          throw error(
            "Einrichtungsschlüssel ist ungültig oder abgelaufen.",
            401,
            "INVALID_SETUP_KEY",
            { messageKey: "serverFeature:auth.invalidSetupKey", params: {} },
          );
        const record = {
          version: 1,
          password: await passwordRecord(password),
          sessions: [],
        };
        const token = issue(record);
        await write(authFile, record);
        await fs.rm(setupFile, { force: true });
        failures.delete(ip);
        return token;
      }),
    initializePassword: (password) =>
      serial(async () => {
        if (await read(authFile)) return false;
        await write(authFile, {
          version: 1,
          password: await passwordRecord(password),
          sessions: [],
        });
        await fs.rm(setupFile, { force: true });
        return true;
      }),
    login: ({ password }, ip = "unknown") =>
      serial(async () => {
        throttle(ip);
        const record = await read(authFile);
        if (!record)
          throw error(
            "Bitte zuerst die Einrichtung abschließen.",
            401,
            "SETUP_REQUIRED",
            { messageKey: "serverFeature:auth.setupRequired", params: {} },
          );
        if (!(await passwordMatches(password, record.password)))
          throw error("Ungültiges Passwort.", 401, "INVALID_CREDENTIALS", {
            messageKey: "serverFeature:auth.invalidPassword",
            params: {},
          });
        const token = issue(record);
        await write(authFile, record);
        failures.delete(ip);
        return token;
      }),
    authenticate: (token) =>
      serial(async () => {
        if (!token || typeof token !== "string" || token.length > 256)
          return false;
        const record = await read(authFile),
          stamp = now(),
          hash = digest(token);
        const session = record?.sessions?.find((s) => sameHash(s.hash, hash));
        if (
          !session ||
          session.expiresAt <= stamp ||
          session.absoluteExpiresAt <= stamp
        )
          return false;
        session.lastUsedAt = stamp;
        session.expiresAt = Math.min(stamp + IDLE, session.absoluteExpiresAt);
        await write(authFile, record);
        return true;
      }),
    logout: (token) =>
      serial(async () => {
        const record = await read(authFile);
        if (!record) return;
        record.sessions = (record.sessions || []).filter(
          (s) => !sameHash(s.hash, digest(token || "")),
        );
        await write(authFile, record);
      }),
    changePassword: ({ currentPassword, password }) =>
      serial(async () => {
        const record = await read(authFile);
        if (!(await passwordMatches(currentPassword, record?.password)))
          throw error(
            "Das bisherige Passwort ist ungültig.",
            401,
            "INVALID_CREDENTIALS",
            {
              messageKey: "serverFeature:auth.invalidCurrentPassword",
              params: {},
            },
          );
        record.password = await passwordRecord(password);
        record.sessions = [];
        const token = issue(record);
        await write(authFile, record);
        return token;
      }),
  };
}

export function sessionToken(req) {
  const part = (req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${SESSION_COOKIE}=`));
  return part ? part.slice(SESSION_COOKIE.length + 1) : null;
}
