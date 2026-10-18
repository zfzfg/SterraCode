import { test, expect } from "@playwright/test";

test("Java 25 und sichtbarer Installationsfortschritt bis zum Abschluss", async ({
  page,
}) => {
  let activeJob = null,
    latestJob = null;
  const program = {
    id: "java",
    name: "Java JDK 25",
    description: "Java mit javac und java",
    language: "java",
    state: "not-installed",
    installed: false,
  };
  await page.route("**/api/programs", (route) =>
    route.fulfill({
      json: {
        status: activeJob ? "maintenance" : "ready",
        programs: [program],
        activeJob,
        latestJob,
      },
    }),
  );
  await page.route("**/api/programs/java/actions", async (route) => {
    expect(route.request().postDataJSON().action).toBe("install");
    activeJob = {
      id: "fixture",
      programId: "java",
      state: "installing",
      stage: { current: 3, total: 6 },
      progress: "Programmpakete werden heruntergeladen.",
      log: "Get:1 msopenjdk-25 25.0.3-1",
    };
    await route.fulfill({ status: 202, json: { job: activeJob } });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const { openPrograms } = await import("/js/programs.js");
    void openPrograms();
  });
  const dialog = page.getByRole("dialog", { name: "Programme", exact: true });
  await expect(dialog.getByText("Java JDK 25", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "Installieren", exact: true })
    .click();
  const progress = dialog.getByRole("progressbar", {
    name: "Fortschritt: Java JDK 25",
  });
  await expect(progress).toHaveAttribute("value", "2");
  await expect(
    dialog.getByRole("status").filter({ hasText: "Schritt 3 von 6" }),
  ).toBeVisible();
  await dialog.getByText("Installationsdetails anzeigen").click();
  await expect(dialog.locator("pre")).toContainText("msopenjdk-25");
  activeJob.stage.current = 4;
  activeJob.progress = "Pakete werden entpackt und eingerichtet.";
  await expect(progress).toHaveAttribute("value", "3");
  await expect(dialog.locator("details")).toHaveAttribute("open", "");
  await page.screenshot({
    path: "test-results/java25-installation-progress.png",
  });
  latestJob = {
    ...activeJob,
    state: "succeeded",
    stage: { current: 6, total: 6 },
    progress: "Fertig.",
  };
  activeJob = null;
  program.installed = true;
  program.state = "installed";
  program.version = "javac 25.0.3";
  await expect(progress).toHaveAttribute("value", "6");
  await expect(
    dialog.getByText("Java JDK 25 · Abgeschlossen", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
});

test("Chat funktioniert ohne crypto.randomUUID wie unter LAN-HTTP", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(crypto, "randomUUID", { value: undefined }),
  );
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { randomUUID } = await import("/js/uuid.js");
    return { first: randomUUID(), second: randomUUID() };
  });
  expect(result.first).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(result.first).not.toBe(result.second);
  // Exercise the actual chat call site, including the question answer in the screenshot.
  await page
    .getByRole("button", { name: "Neue Session starten", exact: true })
    .click();
  await page
    .getByLabel("Name", { exact: true })
    .fill("LAN-HTTP UUID Regression");
  await page
    .getByRole("button", { name: "Session erstellen", exact: true })
    .click();
  const sent = page.waitForRequest(
    (req) => req.url().endsWith("/api/chat/stream") && req.method() === "POST",
  );
  await page.getByRole("button", { name: "Ja, bitte", exact: true }).click();
  expect((await sent).postDataJSON().turnId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(
    page.getByText("crypto.randomUUID is not a function", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".message.assistant").last()).toContainText(
    "Was möchtest du als Nächstes ausprobieren?",
  );
});
