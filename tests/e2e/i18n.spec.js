import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function project(request, templateId = "small-website") {
  const response = await request.post("/api/projects/import", {
    data: {
      templateId,
      operationId: randomUUID(),
      contentLocale: "de",
      tutorLocale: "en",
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function open(page, session) {
  await page.route("**/api/models**", (route) =>
    route.fulfill({ json: { connected: false, models: [] } }),
  );
  await page.goto("/");
  await expect(page.locator("#ui-locale")).toBeVisible();
  await page
    .getByRole("button", { name: session.title, exact: true })
    .first()
    .click();
  await expect(page.locator("#file-path")).toHaveText(
    session.activeFile || "index.html",
  );
}
async function switchTo(page, locale) {
  await Promise.all([
    page.waitForEvent("load"),
    page.locator("#ui-locale").selectOption(locale),
  ]);
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.locator("#ui-locale")).toHaveValue(locale);
  await expect(page.locator("#app")).not.toHaveAttribute("inert", "");
}
async function journalDraft(page, text) {
  if (!(await page.locator("#task-journal-text").isVisible()))
    await page.locator(".task-reflection > summary").click();
  await page.locator("#task-journal-text").fill(text);
}

test("language reload preserves drafts, source versions, tutor language and terminal output", async ({
  page,
  request,
}) => {
  const session = await project(request);
  const fileURL = `/api/workspaces/${session.id}/files/content?path=index.html`;
  const original = await (await request.get(fileURL)).json();
  let processStarts = 0;
  await page.route("**/api/terminal", (route) => {
    processStarts++;
    return route.abort();
  });
  await page.route("**/api/terminal/locale-fixture/output?**", (route) =>
    route.fulfill({
      json: {
        processId: "locale-fixture",
        sessionId: session.id,
        output: "Benutzerausgabe bleibt unverändert: gespeichert\n",
        offset: 51,
        nextOffset: 51,
        exited: true,
        exitCode: 0,
      },
    }),
  );
  await open(page, session);
  await page
    .locator("#chat-input")
    .fill("My unsubmitted draft: Grüße / español");
  await journalDraft(page, "Mein unveröffentlichter Gedanke: mañana.");
  await page.evaluate(async (id) => {
    const { attachProcess } = await import("/js/terminal.js");
    attachProcess({
      sessionId: id,
      processId: "locale-fixture",
      command: "original-command",
      actor: "user",
      exited: false,
    });
  }, session.id);
  await expect(page.locator("#terminal-output")).toContainText(
    "Benutzerausgabe bleibt unverändert",
  );
  await expect(page.locator("#process-status")).toContainText("Beendet");
  for (const [locale, saved, newFile] of [
    ["en", "Saved", "New file"],
    ["es", "Guardado", "Nuevo archivo"],
    ["de", "Gespeichert", "Neue Datei"],
  ]) {
    await switchTo(page, locale);
    await expect(page.locator("#file-path")).toHaveText("index.html");
    await expect(page.locator("#save-status")).toHaveText(saved);
    await expect(page.locator("#chat-input")).toHaveValue(
      "My unsubmitted draft: Grüße / español",
    );
    await expect(page.locator("#task-journal-text")).toHaveValue(
      "Mein unveröffentlichter Gedanke: mañana.",
    );
    await expect(page.locator("#terminal-output")).toContainText(
      "Benutzerausgabe bleibt unverändert: gespeichert",
    );
    await expect(
      page.getByRole("button", {
        name: newFile,
        exact: true,
        includeHidden: true,
      }),
    ).toHaveAttribute("aria-label", newFile);
    const current = await (await request.get(fileURL)).json();
    expect(current.content).toBe(original.content);
    expect(current.version).toBe(original.version);
    const stored = await (
      await request.get(`/api/sessions/${session.id}`)
    ).json();
    expect(stored.tutorLocale).toBe("en");
    expect(stored.currentTask).toEqual(session.currentTask);
  }
  expect(processStarts).toBe(0);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("sterracode.localeRecovery.v1"),
    ),
  ).toBeNull();
});

test("failed save prevents language change and retains the editor draft", async ({
  page,
  request,
}) => {
  const session = await project(request);
  await open(page, session);
  await page.route("**/files/content", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    return route.fulfill({
      status: 409,
      json: { error: "Fixture conflict", code: "CONFLICT" },
    });
  });
  await page.evaluate(() => {
    const model = monaco.editor
      .getModels()
      .find((item) => item.uri.path.endsWith("/index.html"));
    model.setValue("<!-- unsaved original draft -->");
  });
  await page.locator("#ui-locale").selectOption("en");
  await expect(page.locator("#save-status")).toHaveText(
    "Speichern fehlgeschlagen – prüfen",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator("#ui-locale")).toHaveValue("de");
  await expect(page.locator(".view-lines")).toContainText(
    "unsaved original draft",
  );
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("sterracode.localeRecovery.v1"),
    ),
  ).toBeNull();
});

test("active work, terminal input and unfinished dialogs defer language application", async ({
  page,
  request,
}) => {
  const session = await project(request);
  await open(page, session);
  await page.evaluate(async () => {
    const { state } = await import("/js/state.js");
    state.busy = true;
  });
  await page.locator("#ui-locale").selectOption("es");
  await expect(page.locator("#toasts")).toContainText(
    "Tutorantwort zuerst beenden",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await page.evaluate(async () => {
    const { state } = await import("/js/state.js");
    state.busy = false;
    const { showTerminal } = await import("/js/terminal.js");
    showTerminal();
  });
  await page
    .locator("#terminal-input")
    .fill("never store or execute this input");
  await page.locator("#ui-locale").selectOption("es");
  await expect(page.locator("#toasts")).toContainText(
    "Terminaleingabe zuerst senden",
  );
  await expect(page.locator("#terminal-input")).toHaveValue(
    "never store or execute this input",
  );
  await page.locator("#terminal-input").fill("");
  await page.evaluate(() => document.getElementById("app-dialog").showModal());
  await page.evaluate(async () => {
    const { requestLocaleChange } = await import("/js/localeSwitch.js");
    try {
      await requestLocaleChange("es");
    } catch (error) {
      window.localeBlocked = error.message;
    }
  });
  expect(await page.evaluate(() => window.localeBlocked)).toContain(
    "Dialog zuerst",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await page.evaluate(() => document.getElementById("app-dialog").close());
  // Runner availability is independent of the app's local/server mode.
  await page.route("**/api/programs", (route) =>
    route.fulfill({ json: { activeJob: { state: "installing" } } }),
  );
  await page.locator("#ui-locale").selectOption("es");
  await expect(page.locator("#toasts")).toContainText(
    "Ein Paketauftrag läuft noch.",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
});

test("tab history restores language and drafts when Web Storage is unavailable", async ({
  page,
  request,
}) => {
  const session = await project(request);
  await page.addInitScript(() => {
    for (const key of ["localStorage", "sessionStorage"])
      Object.defineProperty(window, key, {
        configurable: true,
        get() {
          throw new DOMException("Unavailable", "SecurityError");
        },
      });
  });
  await open(page, session);
  await page.locator("#chat-input").fill("Tab-only draft remains original.");
  await journalDraft(page, "Diario sin guardar.");
  // Restricted storage now starts with the registry's English default.
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await switchTo(page, "es");
  await expect(page.locator("#file-path")).toHaveText("index.html");
  await expect(page.locator("#chat-input")).toHaveValue(
    "Tab-only draft remains original.",
  );
  await expect(page.locator("#task-journal-text")).toHaveValue(
    "Diario sin guardar.",
  );
  expect(
    await page.evaluate(() => history.state.sterracodeLocaleRecovery),
  ).toBeUndefined();
  expect(await page.evaluate(() => history.state.sterracodeUiLocale)).toBe(
    "es",
  );
});

test("readable old preference cannot override a newer tab preference when writes fail", async ({
  page,
  request,
}) => {
  const session = await project(request);
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem(key) {
          return key === "sterracode.uiLocale" ? "de" : null;
        },
        setItem() {
          throw new DOMException("Full", "QuotaExceededError");
        },
        removeItem() {},
      },
    });
  });
  await open(page, session);
  await page
    .locator("#chat-input")
    .fill("New tab preference retains this draft.");
  await switchTo(page, "es");
  await expect(page.locator("#chat-input")).toHaveValue(
    "New tab preference retains this draft.",
  );
  await expect(page.locator("#file-path")).toHaveText("index.html");
});

test("deleting an observed task and trace session does not block later language changes", async ({
  page,
  request,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const session = await project(request, "guess-number");
  await open(page, session);
  await page.locator("#trace-open").click();
  await page
    .getByRole("dialog", { name: "Python Schritt für Schritt" })
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await page
    .locator(".session-row")
    .filter({ hasText: session.title })
    .getByRole("button", { name: "Session verwalten", exact: true })
    .click();
  await page.getByLabel("Aktion", { exact: true }).selectOption("delete");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
  await expect(page.locator("#panes")).toBeHidden();
  await switchTo(page, "en");
  expect(errors).toEqual([]);
});

test("temporary session restore failures retain drafts for the next reload", async ({
  page,
  request,
}) => {
  const session = await project(request);
  await open(page, session);
  await page
    .locator("#chat-input")
    .fill("Retain through a temporary restore failure.");
  let fail = true;
  await page.route(`**/api/sessions/${session.id}`, (route) =>
    fail && route.request().method() === "GET"
      ? route.fulfill({
          status: 503,
          json: { error: "Temporary fixture failure", code: "UNAVAILABLE" },
        })
      : route.continue(),
  );
  await switchTo(page, "en");
  await expect(page.locator("#toasts")).toContainText(
    "Temporary fixture failure",
  );
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("sterracode.localeRecovery.v1"),
    ),
  ).not.toBeNull();
  fail = false;
  await page.reload();
  await expect(page.locator("#file-path")).toHaveText("index.html");
  await expect(page.locator("#chat-input")).toHaveValue(
    "Retain through a temporary restore failure.",
  );
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("sterracode.localeRecovery.v1"),
    ),
  ).toBeNull();
});

test("German catalog fallback restores prepared drafts when the target catalog fails after reload", async ({
  page,
  request,
}) => {
  const session = await project(request);
  await open(page, session);
  await page
    .locator("#chat-input")
    .fill("Keep this draft even when Spanish cannot load.");
  await journalDraft(page, "Originaljournal nach Katalogausfall.");
  let reloaded = false;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) reloaded = true;
  });
  await page.route("**/i18n/locales/es/features.json", (route) =>
    reloaded
      ? route.fulfill({ status: 503, body: "unavailable" })
      : route.continue(),
  );
  await Promise.all([
    page.waitForEvent("load"),
    page.locator("#ui-locale").selectOption("es"),
  ]);
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator("#file-path")).toHaveText("index.html");
  await expect(page.locator("#chat-input")).toHaveValue(
    "Keep this draft even when Spanish cannot load.",
  );
  await expect(page.locator("#task-journal-text")).toHaveValue(
    "Originaljournal nach Katalogausfall.",
  );
});

test("Monaco menus and narrow layouts follow the selected locale", async ({
  page,
  request,
}, testInfo) => {
  const session = await project(request);
  await open(page, session);
  for (const [locale, findLabel] of [
    ["en", "Find"],
    ["es", "Buscar"],
  ]) {
    await switchTo(page, locale);
    await page.locator(".monaco-editor textarea").first().focus();
    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.locator(".find-widget")).toBeVisible();
    await expect(
      page
        .locator(".find-widget")
        .getByRole("textbox", { name: findLabel, exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    for (const width of [800, 1024, 1366, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator("#sidebar-toggle")).toHaveAttribute(
        "aria-expanded",
        width < 1280 ? "false" : "true",
      );
      for (const theme of ["dark", "light", "high-contrast", "solarized"]) {
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
          window.dispatchEvent(new Event("theme-changed"));
        }, theme);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await expect(page.locator("#ui-locale")).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`i18n-${locale}-${width}-${theme}.png`),
          animations: "disabled",
          fullPage: true,
        });
      }
    }
    await page.setViewportSize({ width: 800, height: 900 });
    await page.screenshot({
      path: testInfo.outputPath(`i18n-${locale}-800.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
});
