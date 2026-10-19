import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";

async function offline(page) {
  await page.route("**/api/models", (route) =>
    route.fulfill({ json: { connected: false, models: [] } }),
  );
}
async function openSession(page, session) {
  await page
    .getByRole("button", { name: session.title, exact: true })
    .first()
    .click();
}

test("eine verspätete Importantwort verdrängt keine inzwischen geöffnete Session", async ({
  page,
  request,
}) => {
  const s = await (
    await request.post("/api/sessions", {
      data: { title: "Weiterlernen", language: "python" },
    })
  ).json();
  let release, created;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/projects/import", async (route) => {
    const response = await route.fetch();
    created = await response.json();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Projektwerkstatt", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Zahlenratespiel starten", exact: true })
    .click();
  await expect.poll(() => created?.id).toBeTruthy();
  await page.keyboard.press("Escape");
  await openSession(page, s);
  release();
  await expect(
    page.getByRole("button", { name: created.title, exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator("#session-title")).toHaveText("Weiterlernen");
});

test("Projektwerkstatt, einzelne Hinweise, Journal und Paket-Wiederaufnahme funktionieren offline", async ({
  page,
  request,
}) => {
  await offline(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Projektwerkstatt", exact: true })
    .click();
  let box = page.getByRole("dialog", { name: "Projektwerkstatt", exact: true });
  await expect(box).toContainText("CC0-1.0");
  await box
    .getByRole("button", { name: "Meine kleine Webseite starten" })
    .click();
  await expect(page.locator("#file-path")).toHaveText("index.html");
  const panel = page.locator("#task-panel");
  await expect(panel).toContainText("Hinweise: 0/4");
  await expect(panel).not.toContainText(
    "Welche Elemente möchtest du verändern?",
  );
  await panel.getByRole("button", { name: "Nächsten Hinweis öffnen" }).click();
  await expect(panel).toContainText("Hinweise: 1/4");
  await expect(panel).toContainText("Welche Elemente möchtest du verändern?");
  await expect(panel).not.toContainText("CSS gestaltet die Seite");
  await panel.getByText("Freiwilliges Lernjournal", { exact: true }).click();
  await panel.getByRole("textbox").fill("Ich verstehe jetzt Klickereignisse.");
  await panel.getByRole("button", { name: "Journaleintrag speichern" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Journaleintrag gespeichert." }),
  ).toBeVisible();
  await panel.getByRole("textbox").fill("Noch ungespeicherter Gedanke.");
  await panel
    .getByRole("button", { name: "Nach eigener Prüfung abschließen" })
    .click();
  await expect(
    panel.getByRole("button", { name: "Aufgabe abgeschlossen", exact: true }),
  ).toBeDisabled();
  await panel.getByText("Freiwilliges Lernjournal", { exact: true }).click();
  await expect(panel.getByRole("textbox")).toHaveValue(
    "Noch ungespeicherter Gedanke.",
  );
  const s = (await (await request.get("/api/sessions")).json()).find(
    (s) => s.title === "Meine kleine Webseite",
  );
  await page.reload();
  await openSession(page, s);
  await expect(panel).toContainText("Hinweise: 1/4");
  await panel.getByText("Freiwilliges Lernjournal", { exact: true }).click();
  await expect(panel.getByRole("textbox")).toHaveValue(
    "Ich verstehe jetzt Klickereignisse.",
  );
  await page.getByRole("button", { name: "Lernjournal", exact: true }).click();
  box = page.getByRole("dialog", { name: "Lernjournal", exact: true });
  await expect(box).toContainText("Persönlicher Eintrag");
  await box.getByRole("button", { name: "Eintrag bearbeiten" }).click();
  const edit = page.getByRole("dialog", { name: "Journaleintrag bearbeiten" });
  await edit.getByRole("textbox").fill("Eigene überarbeitete Reflexion.");
  await edit.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Lernjournal", exact: true }),
  ).toContainText("Eigene überarbeitete Reflexion.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Projekt exportieren", exact: true })
    .click();
  box = page.getByRole("dialog", { name: "Projekt exportieren", exact: true });
  for (const p of ["index.html", "style.css", "app.js"])
    await box.getByRole("checkbox", { name: p, exact: true }).check();
  const downloadPromise = page.waitForEvent("download");
  await box
    .getByRole("button", { name: "Ausgewählte Dateien exportieren" })
    .click();
  const download = await downloadPromise;
  const buffer = await fs.readFile(await download.path());
  const pkg = JSON.parse(buffer);
  expect(pkg.files).toHaveLength(3);
  expect(JSON.stringify(pkg)).not.toContain("Reflexion");
  await box.getByRole("button", { name: "Schließen", exact: true }).click();
  await page
    .getByRole("button", { name: "Projektwerkstatt", exact: true })
    .click();
  box = page.getByRole("dialog", { name: "Projektwerkstatt", exact: true });
  await box.locator('input[type="file"]').setInputFiles({
    name: "projekt.json",
    mimeType: "application/json",
    buffer,
  });
  await expect(box).toContainText("serverseitig auf Pfade");
  await box
    .getByRole("button", { name: "Paket in neue Session importieren" })
    .click();
  await expect(box).not.toBeVisible();
  await expect(panel).toContainText("Hinweise: 0/4");
  await expect(
    panel.getByRole("button", { name: "Nach eigener Prüfung abschließen" }),
  ).toBeEnabled();
  for (const theme of ["dark", "light", "high-contrast", "solarized"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width: 640, height: 800 });
    await page.getByRole("button", { name: "KI-Tutor", exact: true }).click();
    expect(
      await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 2),
    ).toBe(true);
  }
  await page.screenshot({ path: "test-results/learning-support-mobile.png" });
});

test("Python-Fehlerkarte zeigt Offline-Erklärung und sichere Quellnavigation", async ({
  page,
  request,
}) => {
  await offline(page);
  const s = await (
    await request.post("/api/projects/import", {
      data: { templateId: "text-analysis", operationId: crypto.randomUUID() },
    })
  ).json();
  const base = `/api/workspaces/${s.id}`;
  const f = await (
    await request.get(`${base}/files/content?path=main.py`)
  ).json();
  await request.put(`${base}/files/content`, {
    data: {
      path: "main.py",
      expectedVersion: f.version,
      content: "def zaehle_woerter(text):\n    return [][1]\n",
    },
  });
  await page.goto("/");
  await openSession(page, s);
  const panel = page.locator("#task-panel");
  await panel
    .getByRole("button", { name: "Lösung prüfen", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("Tests fehlgeschlagen");
  const card = panel.getByRole("region", { name: "Fehlerkarte" }).first();
  await expect(card).toContainText("Index außerhalb des gültigen Bereichs");
  await card.getByRole("button", { name: "Zur Zeile: main.py:2" }).click();
  await expect(page.locator("#file-path")).toHaveText("main.py");
  await card.getByText("Originalmeldung", { exact: true }).click();
  await expect(card.locator("pre")).toContainText("IndexError:");
  const failed = await (
    await request.get(`${base}/files/content?path=main.py`)
  ).json();
  await request.put(`${base}/files/content`, {
    data: {
      path: "main.py",
      expectedVersion: failed.version,
      content: "def zaehle_woerter(text):\n    return len(text.split())\n",
    },
  });
  await page.reload();
  await openSession(page, s);
  await panel
    .getByRole("button", { name: "Lösung prüfen", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText(
    "Erforderliche Tests bestanden",
  );
  await panel
    .getByRole("button", { name: "Aufgabe abschließen", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Aufgabe abgeschlossen", exact: true }),
  ).toBeDisabled();
  await panel.getByText("Freiwilliges Lernjournal", { exact: true }).click();
  await panel.getByRole("textbox").fill("split behandelt auch Leerraum.");
  await panel.getByRole("button", { name: "Journaleintrag speichern" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Journaleintrag gespeichert." }),
  ).toBeVisible();
  const completed = await (await request.get(`/api/sessions/${s.id}`)).json();
  expect(completed.learningJournal[0].testRunId).toBe(
    completed.currentTask.completion.evidence.testRunId,
  );
  // Exercise the same diagnostic catalog in a normal program run.
  const latest = await (
    await request.get(`${base}/files/content?path=main.py`)
  ).json();
  await request.put(`${base}/files/content`, {
    data: {
      path: "main.py",
      expectedVersion: latest.version,
      content: "items = []\nprint(items[1])\n",
    },
  });
  await page.reload();
  await openSession(page, s);
  await page.locator("#run-btn").click();
  await expect(page.locator("#terminal-diagnostics")).toContainText(
    "Index außerhalb des gültigen Bereichs",
  );
  await expect(page.locator("#terminal-diagnostics")).toContainText(
    "main.py:2",
  );
  await page.screenshot({ path: "test-results/learning-error-desktop.png" });
});
