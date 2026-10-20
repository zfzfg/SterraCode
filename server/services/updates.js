import fs from "node:fs/promises";
import path from "node:path";
import {
  latestRelease,
  compareVersions,
  validateRelease,
} from "../../shared/releases.js";
import { AppError } from "./storage.js";

export const applicationVersion = JSON.parse(
  await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"),
).version;
const unavailable = () =>
  new AppError("Update service unavailable.", 503, "UPDATE_UNAVAILABLE", {
    messageKey: "updates:error",
    params: {},
  });
export function createUpdateService(
  config,
  { fetcher = fetch, discover = latestRelease } = {},
) {
  const base = process.env.STERRACODE_UPDATER_URL;
  let release = null,
    checkedAt = 0,
    error = null,
    checking = null;
  const cacheFile = path.join(config.dataDir, "release-check.json");
  const status = () => ({
    installed: applicationVersion,
    managed: false,
    latest: release?.version || null,
    available: Boolean(
      release && compareVersions(release.version, applicationVersion) > 0,
    ),
    installable: false,
    notesURL: release?.notesURL || null,
    checkedAt,
    error,
    installURL: "https://sterra.online/code-install/",
    operation: null,
    settings: null,
  });
  async function proxy(route, method = "GET", body) {
    try {
      const secret = (
        await fs.readFile(process.env.STERRACODE_UPDATER_SECRET_FILE, "utf8")
      ).trim();
      const response = await fetcher(new URL(route, base), {
        method,
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(45000),
      });
      const value = await response.json();
      if (!response.ok) throw unavailable();
      return value;
    } catch {
      throw unavailable();
    }
  }
  async function check(force = false) {
    if (base) return proxy("/check", "POST");
    if (checking) return checking;
    if (
      !force &&
      Date.now() - checkedAt < (error ? 15 * 60000 : 6 * 60 * 60000)
    )
      return status();
    checking = (async () => {
      try {
        release = await discover();
        error = null;
      } catch {
        error = "UPDATE_CHECK_UNAVAILABLE";
      }
      checkedAt = Date.now();
      try {
        await fs.writeFile(cacheFile, JSON.stringify({ release, checkedAt }), {
          mode: 0o600,
        });
      } catch {
        /* Discovery never prevents normal use. */
      }
      return status();
    })().finally(() => {
      checking = null;
    });
    return checking;
  }
  return {
    async start() {
      if (!base) {
        try {
          const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
          release = cached.release ? validateRelease(cached.release) : null;
          checkedAt = cached.checkedAt;
        } catch {
          /* First launch. */
        }
        await check();
      }
    },
    get: () => (base ? proxy("/status") : Promise.resolve(status())),
    check: () => check(true),
    install: () =>
      base ? proxy("/install", "POST") : Promise.reject(unavailable()),
    settings: (value) =>
      base ? proxy("/settings", "PATCH", value) : Promise.reject(unavailable()),
    activity: (value) =>
      base ? proxy("/activity", "POST", value) : Promise.resolve({ ok: true }),
    async internalAuthorized(header) {
      if (!base || !process.env.STERRACODE_UPDATER_SECRET_FILE) return false;
      const { timingSafeEqual } = await import("node:crypto");
      try {
        const expected = Buffer.from(
            `Bearer ${(await fs.readFile(process.env.STERRACODE_UPDATER_SECRET_FILE, "utf8")).trim()}`,
          ),
          actual = Buffer.from(header || "");
        return (
          actual.length === expected.length && timingSafeEqual(actual, expected)
        );
      } catch {
        return false;
      }
    },
    beginPolling() {
      const timer = setInterval(() => check().catch(() => {}), 15 * 60000);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
