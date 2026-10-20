import { beforeAll, afterAll, describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { loadConfig } from "../server/config.js";
import { createAuthService } from "../server/services/auth.js";

let temp, createApp, storage;
const running = [];
beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "sterracode-auth-"));
  process.env.STERRACODE_DATA_DIR = temp;
  storage = await import("../server/services/storage.js");
  await storage.ensureDataDirs();
  ({ createApp } = await import("../server/app.js"));
});
afterAll(async () => {
  await Promise.all(
    running.map((server) => new Promise((resolve) => server.close(resolve))),
  );
  delete process.env.STERRACODE_DATA_DIR;
  await fs.rm(temp, { recursive: true, force: true });
});
async function instance(overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(temp, "instance-"));
  const config = loadConfig({
    STERRACODE_MODE: "docker",
    STERRACODE_PUBLIC_URL: "http://192.168.1.10:3000",
    STERRACODE_DATA_DIR: dataDir,
    ...overrides,
  });
  const auth = createAuthService({ dataDir });
  const app = createApp({ config, auth });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  running.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (
    endpoint,
    { method = "GET", body, headers = {} } = {},
  ) => {
    return new Promise((resolve, reject) => {
      const request = http.request(
        url + endpoint,
        {
          method,
          headers: {
            host: "192.168.1.10:3000",
            ...(body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
            ...headers,
          },
        },
        (response) => {
          let raw = "";
          response.setEncoding("utf8");
          response.on("data", (part) => (raw += part));
          response.on("end", () => {
            const cookie = response.headers["set-cookie"]?.at(-1);
            resolve({
              response: {
                status: response.statusCode,
                headers: {
                  get: (name) =>
                    name === "set-cookie" ? cookie : response.headers[name],
                },
              },
              data: JSON.parse(raw),
              cookie: cookie?.split(";")[0],
            });
          });
        },
      );
      request.on("error", reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  return { call, auth, dataDir, app };
}
describe("server configuration", () => {
  it("protects update actions and only accepts the updater service credential for draining", async () => {
    const { call, auth, app } = await instance();
    for (const [endpoint, method] of [
      ["/api/updates", "GET"],
      ["/api/updates/check", "POST"],
      ["/api/updates/install", "POST"],
      ["/api/updates/settings", "PATCH"],
    ]) {
      expect(
        (
          await call(endpoint, {
            method,
            ...(method === "GET" ? {} : { body: {} }),
          })
        ).response.status,
      ).toBe(401);
    }
    expect(
      (
        await call("/internal/updates", {
          method: "POST",
          body: { action: "drain" },
        })
      ).response.status,
    ).toBe(401);
    app.locals.updates.internalAuthorized = async (value) =>
      value === "Bearer test-service-key";
    const setupKey = await auth.createSetupKey();
    const setup = await call("/api/setup", {
      method: "POST",
      body: { setupKey, password: "update-password-1234" },
    });
    const headers = { cookie: setup.cookie };
    expect((await call("/api/updates", { headers })).data.managed).toBe(false);
    expect(
      (
        await call("/api/updates/install", {
          method: "POST",
          body: {},
          headers: { ...headers, origin: "http://attacker.invalid" },
        })
      ).response.status,
    ).toBe(403);
    const drain = await call("/internal/updates", {
      method: "POST",
      body: { action: "drain" },
      headers: { authorization: "Bearer test-service-key" },
    });
    expect(drain.response.status).toBe(200);
    expect(
      (await call("/api/chat/settings", { method: "PATCH", body: {}, headers }))
        .response.status,
    ).toBe(503);
    expect((await call("/api/updates", { headers })).response.status).toBe(200);
    expect((await call("/api/health")).data).toEqual({ ok: true });
    await call("/internal/updates", {
      method: "POST",
      body: { action: "resume" },
      headers: { authorization: "Bearer test-service-key" },
    });
  });
  it("keeps npm local and Docker on the fixed internal listen address", () => {
    expect(loadConfig({}).authRequired).toBe(false);
    const config = loadConfig({
      STERRACODE_MODE: "docker",
      STERRACODE_PORT: "4789",
      STERRACODE_PUBLIC_URL: "http://192.168.1.1:4789",
    });
    expect(config).toMatchObject({
      port: 3000,
      bindAddress: "0.0.0.0",
      authRequired: true,
    });
  });
  it.each([
    "http://host/subpath",
    "https://user:secret@host",
    "ftp://host",
    "http://host?x=1",
    "http://host/#x",
  ])("rejects invalid public URL %s", (value) => {
    expect(() => loadConfig({ STERRACODE_PUBLIC_URL: value })).toThrow(
      "Serverkonfiguration",
    );
  });
  it.each(["true", "0.0.0.0/0", "::/0", "*", "127.0.0.1/33"])(
    "rejects blanket proxy trust %s",
    (value) => {
      expect(() => loadConfig({ STERRACODE_TRUSTED_PROXIES: value })).toThrow(
        "Serverkonfiguration",
      );
    },
  );
  it("normalizes bracketed IPv6 hosts", () => {
    expect(
      loadConfig({
        STERRACODE_PUBLIC_URL: "http://[::1]:3000",
      }).allowedHosts.has("::1"),
    ).toBe(true);
  });
});
describe("protected HTTP setup and login", () => {
  it("schützt alle Vorschau-Routen durch die bestehende Authentifizierung", async () => {
    const { call } = await instance();
    const root =
      "/api/workspaces/00000000-0000-4000-8000-000000000000/preview-runs";
    for (const endpoint of [
      root + "/00000000-0000-4000-8000-000000000001",
      root + "/00000000-0000-4000-8000-000000000001/document",
    ]) {
      expect((await call(endpoint)).response.status).toBe(401);
    }
    expect(
      (await call(root, { method: "POST", body: {} })).response.status,
    ).toBe(401);
  });
  it("blocks new API work before shutdown while keeping minimal health available", async () => {
    const { call, auth, app } = await instance();
    const setupKey = await auth.createSetupKey();
    app.locals.beginMaintenance();
    expect(
      (
        await call("/api/setup", {
          method: "POST",
          body: { setupKey, password: "some-password-1234" },
        })
      ).data.code,
    ).toBe("SERVER_MAINTENANCE");
    expect((await auth.status()).setupRequired).toBe(true);
    expect((await call("/api/health")).data).toEqual({ ok: true });
  });
  it("serves minimal health independently of hosts, keeps all other APIs protected", async () => {
    const { call } = await instance();
    expect(
      (await call("/api/health", { headers: { host: "not-allowed.invalid" } }))
        .data,
    ).toEqual({ ok: true });
    expect((await call("/api/setup/status")).data).toEqual({
      authRequired: true,
      setupRequired: true,
      authenticated: false,
    });
    expect((await call("/api/chat/settings")).data.code).toBe("SETUP_REQUIRED");
    expect((await call("/api/runtimes")).response.status).toBe(401);
    expect((await call("/api/provider/credentials")).response.status).toBe(401);
    expect(
      (
        await call("/api/provider/credentials", {
          method: "PATCH",
          body: { provider: "openai", apiKey: "sk-protected-secret" },
        })
      ).response.status,
    ).toBe(401);
    expect(
      (await call("/api/provider/test", { method: "POST", body: {} })).response
        .status,
    ).toBe(401);
    expect(
      (await call("/api/setup/status", { headers: { host: "bad.invalid" } }))
        .data.code,
    ).toBe("HOST_DENIED");
  });
  it("requires JSON and same origin even before setup", async () => {
    const { call } = await instance();
    expect((await call("/api/setup", { method: "POST" })).response.status).toBe(
      415,
    );
    expect(
      (
        await call("/api/setup", {
          method: "POST",
          body: {},
          headers: { origin: "http://attacker.invalid" },
        })
      ).data.code,
    ).toBe("ORIGIN_DENIED");
  });
  it("consumes the key, stores only hashes, refreshes cookies and revokes sessions", async () => {
    const { call, auth, dataDir } = await instance();
    const setupKey = await auth.createSetupKey();
    expect(
      await fs.readFile(path.join(dataDir, "setup-key.json"), "utf8"),
    ).not.toContain(setupKey);
    expect(
      (
        await call("/api/setup", {
          method: "POST",
          body: { setupKey: "wrong", password: "some-password-1234" },
        })
      ).data.code,
    ).toBe("INVALID_SETUP_KEY");
    const setup = await call("/api/setup", {
      method: "POST",
      body: { setupKey, password: "some-password-1234" },
    });
    expect(setup.data).toEqual({ ok: true });
    expect(setup.response.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(setup.response.headers.get("set-cookie")).toMatch(/SameSite=Lax/);
    expect(setup.response.headers.get("set-cookie")).not.toContain("Secure");
    const disk = await fs.readFile(path.join(dataDir, "auth.json"), "utf8");
    expect(disk).not.toContain("some-password-1234");
    expect(disk).not.toContain(setup.cookie.split("=")[1]);
    await expect(
      fs.access(path.join(dataDir, "setup-key.json")),
    ).rejects.toThrow();
    expect(await auth.createSetupKey()).toBe(null);
    expect(
      (await call("/api/server", { headers: { cookie: setup.cookie } }))
        .response.status,
    ).toBe(200);
    expect(
      (
        await call("/api/login", {
          method: "POST",
          body: { password: "wrong" },
        })
      ).response.status,
    ).toBe(401);
    const login = await call("/api/login", {
      method: "POST",
      body: { password: "some-password-1234" },
    });
    const change = await call("/api/auth/password", {
      method: "PATCH",
      body: {
        currentPassword: "some-password-1234",
        password: "a-different-password",
      },
      headers: { cookie: login.cookie },
    });
    expect(change.data.ok).toBe(true);
    expect(
      (await call("/api/server", { headers: { cookie: setup.cookie } }))
        .response.status,
    ).toBe(401);
    expect(
      (await call("/api/server", { headers: { cookie: login.cookie } }))
        .response.status,
    ).toBe(401);
    expect(
      (await call("/api/server", { headers: { cookie: change.cookie } }))
        .response.status,
    ).toBe(200);
    await call("/api/logout", {
      method: "POST",
      body: {},
      headers: { cookie: change.cookie },
    });
    expect(
      (await call("/api/server", { headers: { cookie: change.cookie } }))
        .response.status,
    ).toBe(401);
  });
  it("trusts forwarded protocol only from the configured proxy", async () => {
    const untrusted = await instance({
      STERRACODE_PUBLIC_URL: "https://192.168.1.10:3000",
      STERRACODE_TRUSTED_PROXIES: "192.168.99.1",
    });
    const request = {
      headers: {
        origin: "https://192.168.1.10:3000",
        "x-forwarded-proto": "https",
      },
    };
    expect((await untrusted.call("/api/setup/status", request)).data.code).toBe(
      "ORIGIN_DENIED",
    );
    const trusted = await instance({
      STERRACODE_PUBLIC_URL: "https://192.168.1.10:3000",
      STERRACODE_TRUSTED_PROXIES: "127.0.0.1/32",
    });
    expect(
      (await trusted.call("/api/setup/status", request)).response.status,
    ).toBe(200);
    const key = await trusted.auth.createSetupKey();
    const result = await trusted.call("/api/setup", {
      method: "POST",
      body: { setupKey: key, password: "some-password-1234" },
      headers: request.headers,
    });
    expect(result.response.headers.get("set-cookie")).toContain("Secure");
  });
  it("returns only provider credential metadata after authenticated key updates", async () => {
    const { call, auth } = await instance();
    const setupKey = await auth.createSetupKey();
    const setup = await call("/api/setup", {
      method: "POST",
      body: { setupKey, password: "some-password-1234" },
    });
    const saved = await call("/api/provider/credentials", {
      method: "PATCH",
      body: { provider: "openai", apiKey: "sk-authenticated-private-secret" },
      headers: { cookie: setup.cookie },
    });
    expect(saved.data).toEqual({
      openai: { configured: true, source: "saved" },
    });
    const metadata = await call("/api/provider/credentials", {
      headers: { cookie: setup.cookie },
    });
    expect(JSON.stringify(metadata.data)).not.toContain(
      "sk-authenticated-private-secret",
    );
    expect(metadata.response.headers.get("cache-control")).toBe("no-store");
    const settings = await call("/api/chat/settings", {
      headers: { cookie: setup.cookie },
    });
    expect(JSON.stringify(settings.data)).not.toContain(
      "sk-authenticated-private-secret",
    );
  });
});
describe("authentication lifetimes and recovery", () => {
  it("expires setup keys after 30 minutes and throttles repeated failures", async () => {
    const dataDir = await fs.mkdtemp(path.join(temp, "lifetime-"));
    let time = 100;
    const auth = createAuthService({ dataDir, now: () => time });
    const key = await auth.createSetupKey();
    time += 30 * 60000;
    await expect(
      auth.setup({ setupKey: key, password: "some-password-1234" }),
    ).rejects.toMatchObject({ code: "INVALID_SETUP_KEY" });
    for (let i = 0; i < 7; i++)
      await auth
        .setup({ setupKey: "bad", password: "some-password-1234" })
        .catch(() => {});
    await expect(
      auth.setup({ setupKey: key, password: "some-password-1234" }),
    ).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
  });
  it("keeps sliding sessions for 14 days and never beyond 90 days, reset revokes", async () => {
    const dataDir = await fs.mkdtemp(path.join(temp, "sessions-"));
    let time = 1;
    const auth = createAuthService({ dataDir, now: () => time });
    const key = await auth.createSetupKey(),
      token = await auth.setup({
        setupKey: key,
        password: "some-password-1234",
      });
    for (let day = 13; day < 90; day += 13) {
      time = day * 86400000;
      expect(await auth.authenticate(token)).toBe(true);
    }
    time = 90 * 86400000 + 1;
    expect(await auth.authenticate(token)).toBe(false);
    const login = await auth.login({ password: "some-password-1234" });
    expect(await auth.createSetupKey({ reset: true })).toBeTypeOf("string");
    expect(await auth.authenticate(login)).toBe(false);
    expect((await auth.status()).setupRequired).toBe(true);
  });
});
