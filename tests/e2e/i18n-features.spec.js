import { test, expect } from "@playwright/test";

for (const labels of [
  {
    locale: "en",
    projects: "Project workshop",
    guess: "Start Number guessing game",
    website: "Start My small website",
    hint: "Open next hint",
    tracer: "Python step by step",
    record: "Record Python file",
    profile: "Your learning profile",
    close: "Close",
    appearance: "Appearance",
  },
  {
    locale: "es",
    projects: "Taller de proyectos",
    guess: "Iniciar Juego de adivinar el número",
    website: "Iniciar Mi pequeña página web",
    hint: "Abrir la siguiente pista",
    tracer: "Python paso a paso",
    record: "Grabar archivo Python",
    profile: "Tu perfil de aprendizaje",
    close: "Cerrar",
    appearance: "Apariencia",
  },
])
  test(`localized offline projects, hints, profile, tracer and preview in ${labels.locale}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (locale) => localStorage.setItem("sterracode.uiLocale", locale),
      labels.locale,
    );
    await page.goto("/");
    await expect(page.locator("#new-session-btn")).toBeEnabled();
    await page.locator("#projects-btn").click();
    const projects = page.getByRole("dialog", {
      name: labels.projects,
      exact: true,
    });
    const response = page.waitForResponse(
      (value) =>
        value.url().endsWith("/api/projects/import") &&
        value.request().method() === "POST",
    );
    await projects
      .getByRole("button", { name: labels.guess, exact: true })
      .click();
    const session = await (await response).json();
    expect(session).toMatchObject({
      tutorLocale: labels.locale,
      project: { contentLocale: labels.locale },
    });
    await expect(projects).toBeHidden();
    await expect(page.locator("#file-path")).toHaveText("main.py");
    await page
      .locator("#task-panel")
      .getByRole("button", { name: labels.hint, exact: true })
      .click();
    await expect(page.locator("#task-panel")).toContainText("1/");
    await page.locator("#trace-open").click();
    const tracer = page.getByRole("dialog", {
      name: labels.tracer,
      exact: true,
    });
    await expect(
      tracer.getByRole("button", { name: labels.record, exact: true }),
    ).toBeVisible();
    await tracer
      .getByRole("button", { name: labels.close, exact: true })
      .click();
    await page.locator("#profile-btn").click();
    const profile = page.getByRole("dialog", {
      name: labels.profile,
      exact: true,
    });
    await expect(profile).toBeVisible();
    await profile
      .getByRole("button", { name: labels.close, exact: true })
      .click();
    await page.locator("#settings-btn").click();
    await expect(
      page.getByLabel(labels.appearance, { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator("#projects-btn").click();
    await projects
      .getByRole("button", { name: labels.website, exact: true })
      .click();
    await expect(projects).toBeHidden();
    await expect(page.locator("#file-path")).toHaveText("index.html");
    await page.locator("#preview-open").click();
    await expect(
      page.frameLocator(".preview-frame-host iframe").locator("html"),
    ).toHaveAttribute("lang", labels.locale);
  });
