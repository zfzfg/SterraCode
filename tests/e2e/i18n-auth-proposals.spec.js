import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";

// Independent expectations deliberately do not read the product catalogs.
const languages = [
  {
    locale: "de",
    setupTitle: "SterraCode einrichten",
    setupKey: "Einrichtungsschlüssel",
    repeatInitial: "Passwort wiederholen",
    finishSetup: "Einrichtung abschließen",
    invalidSetupKey: "Einrichtungsschlüssel ist ungültig oder abgelaufen.",
    programsTitle: "Programme auswählen",
    continueConnection: "Weiter zur KI-Verbindung",
    connectTitle: "KI verbinden",
    cancel: "Abbrechen",
    newSession: "Neue Session",
    sessionName: "Name",
    createSession: "Session erstellen",
    profileTitle: "Dein Lernprofil",
    startReview: "Wiederholung starten",
    reviewConcept: "Schleifen",
    reviewTitle: "Freiwillige Wiederholung: Schleifen",
    reviewDescription:
      "Addiere mit einer Schleife die Zahlen von 1 bis n (einschließlich).",
    loginTitle: "Bei SterraCode anmelden",
    password: "Administratorpasswort",
    signIn: "Anmelden",
    invalidPassword: "Ungültiges Passwort.",
    settings: "Einstellungen",
    changePassword: "Passwort ändern",
    changeTitle: "Administratorpasswort ändern",
    currentPassword: "Bisheriges Passwort",
    newPassword: "Neues Passwort (mindestens 12 Zeichen)",
    repeatPassword: "Neues Passwort wiederholen",
    mismatch: "Die Passwörter stimmen nicht überein.",
    invalidCurrent: "Das bisherige Passwort ist ungültig.",
    passwordLength: "Das Passwort muss zwischen 12 und 1024 Zeichen lang sein.",
    save: "Speichern",
    signOut: "Abmelden",
    proposal: "Vorschlag",
    inspect: "Änderung ansehen",
    pending: "Offener Vorschlag",
    applied: "Übernommen",
    rejected: "Abgelehnt",
    undone: "Rückgängig gemacht",
    nextDifference: "Nächster Unterschied",
    apply: "Auswahl übernehmen",
    reject: "Ablehnen",
    undo: "Rückgängig",
    help: "Links: vorher / entfernte Zeilen. Rechts: nachher / hinzugefügte Zeilen. Die Begründung ist keine Garantie für korrekten Code.",
  },
  {
    locale: "en",
    setupTitle: "Set up SterraCode",
    setupKey: "Setup key",
    repeatInitial: "Repeat password",
    finishSetup: "Finish setup",
    invalidSetupKey: "The setup key is invalid or has expired.",
    programsTitle: "Select programs",
    continueConnection: "Continue to AI connection",
    connectTitle: "Connect AI",
    cancel: "Cancel",
    newSession: "New session",
    sessionName: "Name",
    createSession: "Create session",
    profileTitle: "Your learning profile",
    startReview: "Start review",
    reviewConcept: "Loops",
    reviewTitle: "Optional review: Loops",
    reviewDescription: "Use a loop to add the numbers from 1 to n, inclusive.",
    loginTitle: "Sign in to SterraCode",
    password: "Administrator password",
    signIn: "Sign in",
    invalidPassword: "Invalid password.",
    settings: "Settings",
    changePassword: "Change password",
    changeTitle: "Change administrator password",
    currentPassword: "Current password",
    newPassword: "New password (at least 12 characters)",
    repeatPassword: "Repeat new password",
    mismatch: "The passwords do not match.",
    invalidCurrent: "The current password is incorrect.",
    passwordLength: "The password must contain between 12 and 1024 characters.",
    save: "Save",
    signOut: "Sign out",
    proposal: "Proposal",
    inspect: "Inspect change",
    pending: "Pending proposal",
    applied: "Applied",
    rejected: "Rejected",
    undone: "Undone",
    nextDifference: "Next difference",
    apply: "Apply selection",
    reject: "Reject",
    undo: "Undo",
    help: "Left: before / removed lines. Right: after / added lines. The explanation does not guarantee correct code.",
  },
  {
    locale: "es",
    setupTitle: "Configurar SterraCode",
    setupKey: "Clave de configuración",
    repeatInitial: "Repetir contraseña",
    finishSetup: "Completar configuración",
    invalidSetupKey: "La clave de configuración no es válida o ha caducado.",
    programsTitle: "Seleccionar programas",
    continueConnection: "Continuar a la conexión con IA",
    connectTitle: "Conectar IA",
    cancel: "Cancelar",
    newSession: "Nueva sesión",
    sessionName: "Nombre",
    createSession: "Crear sesión",
    profileTitle: "Tu perfil de aprendizaje",
    startReview: "Iniciar repaso",
    reviewConcept: "Bucles",
    reviewTitle: "Repaso voluntario: Bucles",
    reviewDescription:
      "Usa un bucle para sumar los números del 1 al n, ambos incluidos.",
    loginTitle: "Iniciar sesión en SterraCode",
    password: "Contraseña de administrador",
    signIn: "Iniciar sesión",
    invalidPassword: "La contraseña no es válida.",
    settings: "Ajustes",
    changePassword: "Cambiar contraseña",
    changeTitle: "Cambiar contraseña de administrador",
    currentPassword: "Contraseña actual",
    newPassword: "Nueva contraseña (al menos 12 caracteres)",
    repeatPassword: "Repetir nueva contraseña",
    mismatch: "Las contraseñas no coinciden.",
    invalidCurrent: "La contraseña actual no es correcta.",
    passwordLength: "La contraseña debe tener entre 12 y 1024 caracteres.",
    save: "Guardar",
    signOut: "Cerrar sesión",
    proposal: "Propuesta",
    inspect: "Ver cambio",
    pending: "Propuesta pendiente",
    applied: "Aplicado",
    rejected: "Rechazado",
    undone: "Deshecho",
    nextDifference: "Siguiente diferencia",
    apply: "Aplicar selección",
    reject: "Rechazar",
    undo: "Deshacer",
    help: "Izquierda: antes / líneas eliminadas. Derecha: después / líneas añadidas. La explicación no garantiza que el código sea correcto.",
  },
];

async function selectInitialLocale(page, locale) {
  await page.addInitScript((value) => {
    if (!sessionStorage.getItem("sterracode.i18nAuthProposalSeeded")) {
      localStorage.setItem("sterracode.uiLocale", value);
      sessionStorage.setItem("sterracode.i18nAuthProposalSeeded", "1");
    }
  }, locale);
  await page.route("**/api/models**", (route) =>
    route.fulfill({ json: { connected: false, models: [] } }),
  );
}

test.describe("localized authenticated account flows", () => {
  let server, directory, baseURL, auth, storage, profile;
  const initialPassword = "I18n-Fixture-Initial-2026";
  const changedPassword = "I18n-Fixture-Changed-2026";

  test.beforeAll(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "sterracode-i18n-auth-"),
    );
    process.env.STERRACODE_DATA_DIR = directory;
    storage = await import("../../server/services/storage.js");
    profile = await import("../../server/services/profileManager.js");
    const { createAuthService } = await import("../../server/services/auth.js");
    const { loadConfig } = await import("../../server/config.js");
    const { createApp } = await import("../../server/app.js");
    await storage.ensureDataDirs();
    auth = createAuthService({ dataDir: directory });
    server = http.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    server.on(
      "request",
      createApp({
        config: loadConfig({
          STERRACODE_MODE: "server",
          STERRACODE_DATA_DIR: directory,
          STERRACODE_PUBLIC_URL: baseURL,
        }),
        auth,
      }),
    );
  });

  test.afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (
      directory &&
      path
        .resolve(directory)
        .startsWith(
          path.resolve(os.tmpdir()) + path.sep + "sterracode-i18n-auth-",
        )
    )
      await fs.rm(directory, { recursive: true, force: true });
  });

  for (const language of languages) {
    test(`${language.locale}: setup, session creation, password errors, password change and sign out use the selected language`, async ({
      page,
      context,
    }) => {
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const setupKey = await auth.createSetupKey({ reset: true });
      await selectInitialLocale(page, "de");
      await page.route("**/api/programs", (route) =>
        route.fulfill({
          json: { status: "ready", programs: [], activeJob: null },
        }),
      );
      await page.goto(baseURL);
      await expect(
        page.getByRole("heading", {
          name: "SterraCode einrichten",
          exact: true,
        }),
      ).toBeVisible();
      await page.locator(".access-dialog select").selectOption(language.locale);
      await expect(page.locator("html")).toHaveAttribute(
        "lang",
        language.locale,
      );
      const setup = page.getByRole("dialog", {
        name: language.setupTitle,
        exact: true,
      });
      await setup
        .getByLabel(language.setupKey, { exact: true })
        .fill("invalid-fixture-setup-key");
      await setup
        .getByLabel(language.password, { exact: true })
        .fill(initialPassword);
      await setup
        .getByLabel(language.repeatInitial, { exact: true })
        .fill(initialPassword);
      await setup
        .getByRole("button", { name: language.finishSetup, exact: true })
        .click();
      await expect(setup.getByRole("alert")).toHaveText(
        language.invalidSetupKey,
      );
      await setup.getByLabel(language.setupKey, { exact: true }).fill(setupKey);
      await setup
        .getByRole("button", { name: language.finishSetup, exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: language.programsTitle, exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: language.continueConnection, exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: language.connectTitle, exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: language.cancel, exact: true })
        .click();
      await expect(page.locator("#new-session-btn")).toBeEnabled();
      await page.locator("#new-session-btn").click();
      const newSession = page.getByRole("dialog", {
        name: language.newSession,
        exact: true,
      });
      const title = `i18n-setup-session-${language.locale}`;
      await newSession
        .getByLabel(language.sessionName, { exact: true })
        .fill(title);
      const created = page.waitForResponse(
        (response) =>
          response.url() === `${baseURL}/api/sessions` &&
          response.request().method() === "POST",
      );
      await newSession
        .getByRole("button", { name: language.createSession, exact: true })
        .click();
      expect((await (await created).json()).tutorLocale).toBe(language.locale);
      await expect(page.locator("#session-title")).toHaveText(title);
      await page
        .getByRole("button", { name: language.settings, exact: true })
        .click();
      await page
        .getByRole("button", { name: language.signOut, exact: true })
        .click();
      const access = page.getByRole("dialog", {
        name: language.loginTitle,
        exact: true,
      });
      await expect(access).toBeVisible();
      await access
        .getByLabel(language.password, { exact: true })
        .fill("incorrect-fixture-password");
      await access
        .getByRole("button", { name: language.signIn, exact: true })
        .click();
      await expect(access.getByRole("alert")).toHaveText(
        language.invalidPassword,
      );
      await access
        .getByLabel(language.password, { exact: true })
        .fill(initialPassword);
      await access
        .getByRole("button", { name: language.signIn, exact: true })
        .click();
      await expect(page.locator("#new-session-btn")).toBeEnabled();
      const previousToken = (await context.cookies(baseURL)).find(
        (cookie) => cookie.name === "sterracode.session",
      ).value;
      await page
        .getByRole("button", { name: language.settings, exact: true })
        .click();
      await page
        .getByRole("button", { name: language.changePassword, exact: true })
        .click();
      const change = page.getByRole("dialog", {
        name: language.changeTitle,
        exact: true,
      });
      await expect(change).toBeVisible();
      await change
        .getByLabel(language.currentPassword, { exact: true })
        .fill("wrong-current-password");
      await change
        .getByLabel(language.newPassword, { exact: true })
        .fill(changedPassword);
      await change
        .getByLabel(language.repeatPassword, { exact: true })
        .fill("mismatched-fixture-password");
      await change
        .getByRole("button", { name: language.save, exact: true })
        .click();
      await expect(change.getByRole("alert")).toHaveText(language.mismatch);
      await change
        .getByLabel(language.repeatPassword, { exact: true })
        .fill(changedPassword);
      await change
        .getByRole("button", { name: language.save, exact: true })
        .click();
      await expect(change.getByRole("alert")).toHaveText(
        language.invalidCurrent,
      );
      await change
        .getByLabel(language.currentPassword, { exact: true })
        .fill(initialPassword);
      await change
        .getByLabel(language.newPassword, { exact: true })
        .fill("short");
      await change
        .getByLabel(language.repeatPassword, { exact: true })
        .fill("short");
      await change
        .getByRole("button", { name: language.save, exact: true })
        .click();
      await expect(change.getByRole("alert")).toHaveText(
        language.passwordLength,
      );
      await change
        .getByLabel(language.newPassword, { exact: true })
        .fill(changedPassword);
      await change
        .getByLabel(language.repeatPassword, { exact: true })
        .fill(changedPassword);
      await change
        .getByRole("button", { name: language.save, exact: true })
        .click();
      await expect(change).not.toBeVisible();
      expect(
        (
          await page.request.get(`${baseURL}/api/chat/settings`, {
            headers: { Cookie: `sterracode.session=${previousToken}` },
          })
        ).status(),
      ).toBe(401);
      await page
        .getByRole("button", { name: language.settings, exact: true })
        .click();
      await page
        .getByRole("button", { name: language.signOut, exact: true })
        .click();
      await expect(access).toBeVisible();
      await expect(
        access.getByLabel(language.password, { exact: true }),
      ).toHaveValue("");
      await access
        .getByLabel(language.password, { exact: true })
        .fill(initialPassword);
      await access
        .getByRole("button", { name: language.signIn, exact: true })
        .click();
      await expect(access.getByRole("alert")).toHaveText(
        language.invalidPassword,
      );
      await access
        .getByLabel(language.password, { exact: true })
        .fill(changedPassword);
      await access
        .getByRole("button", { name: language.signIn, exact: true })
        .click();
      await expect(page.locator("#new-session-btn")).toBeEnabled();
      await expect(access).not.toBeVisible();
      await expect(page.locator("html")).toHaveAttribute(
        "lang",
        language.locale,
      );
      expect(errors).toEqual([]);
    });
  }
  for (const language of languages) {
    test(`${language.locale}: a real due profile review starts once with localized task content`, async ({
      page,
    }) => {
      expect(path.resolve(storage.DATA_DIR)).toBe(path.resolve(directory));
      await auth.createSetupKey({ reset: true });
      await auth.initializePassword(initialPassword);
      await storage.updateSettings({
        crossChatProfileEnabled: true,
        autoUpdateProfileOnTaskDone: true,
      });
      const profilePath = path.join(directory, "profiles", "user.json");
      await fs.rm(profilePath, { force: true });
      const originalEvidence = {
        schemaVersion: 1,
        eventId: randomUUID(),
        type: "task_completed",
        sessionId: randomUUID(),
        taskId: randomUUID(),
        taskVersion: 1,
        language: "python",
        conceptIds: ["python.loops"],
        occurredAt: new Date(Date.now() - 10 * 86400000).toISOString(),
        evidence: {
          kind: "test_run",
          outcome: "passed",
          assistance: "independent",
        },
      };
      const seeded = await profile.getProfile();
      seeded.events = [originalEvidence];
      await storage.writeJSON(profilePath, seeded);
      const due = (await profile.getProfile()).reviews.find(
        (review) => review.conceptId === "python.loops",
      );
      expect(due).toBeTruthy();
      await selectInitialLocale(page, language.locale);
      await page.goto(baseURL);
      const access = page.getByRole("dialog", {
        name: language.loginTitle,
        exact: true,
      });
      await access
        .getByLabel(language.password, { exact: true })
        .fill(initialPassword);
      await access
        .getByRole("button", { name: language.signIn, exact: true })
        .click();
      await expect(page.locator("#new-session-btn")).toBeEnabled();
      await page.locator("#profile-btn").click();
      const dialog = page.getByRole("dialog", {
        name: language.profileTitle,
        exact: true,
      });
      await expect(
        dialog.getByRole("heading", {
          name: language.reviewConcept,
          exact: true,
        }),
      ).toBeVisible();
      const startURL = `${baseURL}/api/profile/reviews/${due.reviewId}/start`;
      const started = page.waitForResponse(
        (response) =>
          response.url() === startURL && response.request().method() === "POST",
      );
      await dialog
        .getByRole("button", { name: language.startReview, exact: true })
        .click();
      const response = await started;
      expect(response.ok()).toBeTruthy();
      const requestBody = response.request().postDataJSON();
      expect(requestBody).toEqual({ tutorLocale: language.locale });
      expect(response.request().headers()["accept-language"]).toBe(
        language.locale,
      );
      const session = await response.json();
      expect(session.tutorLocale).toBe(language.locale);
      expect(session.currentTask.contentLocale).toBe(language.locale);
      expect(session.currentTask.contentProvenance).toMatchObject({
        kind: "review",
        id: "python.loops",
        contentLocale: language.locale,
      });
      expect(session.currentTask.title).toBe(language.reviewTitle);
      expect(session.currentTask.reviewId).toBe(due.reviewId);
      expect(session.currentTask.testSuite.entry).toEqual({
        path: "main.py",
        function: "sum_to",
      });
      await expect(dialog).not.toBeVisible();
      await expect(page.locator("#session-title")).toHaveText(
        language.reviewTitle,
      );
      await expect(page.locator("#task-panel")).toContainText(
        language.reviewDescription,
      );
      const duplicates = await Promise.all(
        [1, 2].map(() =>
          page.request.post(startURL, {
            data: requestBody,
            headers: { "Accept-Language": language.locale },
          }),
        ),
      );
      for (const duplicate of duplicates) {
        expect(duplicate.ok()).toBeTruthy();
        expect((await duplicate.json()).id).toBe(session.id);
      }
      const sessions = await (
        await page.request.get(`${baseURL}/api/sessions`)
      ).json();
      const reviewSessions = [];
      for (const row of sessions) {
        const value = await (
          await page.request.get(`${baseURL}/api/sessions/${row.id}`)
        ).json();
        if (value.currentTask?.reviewId === due.reviewId)
          reviewSessions.push(value);
      }
      expect(reviewSessions).toHaveLength(1);
      expect(JSON.parse(await fs.readFile(profilePath, "utf8")).events).toEqual(
        [originalEvidence],
      );
    });
  }
});

const originalSource = "a\n" + "context\n".repeat(8) + "b\n";
const appliedSource = "A\n" + "context\n".repeat(8) + "B\n";
async function seedProposal(request, locale) {
  await request.patch("/api/chat/settings", {
    data: {
      provider: "lmstudio",
      activeModel: "Lokaler Test-Tutor",
      reviewAIChanges: true,
    },
  });
  const session = await (
    await request.post("/api/sessions", {
      data: {
        title: `i18n-review-${locale}-${Date.now()}`,
        language: "python",
        tutorLocale: locale,
      },
    })
  ).json();
  const base = `/api/workspaces/${session.id}`;
  const original = await (
    await request.post(`${base}/files`, {
      data: { path: "review.py", content: originalSource, type: "file" },
    })
  ).json();
  const result = await request.post("/api/chat", {
    data: {
      sessionId: session.id,
      userMessage: `erstelle eine Übung REVIEW_HUNKS:${original.version}`,
    },
  });
  expect(result.ok()).toBeTruthy();
  const proposals = await (await request.get(`${base}/proposals`)).json();
  expect(proposals).toHaveLength(1);
  return { session, proposal: proposals[0], base, original };
}
async function openProposal(page, session, language) {
  await page.goto("/");
  await expect(page.locator("#new-session-btn")).toBeEnabled();
  await expect(page.locator("html")).toHaveAttribute("lang", language.locale);
  await page
    .locator(".session-open")
    .filter({ hasText: session.title })
    .first()
    .click();
  await page.locator("#changes-btn").click();
  await page
    .getByRole("button", { name: new RegExp(`^${language.proposal}:`) })
    .first()
    .click();
  const dialog = page.getByRole("dialog", {
    name: language.inspect,
    exact: true,
  });
  await expect(
    dialog.locator(".diff-editor .monaco-diff-editor"),
  ).toBeVisible();
  await expect(dialog.getByText(language.help, { exact: true })).toBeVisible();
  return dialog;
}

test.describe("localized proposal decisions", () => {
  test.afterEach(async ({ request }) => {
    await request.patch("/api/chat/settings", {
      data: { reviewAIChanges: false },
    });
  });
  for (const language of languages) {
    test(`${language.locale}: inspect, accept, undo and reject preserve source and localized proposal states`, async ({
      page,
      request,
    }) => {
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await selectInitialLocale(page, language.locale);
      const first = await seedProposal(request, language.locale);
      let dialog = await openProposal(page, first.session, language);
      await expect(dialog).toContainText(language.pending);
      await expect(dialog.locator(".diff-hunk input")).toHaveCount(2);
      await dialog
        .getByRole("button", { name: language.nextDifference, exact: true })
        .click();
      await dialog
        .getByRole("button", { name: language.apply, exact: true })
        .click();
      await expect(page.locator(".diff-dialog")).toHaveCount(0);
      expect(
        (
          await (
            await request.get(
              `${first.base}/proposals/${first.proposal.proposalId}`,
            )
          ).json()
        ).status,
      ).toBe("applied");
      expect(
        (
          await (
            await request.get(`${first.base}/files/content?path=review.py`)
          ).json()
        ).content,
      ).toBe(appliedSource);
      dialog = await openProposal(page, first.session, language);
      await expect(dialog).toContainText(language.applied);
      await dialog
        .getByRole("button", { name: language.undo, exact: true })
        .click();
      await expect(page.locator(".diff-dialog")).toHaveCount(0);
      const restored = await (
        await request.get(`${first.base}/files/content?path=review.py`)
      ).json();
      expect(restored.content).toBe(originalSource);
      expect(restored.version).toBe(first.original.version);
      dialog = await openProposal(page, first.session, language);
      await expect(dialog).toContainText(language.undone);
      await page.keyboard.press("Escape");
      const second = await seedProposal(request, language.locale);
      dialog = await openProposal(page, second.session, language);
      await dialog
        .getByRole("button", { name: language.reject, exact: true })
        .click();
      await expect(page.locator(".diff-dialog")).toHaveCount(0);
      expect(
        (
          await (
            await request.get(
              `${second.base}/proposals/${second.proposal.proposalId}`,
            )
          ).json()
        ).status,
      ).toBe("rejected");
      const untouched = await (
        await request.get(`${second.base}/files/content?path=review.py`)
      ).json();
      expect(untouched.content).toBe(originalSource);
      expect(untouched.version).toBe(second.original.version);
      dialog = await openProposal(page, second.session, language);
      await expect(dialog).toContainText(language.rejected);
      await expect(
        dialog.getByRole("button", { name: language.apply, exact: true }),
      ).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
});
