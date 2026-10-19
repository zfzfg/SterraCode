import { test, expect } from "@playwright/test";

test("Python-Werkzeug erscheint nur für eine geöffnete Python-Datei und erklärt den Einstieg", async ({
  page,
  request,
}) => {
  const session = await (
    await request.post("/api/sessions", {
      data: { title: "Sprachabhängige Werkzeuge", language: "javascript" },
    })
  ).json();
  const base = `/api/workspaces/${session.id}`;
  for (const [path, content] of [
    ["index.html", "<h1>Hallo</h1>"],
    ["helper.py", "x = 1\nprint(x)\n"],
  ]) {
    expect(
      (await request.post(`${base}/files`, { data: { path, content } })).ok(),
    ).toBeTruthy();
  }
  await request.patch(`/api/sessions/${session.id}`, {
    data: { openFiles: ["main.js", "index.html", "helper.py"] },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: session.title, exact: true })
    .first()
    .click();
  await expect(page.locator("#trace-tools")).toBeHidden();
  await page
    .locator("#file-tabs")
    .getByRole("button", { name: "index.html", exact: true })
    .click();
  await expect(page.locator("#trace-tools")).toBeHidden();
  await page
    .locator("#file-tabs")
    .getByRole("button", { name: "helper.py", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Python Schritt für Schritt", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Python Schritt für Schritt",
  });
  await expect(dialog).toContainText("wie sich Variablen verändern");
  await expect(dialog).toContainText("einmal ausgeführt");
  await expect(dialog).toContainText("Datei: helper.py");
  await expect(
    dialog.getByRole("button", { name: "Schritt vor", exact: true }),
  ).toBeHidden();
  await expect(
    dialog.getByRole("textbox", { name: "Programmeingabe", exact: false }),
  ).toBeHidden();
  await dialog
    .getByText("Zusätzliche Dateien und Eingaben", { exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Programmeingabe", exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/python-step-introduction.png" });
  await page.keyboard.press("Escape");
  await expect(page.locator("#trace-open")).toBeFocused();
  await page
    .locator("#file-tabs")
    .getByRole("button", { name: "main.js", exact: true })
    .click();
  await expect(page.locator("#trace-tools")).toBeHidden();
  await page.reload();
  await page
    .getByRole("button", { name: session.title, exact: true })
    .first()
    .click();
  await expect(page.locator("#trace-tools")).toBeHidden();
});

test("Python-Ablauf offline wiedergeben, Vorhersage, Quellstand und Neuladen", async ({
  page,
  request,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
    }),
  );
  await page.route("**/api/models", (route) =>
    route.fulfill({ json: { connected: false, models: [] } }),
  );
  const session = await (
    await request.post("/api/sessions", {
      data: { title: "Trace-Lernablauf", language: "python" },
    })
  ).json();
  const base = `/api/workspaces/${session.id}`;
  const file = await (
    await request.get(`${base}/files/content?path=${session.activeFile}`)
  ).json();
  await request.put(`${base}/files/content`, {
    data: {
      path: session.activeFile,
      expectedVersion: file.version,
      content:
        "items = [10, 20]\nindex = 0\nwhile index < 3:\n    print(items[index])\n    index += 1\n",
    },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Trace-Lernablauf", exact: true })
    .first()
    .click();
  await expect(page.locator("#file-path")).toHaveText(session.activeFile);
  await page
    .getByRole("button", { name: "Python Schritt für Schritt", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Python Schritt für Schritt",
  });
  await dialog
    .getByRole("button", { name: "Python-Datei aufzeichnen" })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "Unbehandelter Programmfehler",
  );
  await expect(dialog.locator(".trace-caption")).not.toContainText(
    "Als Nächstes",
  ); // initial call event
  await dialog
    .getByRole("button", { name: "Schritt vor", exact: true })
    .click();
  await expect(dialog.locator(".trace-caption")).toContainText("Als Nächstes");
  await dialog.getByRole("button", { name: "Zum Fehler" }).click();
  await expect(dialog).toContainText("Ausnahme: IndexError");
  await expect(dialog).toContainText("Aufrufstack");
  await dialog.getByRole("button", { name: "Schritt zurück" }).click();
  await dialog
    .getByRole("textbox", { name: "Variable vorhersagen", exact: true })
    .fill("index");
  await dialog
    .getByRole("textbox", { name: "Erwarteter Wert", exact: true })
    .fill("2");
  await dialog
    .getByRole("button", { name: "Schritt vor", exact: true })
    .click();
  await expect(dialog).toContainText("Richtig: index");
  const runs = await (await request.get(`${base}/traces`)).json();
  expect(runs).toHaveLength(1);
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  const saved = await (
    await request.get(`${base}/files/content?path=${session.activeFile}`)
  ).json();
  await request.put(`${base}/files/content`, {
    data: {
      path: session.activeFile,
      expectedVersion: saved.version,
      content: 'print("new version")',
    },
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Trace-Lernablauf", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Python Schritt für Schritt", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Original-Snapshot");
  await dialog
    .getByRole("button", { name: "Schritt vor", exact: true })
    .click();
  await expect(dialog.locator(".trace-source .view-lines")).toContainText(
    "items = [10, 20]",
  );
  expect(await (await request.get(`${base}/traces`)).json()).toHaveLength(1);
  for (const theme of ["dark", "light", "high-contrast", "solarized"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    await page.setViewportSize({ width: 640, height: 800 });
    await expect(
      dialog.getByRole("button", { name: "Schritt vor", exact: true }),
    ).toBeVisible();
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
    ).toBe(true);
  }
  await page.screenshot({ path: "test-results/tracer-mobile.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#trace-open")).toBeFocused();
});

test("Sessionwechsel findet laufenden Trace wieder und fehlende Python-Freigabe wird erklärt", async ({
  page,
  request,
}) => {
  const settings = await (await request.get("/api/chat/settings")).json();
  const session = await (
    await request.post("/api/sessions", {
      data: { title: "Trace wechseln A", language: "python" },
    })
  ).json();
  await request.post("/api/sessions", {
    data: { title: "Trace wechseln B", language: "python" },
  });
  const base = `/api/workspaces/${session.id}`;
  const file = await (
    await request.get(`${base}/files/content?path=${session.activeFile}`)
  ).json();
  await request.put(`${base}/files/content`, {
    data: {
      path: session.activeFile,
      expectedVersion: file.version,
      content: "import time\nx = 1\ntime.sleep(60)\n",
    },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Trace wechseln A", exact: true })
    .first()
    .click();
  await page.locator("#trace-open").click();
  const dialog = page.getByRole("dialog", {
    name: "Python Schritt für Schritt",
  });
  await dialog
    .getByRole("button", { name: "Python-Datei aufzeichnen" })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Aufzeichnung läuft");
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await page
    .getByRole("button", { name: "Trace wechseln B", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Trace wechseln A", exact: true })
    .first()
    .click();
  await page.locator("#trace-open").click();
  await expect(dialog.getByRole("status")).toContainText("Aufzeichnung läuft");
  await dialog
    .getByRole("button", { name: "Lauf stoppen", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Gestoppt");
  expect(await (await request.get(`${base}/traces`)).json()).toHaveLength(1);
  try {
    await request.patch("/api/chat/settings", {
      data: {
        allowedLanguages: settings.allowedLanguages.filter(
          (l) => l !== "python",
        ),
      },
    });
    await dialog
      .getByRole("button", { name: "Python-Datei aufzeichnen" })
      .click();
    await expect(dialog.getByRole("status")).toContainText("deaktiviert");
  } finally {
    await request.patch("/api/chat/settings", {
      data: { allowedLanguages: settings.allowedLanguages },
    });
  }
});

test("Trace-API validiert Seiten, Versionen, Session und Origin", async ({
  request,
}) => {
  const s = await (
    await request.post("/api/sessions", {
      data: { title: "Trace-API", language: "python" },
    })
  ).json();
  const root = `/api/workspaces/${s.id}`;
  const f = await (
    await request.get(`${root}/files/content?path=${s.activeFile}`)
  ).json();
  const operationId = crypto.randomUUID();
  const body = {
    operationId,
    entry: s.activeFile,
    expectedVersions: { [s.activeFile]: f.version },
  };
  const response = await request.post(`${root}/traces`, { data: body });
  expect(response.status()).toBe(202);
  const trace = await response.json();
  expect(
    (await (await request.post(`${root}/traces`, { data: body })).json())
      .traceRunId,
  ).toBe(trace.traceRunId);
  expect(
    (
      await request.post(`${root}/traces`, {
        data: { ...body, stdin: "changed" },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await request.get(`${root}/traces/${trace.traceRunId}/events?limit=999`)
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post(`${root}/traces`, {
        data: {
          ...body,
          operationId: crypto.randomUUID(),
          expectedVersions: { [s.activeFile]: "0".repeat(64) },
        },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await request.post(`${root}/traces`, {
        data: body,
        headers: { origin: "https://attacker.invalid" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.get(
        `/api/workspaces/${crypto.randomUUID()}/traces/${trace.traceRunId}`,
      )
    ).status(),
  ).toBe(404);
});
