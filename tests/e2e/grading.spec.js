import { test, expect } from "@playwright/test";

test("Aufgabe offline prüfen, Fehler korrigieren, historischen Stand lesen und einmalig abschließen", async ({
  page,
  request,
}) => {
  const s = await (
    await request.post("/api/sessions", {
      data: { title: "Test-Lernablauf", language: "python" },
    })
  ).json();
  const base = `/api/workspaces/${s.id}`;
  async function code(content) {
    const f = await (
      await request.get(`${base}/files/content?path=main.py`)
    ).json();
    expect(
      (
        await request.put(`${base}/files/content`, {
          data: { path: "main.py", expectedVersion: f.version, content },
        })
      ).ok(),
    ).toBeTruthy();
  }
  await code("def reverse_string(s):\n    return s\n");
  await page.goto("/");
  await page
    .getByRole("button", { name: "Test-Lernablauf", exact: true })
    .first()
    .click();
  await page.locator("#chat-input").fill("GRADING_FIXTURE");
  await page.locator("#send-btn").click();
  const panel = page.locator("#task-panel");
  await expect(panel).toContainText("Strings umkehren");
  await page.route("**/api/models", (route) =>
    route.fulfill({ json: { connected: false, models: [] } }),
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Test-Lernablauf", exact: true })
    .first()
    .click();
  await panel
    .getByRole("button", { name: "Lösung prüfen", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("Tests fehlgeschlagen");
  await expect(panel).toContainText('Erhalten (string): "hello"');
  await expect(
    panel.getByRole("button", { name: "Aufgabe abschließen", exact: true }),
  ).toBeDisabled();
  await code("def reverse_string(s):\n    return s[::-1]\n");
  await expect(panel.getByRole("status")).toContainText("Älterer Stand");
  await page.reload();
  await page
    .getByRole("button", { name: "Test-Lernablauf", exact: true })
    .first()
    .click();
  await expect(panel.getByRole("status")).toContainText("Älterer Stand");
  await panel
    .getByRole("button", { name: "Lösung prüfen", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText(
    "Erforderliche Tests bestanden",
  );
  for (const theme of ["dark", "light", "high-contrast", "solarized"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    await page.setViewportSize({ width: 640, height: 800 });
    await page.getByRole("button", { name: "KI-Tutor", exact: true }).click();
    expect(
      await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
    ).toBe(true);
  }
  await page.screenshot({ path: "test-results/grading-mobile.png" });
  await panel
    .getByRole("button", { name: "Aufgabe abschließen", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Aufgabe abgeschlossen", exact: true }),
  ).toBeDisabled();
  const saved = await (await request.get(`/api/sessions/${s.id}`)).json();
  expect(saved.currentTask.completion.evidence.kind).toBe("test_run");
  expect(
    await (
      await request.get(`${base}/tasks/${saved.currentTask.id}/test-runs`)
    ).json(),
  ).toHaveLength(2);
});

test("Weiterlernen verlangt bestandene aktuelle Tests und erhält den Testnachweis", async ({
  page,
  request,
}) => {
  const s = await (
    await request.post("/api/sessions", {
      data: { title: "Weiter mit Testnachweis", language: "python" },
    })
  ).json();
  const base = `/api/workspaces/${s.id}`;
  const file = await (
    await request.get(`${base}/files/content?path=main.py`)
  ).json();
  await request.put(`${base}/files/content`, {
    data: {
      path: "main.py",
      expectedVersion: file.version,
      content: "def reverse_string(s):\n    return s[::-1]\n",
    },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: s.title, exact: true })
    .first()
    .click();
  await page.locator("#chat-input").fill("GRADING_FIXTURE");
  await page.locator("#send-btn").click();
  const panel = page.locator("#task-panel");
  await expect(panel).toContainText("Strings umkehren");
  await expect(page.locator("#send-btn")).toBeEnabled();
  let turns = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/chat/stream")) turns++;
  });
  const next = panel.getByRole("button", {
    name: "Abgeschlossen – nächste Aufgabe",
    exact: true,
  });
  await next.click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Bitte zuerst die aktuelle Lösung prüfen" }),
  ).toBeVisible();
  expect(turns).toBe(0);
  expect(
    (await (await request.get(`/api/sessions/${s.id}`)).json()).currentTask
      .done,
  ).toBeFalsy();
  await panel
    .getByRole("button", { name: "Lösung prüfen", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText(
    "Erforderliche Tests bestanden",
  );
  await next.click();
  await expect(
    panel.getByRole("button", { name: "Aufgabe abgeschlossen", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#send-btn")).toBeEnabled();
  expect(turns).toBe(1);
  const saved = await (await request.get(`/api/sessions/${s.id}`)).json();
  expect(saved.currentTask.completion.evidence.kind).toBe("test_run");
});
