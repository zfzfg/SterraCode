import { it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeLocale,
  requestLocale,
  LOCALES,
} from "../shared/i18n/locale.js";
import { messageDescriptor } from "../shared/i18n/messages.js";
import { t, errorPayload } from "../server/services/i18n.js";
import { t as browserT } from "../public/js/i18n.js";
import { validateTrace } from "../runner/tracer/adapter.js";
import { validatePayload } from "../runner/jobs.js";

let root, storage, sessions, workspace;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-i18n-core-"));
  vi.stubEnv("STERRACODE_DATA_DIR", root);
  vi.stubEnv("STERRACODE_WORKSPACE_DIR", path.join(root, "workspaces"));
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  workspace = await import("../server/services/workspace.js");
  await storage.ensureDataDirs();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("normalizes only registered languages and respects weighted HTTP preferences", () => {
  expect(normalizeLocale()).toBe("en");
  expect(requestLocale()).toBe("en");
  expect(normalizeLocale("en-US")).toBe("en");
  expect(normalizeLocale("es_MX")).toBe("es");
  for (const value of ["../../en", "__proto__", "fr", null, {}, "constructor"])
    expect(normalizeLocale(value)).toBe("en");
  expect(requestLocale("en;q=0.2,es-MX;q=0.9,de;q=0")).toBe("es");
  expect(requestLocale("fr,es;q=0")).toBe("en");
  expect(Object.values(LOCALES).map((entry) => entry.monaco)).toEqual([
    "de",
    "i-default",
    "es",
  ]);
});
it("uses English for fresh settings and sessions while preserving saved choices", async () => {
  expect(storage.defaultSettings().systemPrompt).toContain(
    "You are SterraCode",
  );
  const fresh = await sessions.createSession();
  expect(fresh.tutorLocale).toBe("en");
  const german = await sessions.createSession({ tutorLocale: "de" });
  expect((await sessions.loadSession(german.id)).tutorLocale).toBe("de");
});
it("keeps interpolation literal and uses a known fallback instead of exposing keys", () => {
  const title =
    "<img src=x onerror=alert(1)> A&B {{other}} $t(auth:login.submit)";
  expect(t("en", "sessions:delete.description", { title })).toContain(title);
  expect(browserT("sessions:delete.description", { title })).toContain(title);
  expect(t("es", "missing:neverExpose")).toBe(
    "Se ha producido un error. Inténtalo de nuevo.",
  );
  expect(() => messageDescriptor("../../bad", {})).toThrow();
  expect(() =>
    messageDescriptor("common:errors.generic", { secret: {} }),
  ).toThrow();
  const error = new storage.AppError(
    "Session nicht gefunden.",
    404,
    "NOT_FOUND",
    { messageKey: "errors:session.notFound" },
  );
  expect(errorPayload(error, "en")).toMatchObject({
    error: "Session not found.",
    code: "NOT_FOUND",
    messageKey: "errors:session.notFound",
  });
});
it("migrates only locale metadata once without changing source, messages or test evidence", async () => {
  const session = await sessions.createSession({
    title: "Originaltitel",
    tutorLocale: "en",
  });
  const content = "print('unverändert')\n";
  await workspace.writeFile(
    session.id,
    session.activeFile,
    content,
    (await workspace.readFile(session.id, session.activeFile)).version,
  );
  const originalFile = await workspace.readFile(session.id, session.activeFile);
  delete session.localeSchemaVersion;
  delete session.tutorLocale;
  session.currentTask = {
    suiteDigest: "original-digest",
    original: "Alter Aufgabentext",
  };
  await storage.writeJSON(sessions.sessionFile(session.id), session);
  const loaded = await sessions.loadSession(session.id);
  expect(loaded).toMatchObject({
    schemaVersion: 2,
    localeSchemaVersion: 1,
    tutorLocale: null,
    title: "Originaltitel",
    currentTask: session.currentTask,
  });
  expect(loaded.messages).toEqual(session.messages);
  expect(await workspace.readFile(session.id, session.activeFile)).toEqual(
    originalFile,
  );
  expect((await sessions.loadSession(session.id)).revision).toBe(
    loaded.revision,
  );
  await sessions.mutateSession(session.id, (current) => {
    current.contextUsage = { saved: true };
  });
  await sessions.mutateSession(session.id, (current) => {
    current.tutorLocale = "es";
  });
  expect((await sessions.loadSession(session.id)).contextUsage).toBeNull();
});
it("runner validation carries descriptors without an i18next dependency", () => {
  expect(() => validateTrace({})).toThrow(
    expect.objectContaining({ messageKey: "runner:trace.snapshot" }),
  );
  expect(() => validatePayload({ type: "trace", sessionId: "bad" })).toThrow(
    expect.objectContaining({ messageKey: "runner:session.invalid" }),
  );
});
it("selects singular and Spanish million plurals through the shared translator", () => {
  expect(
    t("de", "features:learningSupport.hintsOpened", { count: 1, p1: 0, p2: 1 }),
  ).toBe("Hinweis: 0/1 geöffnet");
  expect(
    t("de", "features:learningSupport.hintsOpened", { count: 2, p1: 0, p2: 2 }),
  ).toBe("Hinweise: 0/2 geöffnet");
  const million = t("es", "features:learningSupport.hintsOpened", {
    count: 1000000,
    p1: 0,
    p2: 1000000,
  });
  expect(million).toContain("1000000");
  expect(million).not.toContain("Se ha producido un error");
});
it("accepts another locale by extending only the central registry", async () => {
  const source = await fs.readFile(
    new URL("../shared/i18n/locale.js", import.meta.url),
    "utf8",
  );
  const extended = source.replace(
    "export const LOCALES = Object.freeze({",
    'export const LOCALES = Object.freeze({\nfr: {name:"Français",format:"fr-FR",monaco:"fr",dir:"ltr"},',
  );
  const registry = await import(
    "data:text/javascript;base64," + Buffer.from(extended).toString("base64")
  );
  expect(registry.normalizeLocale("fr-CA")).toBe("fr");
  expect(registry.requestLocale("fr-CA,en;q=0.4")).toBe("fr");
  expect(registry.formatLocale("fr")).toBe("fr-FR");
});
it("limits response parameters to display scalars without translation-option injection", () => {
  const result = errorPayload(
    {
      code: "INVALID_REQUEST",
      messageKey: "errors:settings.unknown",
      params: { name: "x".repeat(5000), lng: "es", defaultValue: "unsafe" },
    },
    "en",
  );
  expect(result.params.name).toHaveLength(4096);
  expect(result.error).toBe("Unknown setting: " + "x".repeat(4096));
  expect(
    errorPayload(
      {
        code: "INVALID_REQUEST",
        messageKey: "errors:settings.unknown",
        params: { name: { secret: "never serialize" } },
      },
      "es",
    ),
  ).toEqual({
    code: "INVALID_REQUEST",
    messageKey: "common:errors.generic",
    params: {},
    error: "Se ha producido un error. Inténtalo de nuevo.",
  });
});
