import { test, expect } from "@playwright/test";

test("Lernprofil ohne KI bedienen, Herkunft lesen, exportieren und bewusst löschen", async ({
  page,
  request,
}) => {
  await request.patch("/api/chat/settings", {
    data: { crossChatProfileEnabled: false },
  });
  await page.route("**/api/models", (route) =>
    route.fulfill({ json: { connected: false, models: [] } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Lernprofil", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dein Lernprofil" });
  await expect(dialog).toContainText("deaktiviert");
  await dialog
    .getByRole("button", { name: "Profil aktivieren", exact: true })
    .click();
  await expect(dialog).toContainText("Konzepte und Belege");
  await dialog
    .getByLabel("Mein persönliches Lernziel")
    .fill("Schleifen sicher erklären");
  await dialog
    .getByLabel("Zeitzone (z. B. Europe/Berlin)")
    .fill("Europe/Berlin");
  await dialog
    .getByRole("button", { name: "Lernziel und Planung speichern" })
    .click();
  const loops = dialog.locator("article").filter({
    has: page.getByRole("heading", {
      name: "Schleifen · python.loops",
      exact: true,
    }),
  });
  await loops
    .getByRole("button", { name: "Das beherrsche ich noch nicht", exact: true })
    .click();
  await expect(loops).toContainText("In Übung");
  await loops.getByText("Herkunft und Verlauf (1)", { exact: true }).click();
  await expect(loops).toContainText("Selbsteinschätzung");
  await expect(loops).toContainText("noch unsicher");
  for (const theme of ["dark", "light", "high-contrast", "solarized"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    await page.setViewportSize({ width: 360, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2),
    ).toBe(true);
  }
  await page.screenshot({ path: "test-results/profile-mobile.png" });
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Profil exportieren" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe(
    "sterracode-lernprofil.json",
  );
  await dialog.getByRole("button", { name: "Schließen", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Lernprofil", exact: true }).click();
  await expect(dialog.getByLabel("Mein persönliches Lernziel")).toHaveValue(
    "Schleifen sicher erklären",
  );
  await dialog
    .getByLabel("Profil und Wiederholungsdaten bewusst löschen")
    .check();
  await dialog
    .getByRole("button", { name: "Profil zurücksetzen", exact: true })
    .click();
  await expect(dialog.getByLabel("Mein persönliches Lernziel")).toHaveValue("");
  await dialog
    .getByRole("button", { name: "Profil deaktivieren", exact: true })
    .click();
  await expect(dialog).toContainText("deaktiviert");
});
