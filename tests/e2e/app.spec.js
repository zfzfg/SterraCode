import { test, expect } from "@playwright/test";
const pageErrors = new WeakMap();
async function seedContext(page, title, marker = "Fakt") {
  const session = (await (await page.request.get("/api/sessions")).json()).find(
    (s) => s.title === title,
  );
  for (let i = 0; i < 6; i++) {
    const response = await page.request.post("/api/chat", {
      data: {
        sessionId: session.id,
        userMessage: `${marker}-${i}: ${"Bitte erhalte diese Lernerfahrung. ".repeat(90)}`,
      },
    });
    const result = await response.json();
    expect(result.turn.status, result.turn.error).toBe("done");
  }
  await page.reload();
  await page.locator(".session-open").filter({ hasText: title }).click();
  await expect(page.locator("#session-title")).toHaveText(title);
  return session;
}
test.beforeEach(async ({ page }) => {
  const errors = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) || []).toEqual([]);
});
async function startSession(
  page,
  title = "Browserprüfung",
  language = "python",
) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Neue Session starten", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Neue Session starten", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill(title);
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Programmiersprache", exact: true })
    .selectOption(language);
  await page
    .getByRole("button", { name: "Session erstellen", exact: true })
    .click();
  await expect(page.locator("#session-title")).toHaveText(title);
  await expect(page.locator(".monaco-editor")).toBeVisible();
}
async function sidebarTab(page, name) {
  if (
    (await page.locator("#sidebar-toggle").getAttribute("aria-expanded")) ===
    "false"
  )
    await page.locator("#sidebar-toggle").click();
  await page.getByRole("tab", { name, exact: true }).click();
}
test("Dateien speichern, SVG-Aktionen, Lernplan, Fragen und dauerhafte KI-Rücknahme", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await startSession(page);
  await expect(
    page.getByText("Möchtest du einen Lernplan erstellen?", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Direkt anfangen", exact: true })
    .click();
  await expect(
    page.getByText("Deine Antwort: Direkt anfangen", { exact: true }),
  ).toBeVisible();
  await page.locator("#chat-input").fill("Bitte erstelle eine Übung");
  await page.locator("#send-btn").click();
  await expect(
    page
      .locator("#chat-messages")
      .getByText("Python verstehen", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Welches Thema interessiert dich?", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Variablen", exact: true }).click();
  await expect(
    page.getByText("Deine Antwort: Variablen", { exact: true }),
  ).toBeVisible();
  await sidebarTab(page, "Dateien");
  await page.getByRole("treeitem", { name: "uebung.py", exact: true }).click();
  await expect(page.locator("#file-path")).toHaveText("uebung.py");
  await page.locator(".monaco-editor textarea").first().focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("# gespeichert");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator("#save-status")).toHaveText("Gespeichert");
  await page.screenshot({
    path: "test-results/workbench.png",
    animations: "disabled",
  });
  await page.reload();
  await page
    .getByRole("button", { name: /Browserprüfung/ })
    .first()
    .click();
  await expect(page.locator("#file-path")).toHaveText("uebung.py");
  await expect(page.locator(".view-lines")).toContainText("# gespeichert");
  await expect(
    page.getByText("Deine Antwort: Variablen", { exact: true }),
  ).toBeVisible();
  await sidebarTab(page, "Lernplan");
  await page.getByLabel("Ausgaben verstehen", { exact: true }).check();
  await expect(page.getByText("1 von 2 Themen abgeschlossen")).toBeVisible();
  await sidebarTab(page, "Dateien");
  await page.getByRole("button", { name: "Neue Datei", exact: true }).click();
  await page
    .getByLabel("Relativer Pfad", { exact: true })
    .fill("neue-datei.txt");
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await expect(page.locator("#file-path")).toHaveText("neue-datei.txt");
  await sidebarTab(page, "Dateien");
  const action = page.getByRole("button", {
    name: "Umbenennen: neue-datei.txt",
    exact: true,
  });
  await action.locator("svg").click({ force: true });
  await page.getByLabel("Neuer relativer Pfad").fill("umbenannt.txt");
  await page
    .getByRole("button", { name: "Speichern", exact: true })
    .last()
    .click();
  await expect(page.locator("#file-path")).toHaveText("umbenannt.txt");
  // Undo refuses to discard a later user edit.
  await page.getByRole("button", { name: "Rückgängig", exact: true }).click();
  await expect(page.locator("#toasts").getByRole("alert")).toContainText(
    "danach verändert",
  );
  await sidebarTab(page, "Dateien");
  await page
    .getByRole("button", { name: "Löschen: umbenannt.txt", exact: true })
    .locator("svg")
    .click({ force: true });
  await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
  await expect(
    page.getByRole("treeitem", { name: "umbenannt.txt", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("Abbruch, Offline-Zustand und Tastaturdialog", async ({ page }) => {
  await startSession(page, "Abbruchprüfung");
  await expect(page.locator("#send-btn")).toBeEnabled();
  await page.locator("#chat-input").fill("Bitte warte");
  await page.locator("#send-btn").click();
  await expect(
    page.getByText("Ich prüfe das …", { exact: true }),
  ).toBeVisible();
  await page.locator("#stop-chat-btn").click();
  await expect(
    page.getByRole("button", { name: "Antwort fortsetzen", exact: true }),
  ).toBeVisible();
  await page.locator("#settings-btn").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator("#settings-btn")).toBeFocused();
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        models: [],
        connected: false,
        status: "offline",
        error: "LM Studio ist offline.",
      },
    }),
  );
  await page.locator("#refresh-models").click();
  await expect(page.locator("#connection-text")).toHaveText(
    "LM Studio offline",
  );
  await expect(page.locator("#send-btn")).toBeDisabled();
  await expect(page.locator(".monaco-editor")).toBeVisible();
});
for (const [width, height] of [
  [1024, 768],
  [1366, 768],
  [1920, 1080],
  [800, 768],
]) {
  test(`Layout und Themes bei ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await startSession(page, `Layout ${width}`);
    for (const theme of ["dark", "light", "high-contrast", "solarized"]) {
      await page.locator("#settings-btn").click();
      await page.getByLabel("Darstellung", { exact: true }).selectOption(theme);
      await page
        .getByRole("button", { name: "Speichern", exact: true })
        .last()
        .click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(
        page.getByText("Einstellungen gespeichert.", { exact: true }),
      ).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        editor: document.getElementById("editor-panel").getBoundingClientRect()
          .width,
        chat: document.getElementById("teacher-panel").getBoundingClientRect()
          .width,
      }));
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
      if (width >= 960) {
        expect(dimensions.editor).toBeGreaterThanOrEqual(360);
        expect(dimensions.chat).toBeGreaterThanOrEqual(320);
      } else {
        await expect(page.locator("#teacher-panel")).not.toBeVisible();
        await page.locator("#view-chat").click();
        await expect(page.locator("#teacher-panel")).toBeVisible();
        await page.locator("#view-editor").click();
      }
      await expect(page.locator("#toasts .toast.error")).toHaveCount(0);
      for (const close of await page
        .locator("#toasts")
        .getByRole("button", { name: "Schließen", exact: true })
        .all())
        await close.click();
      await expect.soft(page).toHaveScreenshot(`layout-${width}-${theme}.png`, {
        mask: [page.locator("#sessions-list")],
      });
    }
  });
}
test("verspätete Dateiladung aus Session A überschreibt Session B nicht", async ({
  page,
  request,
}) => {
  const a = await (
      await request.post("/api/sessions", { data: { title: "Wechsel A" } })
    ).json(),
    b = await (
      await request.post("/api/sessions", { data: { title: "Wechsel B" } })
    ).json();
  for (const [s, file, content] of [
    [a, "a.py", "A_SOURCE"],
    [b, "b.py", "B_SOURCE"],
  ]) {
    await request.post(`/api/workspaces/${s.id}/files`, {
      data: { path: file, type: "file", content },
    });
    await request.patch(`/api/sessions/${s.id}`, {
      data: { activeFile: file, openFiles: [file] },
    });
  }
  let release, started;
  const gate = new Promise((r) => (release = r)),
    intercepted = new Promise((r) => (started = r));
  await page.route(
    `**/api/workspaces/${a.id}/files/content?**`,
    async (route) => {
      started();
      await gate;
      await route.continue();
    },
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Wechsel A", exact: true })
    .first()
    .click();
  await intercepted;
  await page
    .getByRole("button", { name: "Wechsel B", exact: true })
    .first()
    .click();
  await expect(page.locator("#file-path")).toHaveText("b.py");
  release();
  await expect(page.locator("#session-title")).toHaveText("Wechsel B");
  await expect(page.locator(".view-lines")).toContainText("B_SOURCE");
});
test("KI-Rücknahme bleibt nach Löschen der Chatnachricht erreichbar", async ({
  page,
}) => {
  await startSession(page, "Unabhängige Änderungshistorie");
  await expect(page.locator("#send-btn")).toBeEnabled();
  await page.locator("#chat-input").fill("Bitte erstelle eine Übung");
  await page.locator("#send-btn").click();
  await expect(
    page.getByRole("button", { name: "Rückgängig", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Letzte Nachricht und Antwort löschen",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Löschen", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Rückgängig", exact: true }),
  ).toHaveCount(0);
  await page.locator("#changes-btn").click();
  await page.getByRole("button", { name: /^Änderung:/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Rückgängig", exact: true })
    .click();
  await sidebarTab(page, "Dateien");
  await expect(
    page.getByRole("treeitem", { name: "uebung.py", exact: true }),
  ).toHaveCount(0);
});
test("Speicherkonflikt erhält Serverstand und sichert lokalen Text als neue Datei", async ({
  page,
  request,
}) => {
  await startSession(page, "Speicherkonflikt", "javascript");
  const all = await (await request.get("/api/sessions")).json(),
    s = all.find((v) => v.title === "Speicherkonflikt");
  const f = await (
    await request.get(`/api/workspaces/${s.id}/files/content?path=main.js`)
  ).json();
  await request.put(`/api/workspaces/${s.id}/files/content`, {
    data: { path: "main.js", content: "EXTERNAL", expectedVersion: f.version },
  });
  await page.locator(".monaco-editor textarea").first().focus();
  await page.keyboard.type("LOCAL");
  await expect(page.locator("#save-status")).toContainText(
    "Speichern fehlgeschlagen",
  );
  await page.locator("#save-status").click();
  await expect(page.getByLabel("Aktion", { exact: true })).toHaveValue("copy");
  await page
    .getByLabel("Name der Sicherungsdatei", { exact: true })
    .fill("recovered-local.js");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Ausführen", exact: true })
    .click();
  await expect(page.locator(".view-lines")).toContainText("EXTERNAL");
  const recovered = await (
    await request.get(
      `/api/workspaces/${s.id}/files/content?path=recovered-local.js`,
    )
  ).json();
  expect(recovered.content).toBe("LOCAL");
});
test("unveränderte KI-Dateiänderung bleibt nach Neuladen rückgängig machbar", async ({
  page,
}) => {
  await startSession(page, "Dauerhaftes Undo");
  await page.locator("#chat-input").fill("Bitte erstelle eine Übung");
  await page.locator("#send-btn").click();
  await expect(
    page.getByRole("button", { name: "Rückgängig", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: /Dauerhaftes Undo/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Rückgängig", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Rückgängig gemacht", exact: true }),
  ).toBeDisabled();
  await sidebarTab(page, "Dateien");
  await expect(
    page.getByRole("treeitem", { name: "uebung.py", exact: true }),
  ).toHaveCount(0);
});

for (const streaming of [true, false]) {
  test(`Kontextbefehle und persistente Berichte mit Streaming=${streaming}`, async ({
    page,
  }) => {
    const title = `Kontextprüfung ${streaming}`;
    await startSession(page, title);
    await page.request.patch("/api/chat/settings", {
      data: {
        streaming,
        keepRecentTokens: 0,
        chunkTokens: 1000,
        summarizerMaxTokens: 200,
      },
    });
    try {
      const session = await seedContext(page, title);
      const before = await (
        await page.request.get(`/api/sessions/${session.id}`)
      ).json();
      await page.locator("#chat-input").fill("/compact");
      await page.locator("#send-btn").click();
      await expect(
        page.getByText("Kontext komprimiert", { exact: true }),
      ).toBeVisible();
      await expect(page.locator("#send-btn")).toBeEnabled();
      await expect(page.locator("#token-counter")).toContainText("Kontext:");
      await page.locator("#chat-input").fill("/usage");
      await page.locator("#send-btn").click();
      await expect(
        page.getByText("Kontextnutzung", { exact: true }),
      ).toBeVisible();
      const after = await (
        await page.request.get(`/api/sessions/${session.id}`)
      ).json();
      expect(after.messages.filter((m) => m.role !== "event")).toEqual(
        before.messages.filter((m) => m.role !== "event"),
      );
      expect(after.contextUsage.measurementQuality).toBe("exact");
      await page.reload();
      await page.locator(".session-open").filter({ hasText: title }).click();
      await expect(
        page.getByText("Kontext komprimiert", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Kontextnutzung", { exact: true }),
      ).toBeVisible();
    } finally {
      await page.request.patch("/api/chat/settings", {
        data: {
          streaming: true,
          keepRecentTokens: 6000,
          chunkTokens: 16000,
          summarizerMaxTokens: 1500,
        },
      });
    }
  });
}

test("/usage bleibt bei ausgefallener LM-Studio-Verbindung verfügbar", async ({
  page,
}) => {
  await startSession(page, "Offline-Kontext");
  const settings = await (await page.request.get("/api/chat/settings")).json();
  await page.request.patch("/api/chat/settings", {
    data: { lmStudioUrl: "http://127.0.0.1:1" },
  });
  try {
    await page.locator("#refresh-models").click();
    await expect(page.locator("#connection-text")).toHaveText(
      "LM Studio offline",
    );
    await page.locator("#chat-input").fill("/usage");
    await expect(page.locator("#send-btn")).toBeEnabled();
    await page.locator("#send-btn").click();
    await expect(
      page.getByText("Kontextnutzung", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("#token-counter")).toContainText("geschätzt");
    await expect(page.locator(".monaco-editor")).toBeVisible();
  } finally {
    await page.request.patch("/api/chat/settings", {
      data: { lmStudioUrl: settings.lmStudioUrl },
    });
  }
});

test("laufende Komprimierung lässt sich stoppen und erhält den Verlauf", async ({
  page,
}) => {
  const title = "Komprimierung stoppen";
  await startSession(page, title);
  await page.request.patch("/api/chat/settings", {
    data: { keepRecentTokens: 0, chunkTokens: 1000, summarizerMaxTokens: 200 },
  });
  try {
    const session = await seedContext(page, title, "COMPRESS_SLOW");
    const before = await (
      await page.request.get(`/api/sessions/${session.id}`)
    ).json();
    await page.locator("#chat-input").fill("/compress");
    await page.locator("#send-btn").click();
    await expect(page.locator("#chat-state")).toContainText(
      "Kontext wird komprimiert",
    );
    await page.locator("#stop-chat-btn").click();
    await expect(
      page.getByRole("button", {
        name: "Kontextaktion wiederholen",
        exact: true,
      }),
    ).toBeVisible();
    const after = await (
      await page.request.get(`/api/sessions/${session.id}`)
    ).json();
    expect(after.messages.filter((m) => m.role !== "event")).toEqual(
      before.messages.filter((m) => m.role !== "event"),
    );
    expect(Object.values(after.turns).at(-1).status).toBe("aborted");
  } finally {
    await page.request.patch("/api/chat/settings", {
      data: {
        keepRecentTokens: 6000,
        chunkTokens: 16000,
        summarizerMaxTokens: 1500,
      },
    });
  }
});

test("OpenAI-Modelle aus API-Liste und automatisch erkanntes LM-Studio-Kontextfenster", async ({
  page,
}) => {
  await page.route("**/api/models?provider=openai", (route) =>
    route.fulfill({
      json: {
        connected: true,
        models: [
          { id: "api-model-alpha", name: "API Modell Alpha" },
          { id: "api-model-beta", name: "API Modell Beta" },
        ],
      },
    }),
  );
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        connected: true,
        models: [
          { id: "test-model", name: "Geladenes Modell", contextLength: 24576 },
        ],
      },
    }),
  );
  await page.goto("/");
  await expect(page.locator("#model-select option")).toContainText([
    "Geladenes Modell · 24.576 Kontext-Tokens",
  ]);
  await page.locator("#settings-btn").click();
  const dialog = page.getByRole("dialog");
  const models = dialog.getByLabel("OpenAI-Modell", { exact: true });
  await expect(models).toHaveJSProperty("tagName", "SELECT");
  await expect(models.locator("option")).toHaveText([
    "OpenAI-Modell auswählen",
    "API Modell Alpha",
    "API Modell Beta",
  ]);
  await models.selectOption("api-model-beta");
  await expect(models).toHaveValue("api-model-beta");
  await expect(dialog.locator('[name="openAIContextLength"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("OpenAI-Schlüssel direkt in Einstellungen speichern und bei leerem Feld erhalten", async ({
  page,
}) => {
  let configured = false;
  const savedKeys = [];
  const settingsWrites = [];
  await page.route("**/api/provider/credentials", async (route) => {
    if (route.request().method() === "PATCH") {
      savedKeys.push(route.request().postDataJSON());
      configured = true;
    }
    await route.fulfill({
      json: { openai: { configured, source: configured ? "saved" : null } },
    });
  });
  await page.route("**/api/models?provider=openai", (route) =>
    route.fulfill({
      json: {
        connected: configured,
        models: configured ? [{ id: "api-model", name: "API Modell" }] : [],
      },
    }),
  );
  await page.route("**/api/chat/settings", async (route) => {
    if (route.request().method() === "PATCH")
      settingsWrites.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.goto("/");
  await expect(page.locator("#connection-text")).toHaveText(
    "LM Studio verbunden",
  );
  await page.locator("#settings-btn").click();
  const dialog = page.getByRole("dialog");
  const key = dialog.getByLabel("OpenAI-API-Schlüssel", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  await expect(key).toHaveValue("");
  await key.fill("  sk-browser-fixture  ");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(savedKeys).toEqual([
    { provider: "openai", apiKey: "sk-browser-fixture" },
  ]);
  expect(settingsWrites[0]).not.toHaveProperty("openAIApiKey");
  expect(JSON.stringify(settingsWrites)).not.toContain("sk-browser-fixture");
  await page.locator("#settings-btn").click();
  await expect(key).toHaveValue("");
  await expect(
    dialog.getByText("Ein Schlüssel ist gespeichert.", { exact: false }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("OpenAI-Modell", { exact: true }).locator("option"),
  ).toContainText(["API Modell"]);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(savedKeys).toHaveLength(1);
});

test("OpenAI-Schlüssel aus Secret-Datei ist in Einstellungen schreibgeschützt", async ({
  page,
}) => {
  await page.route("**/api/provider/credentials", (route) =>
    route.fulfill({
      json: {
        openai: { configured: true, source: "file" },
      },
    }),
  );
  await page.route("**/api/models?provider=openai", (route) =>
    route.fulfill({ json: { connected: true, models: [] } }),
  );
  await page.goto("/");
  await expect(page.locator("#connection-text")).toHaveText(
    "LM Studio verbunden",
  );
  await page.locator("#settings-btn").click();
  await expect(
    page.getByLabel("OpenAI-API-Schlüssel", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Der Schlüssel wird durch eine Secret-Datei auf dem Server vorgegeben.",
    ),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});
