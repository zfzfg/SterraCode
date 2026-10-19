import { test, expect } from "@playwright/test";
async function seed(request, partial = false) {
  await request.patch("/api/chat/settings", {
    data: { reviewAIChanges: true },
  });
  const s = await (
    await request.post("/api/sessions", {
      data: { title: `Diff-Review-${Date.now()}`, language: "python" },
    })
  ).json();
  let suffix = "";
  if (partial) {
    const f = await (
      await request.post(`/api/workspaces/${s.id}/files`, {
        data: {
          path: "review.py",
          content: "a\n" + "context\n".repeat(8) + "b\n",
        },
      })
    ).json();
    suffix = ` REVIEW_HUNKS:${f.version}`;
  }
  const r = await request.post("/api/chat", {
    data: { sessionId: s.id, userMessage: "erstelle eine \u00fcbung" + suffix },
  });
  expect(r.ok()).toBeTruthy();
  const proposals = await (
    await request.get(`/api/workspaces/${s.id}/proposals`)
  ).json();
  expect(proposals).toHaveLength(1);
  return { s, p: proposals[0], base: `/api/workspaces/${s.id}` };
}
async function open(page, s) {
  await page.goto("/");
  await page
    .locator(".session-open")
    .filter({ hasText: s.title })
    .first()
    .click();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await page.locator("#changes-btn").click();
  await page
    .getByRole("button", { name: /^Vorschlag:/ })
    .first()
    .click();
  await expect(page.locator(".diff-editor .monaco-diff-editor")).toBeVisible();
}
test.afterEach(async ({ request }) => {
  await request.patch("/api/chat/settings", {
    data: { reviewAIChanges: false },
  });
});
test("persisted review, partial apply, exact history and undo with keyboard and all themes", async ({
  page,
  request,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { s, p, base } = await seed(request, true);
  await open(page, s);
  await expect(page.locator(".diff-hunk input")).toHaveCount(2);
  for (const theme of ["dark", "light", "high-contrast", "solarized"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      window.dispatchEvent(new Event("theme-changed"));
    }, theme);
    await page.screenshot({ path: testInfo.outputPath(`diff-${theme}.png`) });
  }
  await page.getByRole("button", { name: "N\u00e4chster Unterschied" }).click();
  await page.locator(".diff-hunk input").nth(1).uncheck();
  await page.getByRole("button", { name: "Auswahl \u00fcbernehmen" }).click();
  await expect(page.locator(".diff-dialog")).toHaveCount(0);
  const applied = await (
    await request.get(`${base}/proposals/${p.proposalId}`)
  ).json();
  expect(applied.status).toBe("partially_applied");
  const f = await (
    await request.get(`${base}/files/content?path=review.py`)
  ).json();
  expect(f.content).toBe("A\n" + "context\n".repeat(8) + "b\n");
  await page.reload();
  await page.locator(".session-open").filter({ hasText: s.title }).click();
  await page.setViewportSize({ width: 600, height: 800 });
  await page.locator("#changes-btn").click();
  await page
    .getByRole("button", { name: /^Vorschlag:/ })
    .first()
    .click();
  await expect(page.locator(".diff-editor .monaco-diff-editor")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("diff-narrow.png") });
  expect(
    await page.evaluate(() =>
      monaco.editor
        .getModels()
        .filter((model) => model.uri.scheme === "inmemory")
        .map((model) => model.getValue()),
    ),
  ).toContain("A\n" + "context\n".repeat(8) + "b\n");
  await page
    .getByRole("button", { name: "R\u00fcckg\u00e4ngig", exact: true })
    .click();
  await expect(page.locator(".diff-dialog")).toHaveCount(0);
  expect(
    (await (await request.get(`${base}/files/content?path=review.py`)).json())
      .content,
  ).toBe("a\n" + "context\n".repeat(8) + "b\n");
  expect(errors).toEqual([]);
});
test("whole acceptance and rejection survive reload; stale basis never overwrites", async ({
  page,
  request,
}) => {
  const { s, p, base } = await seed(request);
  expect(
    (await request.get(`${base}/files/content?path=uebung.py`)).status(),
  ).toBe(404);
  await open(page, s);
  await page.keyboard.press("Escape");
  await page.reload();
  await page.locator(".session-open").filter({ hasText: s.title }).click();
  await page.locator("#changes-btn").click();
  await page
    .getByRole("button", { name: /^Vorschlag:/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Auswahl \u00fcbernehmen" }).click();
  await expect(page.locator(".diff-dialog")).toHaveCount(0);
  expect(
    (await request.get(`${base}/files/content?path=uebung.py`)).ok(),
  ).toBeTruthy();
  expect(
    (await (await request.get(`${base}/proposals/${p.proposalId}`)).json())
      .status,
  ).toBe("applied");
  const next = await seed(request, true);
  await open(page, next.s);
  const f = await (
    await request.get(`${next.base}/files/content?path=review.py`)
  ).json();
  await request.put(`${next.base}/files/content`, {
    data: { path: f.path, content: "newer", expectedVersion: f.version },
  });
  await page.getByRole("button", { name: "Auswahl \u00fcbernehmen" }).click();
  await expect(page.locator("#toasts")).toContainText("veraltet");
  expect(
    (
      await (
        await request.get(`${next.base}/files/content?path=review.py`)
      ).json()
    ).content,
  ).toBe("newer");
  await page.getByRole("button", { name: "Ablehnen", exact: true }).click();
  await expect(page.locator(".diff-dialog")).toHaveCount(0);
  expect(
    (
      await (
        await request.get(`${next.base}/proposals/${next.p.proposalId}`)
      ).json()
    ).status,
  ).toBe("rejected");
});

test("Auto Accept and Review can be selected explicitly and persist", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator("#welcome-new")).toBeEnabled();
  await page.locator("#settings-btn").click();
  const mode = page.getByRole("combobox", {
    name: "KI-Datei\u00e4nderungen",
    exact: true,
  });
  await expect(mode).toHaveValue("false");
  await mode.selectOption("true");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByText("Einstellungen gespeichert.", { exact: true }),
  ).toBeVisible();
  expect(
    (await (await request.get("/api/chat/settings")).json()).reviewAIChanges,
  ).toBe(true);
  await page.reload();
  await expect(page.locator("#welcome-new")).toBeEnabled();
  await page.locator("#settings-btn").click();
  await expect(mode).toHaveValue("true");
  await mode.selectOption("false");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByText("Einstellungen gespeichert.", { exact: true }),
  ).toBeVisible();
  const s = await (
    await request.post("/api/sessions", {
      data: { title: "Auto Accept", language: "python" },
    })
  ).json();
  await request.post("/api/chat", {
    data: { sessionId: s.id, userMessage: "erstelle eine \u00fcbung" },
  });
  expect(
    (
      await request.get(`/api/workspaces/${s.id}/files/content?path=uebung.py`)
    ).ok(),
  ).toBeTruthy();
  expect(
    await (await request.get(`/api/workspaces/${s.id}/proposals`)).json(),
  ).toEqual([]);
  expect(
    await (await request.get(`/api/workspaces/${s.id}/changes`)).json(),
  ).toHaveLength(1);
});
