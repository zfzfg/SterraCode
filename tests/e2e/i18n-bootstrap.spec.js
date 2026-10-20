import { test, expect } from "@playwright/test";

test("a fresh browser starts in English despite a German browser locale", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.removeItem("sterracode.uiLocale"),
  );
  await page.goto("/");
  await expect(page.locator("#new-session-btn")).toBeEnabled();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("#ui-locale")).toHaveValue("en");
  await page.locator("#new-session-btn").click();
  const dialog = page.getByRole("dialog", { name: "New session", exact: true });
  await expect(
    dialog.getByLabel("Tutor language", { exact: true }),
  ).toHaveValue("en");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("login language changes preserve password input", async ({ page }) => {
  await page.route("**/api/setup/status", (route) =>
    route.fulfill({
      json: { authRequired: true, authenticated: false, setupRequired: false },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Bei SterraCode anmelden" }),
  ).toBeVisible();
  await page
    .getByLabel("Administratorpasswort", { exact: true })
    .fill("unsaved-password");
  await page
    .getByRole("combobox", { name: "Oberflächensprache" })
    .selectOption("en");
  await expect(
    page.getByRole("heading", { name: "Sign in to SterraCode" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Administrator password", { exact: true }),
  ).toHaveValue("unsaved-password");
  await page.locator(".access-dialog select").selectOption("es");
  await expect(
    page.getByRole("heading", { name: "Iniciar sesión en SterraCode" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Contraseña de administrador", { exact: true }),
  ).toHaveValue("unsaved-password");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Iniciar sesión en SterraCode" }),
  ).toBeVisible();
});
