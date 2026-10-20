import { test, expect } from "@playwright/test";

test("long translated labels keep controls inside narrow layouts", async ({
  page,
  request,
}) => {
  const session = await (
    await request.post("/api/sessions", { data: { title: "Long labels" } })
  ).json();
  await page.addInitScript(() =>
    localStorage.setItem("sterracode.uiLocale", "en"),
  );
  await page.route(
    /\/i18n\/locales\/en\/(?:app|common|features)\.json$/,
    async (route) => {
      const response = await route.fetch();
      const expand = (value) =>
        typeof value === "string"
          ? `${value} — ${value}`
          : Object.fromEntries(
              Object.entries(value).map(([key, child]) => [key, expand(child)]),
            );
      await route.fulfill({ response, json: expand(await response.json()) });
    },
  );
  await page.goto("/");
  await expect(page.locator("#new-session-btn")).toBeEnabled();
  await page
    .locator("#sessions-list .session-open")
    .filter({ hasText: session.title })
    .click();
  for (const width of [800, 1024, 1366, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["dark", "light", "high-contrast", "solarized"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(page.locator("#ui-locale")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      for (const id of ["ui-locale", "settings-btn", "run-btn"]) {
        const box = await page.locator(`#${id}`).boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
    }
  }
});
