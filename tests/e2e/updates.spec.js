import { test, expect } from "@playwright/test";

const available = {
  installed: "1.1.0",
  latest: "1.2.0",
  managed: true,
  available: true,
  installable: true,
  notesURL: "https://github.com/zfzfg/SterraCode/releases/tag/v1.2.0",
  operation: null,
  settings: { enabled: false, hour: 4, timeZone: "Europe/Berlin" },
};

test("shows an update, saves automatic settings and reconnects after installation", async ({
  page,
}) => {
  await page.clock.install();
  let value = structuredClone(available);
  let outage = false;
  let installed = false;
  await page.route("**/api/updates**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/updates/activity")
      return route.fulfill({ json: { ok: true } });
    if (url.pathname === "/api/updates/settings") {
      value.settings = route.request().postDataJSON();
      return route.fulfill({ json: value });
    }
    if (url.pathname === "/api/updates/install") {
      installed = true;
      value.operation = { id: "test-operation", phase: "draining" };
      return route.fulfill({ status: 202, json: value });
    }
    if (outage) return route.abort();
    return route.fulfill({ json: value });
  });
  await page.goto("/");
  await expect(page.locator("#update-banner")).toContainText("1.2.0");
  await page.screenshot({ path: "test-results/updates-banner.png" });
  await page.locator("#settings-btn").click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Updates", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("spinbutton").fill("5");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  expect(value.settings).toEqual({
    enabled: true,
    hour: 5,
    timeZone: "Europe/Berlin",
  });
  await page
    .getByRole("button", { name: "Update installieren", exact: true })
    .click();
  await expect(page.locator("#update-banner")).toContainText("aktualisiert");
  expect(installed).toBe(true);
  // A failed poll preserves the existing banner; the next successful poll refreshes it.
  outage = true;
  await page.clock.fastForward(31000);
  await expect(page.locator("#update-banner")).toContainText("aktualisiert");
  outage = false;
  value = {
    ...value,
    installed: "1.2.0",
    available: false,
    installable: false,
    operation: { id: "test-operation", phase: "succeeded" },
  };
  await page.clock.fastForward(31000);
  await expect(page.locator("#update-banner")).toContainText(
    "Installierte Version: 1.2.0",
  );
});

test("keeps an unmanaged installation usable and provides migration guidance", async ({
  page,
}) => {
  await page.route("**/api/updates**", (route) =>
    route.fulfill({
      json: {
        ...available,
        managed: false,
        installable: false,
        settings: null,
      },
    }),
  );
  await page.goto("/");
  await expect(page.locator("#update-banner a").last()).toHaveAttribute(
    "href",
    "https://sterra.online/code-install/",
  );
  await expect(page.locator("#update-banner button")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Neue Session starten", exact: true }),
  ).toBeEnabled();
});
test("shows executable local recovery commands when restoration needs attention", async ({
  page,
}) => {
  await page.route("**/api/updates**", (route) =>
    route.fulfill({
      json: {
        ...available,
        operation: {
          id: "failed",
          phase: "recovery-failed",
          recoveryCommand: ["bash manage.sh recover", ".\\manage.ps1 recover"],
        },
      },
    }),
  );
  await page.goto("/");
  await expect(page.locator("#update-banner")).toContainText(
    "bash manage.sh recover",
  );
  await expect(page.locator("#update-banner")).toContainText(
    ".\\manage.ps1 recover",
  );
  await expect(page.locator("#update-banner button")).toHaveCount(0);
});
