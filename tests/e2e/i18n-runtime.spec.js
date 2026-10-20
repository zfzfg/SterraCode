import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

// These fixtures exercise the browser's Runner protocol consumer. They do not
// install host programs or claim Linux/container execution coverage.
const languages = {
  de: {
    programs: "Programme",
    install: "Installieren",
    repair: "Paketdatenbank reparieren",
    close: "Schließen",
    details: "Installationsdetails anzeigen",
    cache: "Downloadcache leeren",
    cached:
      "Downloadcache geleert. Eine Offline-Wiederherstellung benötigt diesen Cache.",
    progress: "Fortschritt: Python fixture",
    step: (current) => `Schritt ${current} von 6: `,
    completed: "Abgeschlossen",
    interrupted: "Unterbrochen",
    missing: "Laufzeit fehlt: Python installieren und Anwendung neu prüfen.",
    restart:
      "Runner während Paketaktion beendet. Paketdatenbank wird geprüft; Aktion kann wiederholt werden.",
    terminalFailure: "Start fehlgeschlagen: EACCES native fixture detail",
    terminalEnded: "Beendet · durch Runner-Neustart unterbrochen",
    stages: [
      "Paketdatenbank und Speicher werden geprüft.",
      "Signierte Paketlisten und festgeschriebene Versionen werden geladen.",
      "Programmpakete werden heruntergeladen.",
      "Pakete werden entpackt und eingerichtet.",
      "Abhängigkeiten und Prüfsummen werden für die Wiederherstellung gesichert.",
      "Installierte Laufzeit und Version werden geprüft.",
    ],
  },
  en: {
    programs: "Programs",
    install: "Install",
    repair: "Repair package database",
    close: "Close",
    details: "Show installation details",
    cache: "Clear download cache",
    cached: "Download cache cleared. Offline recovery requires this cache.",
    progress: "Progress: Python fixture",
    step: (current) => `Step ${current} of 6: `,
    completed: "Completed",
    interrupted: "Interrupted",
    missing: "Runtime missing: install Python and check the application again.",
    restart:
      "Runner stopped during a package action. The package database will be checked; the action can be retried.",
    terminalFailure: "Failed to start: EACCES native fixture detail",
    terminalEnded: "Finished · interrupted by runner restart",
    stages: [
      "Checking package database and storage.",
      "Loading signed package lists and pinned versions.",
      "Downloading program packages.",
      "Unpacking and setting up packages.",
      "Saving dependencies and checksums for recovery.",
      "Checking installed runtime and version.",
    ],
  },
  es: {
    programs: "Programas",
    install: "Instalar",
    repair: "Reparar la base de datos de paquetes",
    close: "Cerrar",
    details: "Mostrar detalles de la instalación",
    cache: "Vaciar la caché de descargas",
    cached:
      "Se ha vaciado la caché de descargas. La restauración sin conexión necesita esta caché.",
    progress: "Progreso: Python fixture",
    step: (current) => `Paso ${current} de 6: `,
    completed: "Completado",
    interrupted: "Interrumpido",
    missing:
      "Falta el entorno de ejecución: instala Python y vuelve a comprobar la aplicación.",
    restart:
      "El ejecutor se detuvo durante una acción de paquetes. Se comprobará la base de datos de paquetes; puedes repetir la acción.",
    terminalFailure: "No se ha podido iniciar: EACCES native fixture detail",
    terminalEnded: "Finalizado · interrumpido por el reinicio del runner",
    stages: [
      "Comprobando la base de datos de paquetes y el almacenamiento.",
      "Cargando las listas de paquetes firmadas y las versiones fijadas.",
      "Descargando paquetes del programa.",
      "Descomprimiendo y configurando paquetes.",
      "Guardando dependencias y sumas de comprobación para la restauración.",
      "Comprobando el entorno de ejecución instalado y su versión.",
    ],
  },
};
const stageKeys = [
  "checkDatabase",
  "packageLists",
  "downloadPackages",
  "unpackPackages",
  "saveDependencies",
  "verify",
];
const nativeLog =
  "EXPKEYSIG ORIGINAL\nProgrammpakete werden heruntergeladen.\nBenutzerausgabe unverändert: Grüße / español\n";

for (const [locale, text] of Object.entries(languages)) {
  test(`${locale}: runtime errors, six install stages, restart recovery, repair and cache`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(75000);
    await page.addInitScript(
      (value) => localStorage.setItem("sterracode.uiLocale", value),
      locale,
    );
    const response = await request.post("/api/sessions", {
      data: {
        title: `Runtime ${locale} ${randomUUID()}`,
        language: "python",
        tutorLocale: locale,
      },
    });
    expect(response.ok()).toBeTruthy();
    const session = await response.json();
    const originalFile = await (
      await request.get(
        `/api/workspaces/${session.id}/files/content?path=${session.activeFile}`,
      )
    ).json();
    let activeJob = null,
      latestJob = null,
      runnerStatus = "ready",
      cacheBytes = 64 * 1048576,
      cacheClears = 0;
    const actions = [];
    const program = {
      id: "python",
      name: "Python fixture",
      language: "python",
      description: "Python-Skripte",
      descriptionKey: "runner:catalog.python",
      descriptionParams: {},
      installed: false,
      state: "not-installed",
    };
    const job = (action) => ({
      id: randomUUID(),
      programId: program.id,
      action,
      state: "installing",
      stage: { current: 1, total: 6 },
      progress: "LEGACY FALLBACK MUST NOT DISPLAY",
      progressMessage: { key: "runner:programs.checkDatabase", params: {} },
      log: nativeLog,
    });
    const complete = () => {
      latestJob = {
        ...activeJob,
        state: "succeeded",
        stage: { current: 6, total: 6 },
        progressMessage: { key: "runner:programs.done", params: {} },
      };
      activeJob = null;
      runnerStatus = "ready";
      Object.assign(program, {
        installed: true,
        state: "installed",
        version: "Python 3.12.10",
      });
      delete program.error;
      delete program.errorKey;
      delete program.errorParams;
    };
    await page.route("**/api/models**", (route) =>
      route.fulfill({
        json: { connected: false, models: [], status: "offline" },
      }),
    );
    await page.route("**/api/runtimes", (route) =>
      route.fulfill({
        json: [
          {
            language: "python",
            installed: program.installed,
            enabled: true,
            available: program.installed,
            reason: "LEGACY FALLBACK MUST NOT DISPLAY",
            reasonKey: "serverFeature:process.runtimeMissing",
            reasonParams: { runtime: "Python" },
          },
        ],
      }),
    );
    await page.route("**/api/programs", (route) =>
      route.fulfill({
        json: {
          status: runnerStatus,
          programs: [program],
          activeJob,
          latestJob,
          cache: { packageBytes: cacheBytes, toolBytes: 2 * 1048576 },
        },
      }),
    );
    await page.route("**/api/programs/python/actions", async (route) => {
      const value = route.request().postDataJSON();
      actions.push(value.action);
      expect(["install", "repair"]).toContain(value.action);
      expect(value.stopRunning).toBe(false);
      activeJob = job(value.action);
      runnerStatus = "maintenance";
      program.state = "installing";
      await route.fulfill({ status: 202, json: { job: activeJob } });
    });
    await page.route("**/api/programs/cache", async (route) => {
      expect(route.request().method()).toBe("DELETE");
      expect(route.request().postDataJSON()).toEqual({});
      cacheClears++;
      cacheBytes = 0;
      await route.fulfill({
        json: { packageBytes: 0, toolBytes: 2 * 1048576 },
      });
    });
    const openPrograms = async () => {
      await expect(page.locator("#new-session-btn")).toBeEnabled();
      await page.evaluate(async () => {
        void (await import("/js/programs.js")).openPrograms();
      });
      const dialog = page.getByRole("dialog", {
        name: text.programs,
        exact: true,
      });
      await expect(
        dialog.getByText(program.name, { exact: true }),
      ).toBeVisible();
      return dialog;
    };
    await page.goto("/");
    await expect(page.locator("#new-session-btn")).toBeEnabled();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await page
      .getByRole("button", { name: session.title, exact: true })
      .first()
      .click();
    await expect(page.locator("#file-path")).toHaveText(session.activeFile);
    await expect(page.locator("#runtime-hint")).toHaveText(text.missing);
    await expect(page.locator("#run-btn")).toBeDisabled();
    let dialog = await openPrograms();
    await dialog
      .getByRole("button", { name: text.install, exact: true })
      .click();
    const progress = dialog.getByRole("progressbar", {
      name: text.progress,
      exact: true,
    });
    for (let current = 1; current <= 6; current++) {
      activeJob.stage.current = current;
      activeJob.progressMessage = {
        key: `runner:programs.${stageKeys[current - 1]}`,
        params: {},
      };
      await expect(progress).toHaveAttribute("value", String(current - 1));
      await expect(dialog.locator(".program-job-status")).toHaveText(
        text.step(current) + text.stages[current - 1],
      );
      await expect(
        dialog.getByRole("button", { name: text.cache, exact: true }),
      ).toBeDisabled();
    }
    await dialog.getByText(text.details, { exact: true }).click();
    await expect(dialog.locator(".program-job-log")).toHaveText(nativeLog);
    await testInfo.attach(`six-stages-${locale}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    complete();
    await expect(progress).toHaveAttribute("value", "6");
    await expect(dialog.locator(".program-job-heading")).toHaveText(
      `${program.name} · ${text.completed}`,
    );

    // Simulate a durable interrupted package journal surviving a Runner restart.
    // It represents a later package action; the earlier installation remains.
    latestJob = {
      ...latestJob,
      id: randomUUID(),
      action: "repair",
      state: "interrupted",
      stage: { current: 4, total: 6 },
      progressMessage: { key: "runner:programs.unpackPackages", params: {} },
      error: "LEGACY FALLBACK MUST NOT DISPLAY",
      errorKey: "runner:programs.interrupted",
      errorParams: {},
    };
    runnerStatus = "reconciling";
    Object.assign(program, {
      state: "error",
      error: latestJob.error,
      errorKey: latestJob.errorKey,
      errorParams: {},
    });
    await expect(dialog.locator(".program-job-heading")).toHaveText(
      `${program.name} · ${text.interrupted}`,
    );
    await dialog.getByRole("button", { name: text.close, exact: true }).click();
    await page.reload();
    dialog = await openPrograms();
    await expect(dialog.locator(".program-job-heading")).toHaveText(
      `${program.name} · ${text.interrupted}`,
    );
    await expect(dialog.locator(".program-jobs .form-error")).toHaveText(
      text.restart,
    );
    expect(actions).toEqual(["install"]);
    await testInfo.attach(`runner-restart-${locale}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await dialog
      .getByRole("button", { name: text.repair, exact: true })
      .click();
    await expect(dialog.locator(".program-job-status")).toHaveText(
      text.step(1) + text.stages[0],
    );
    await expect(
      dialog.getByRole("button", { name: text.cache, exact: true }),
    ).toBeDisabled();
    complete();
    await expect(dialog.locator(".program-job-heading")).toHaveText(
      `${program.name} · ${text.completed}`,
    );
    await dialog.getByRole("button", { name: text.cache, exact: true }).click();
    await expect(page.locator("#toasts")).toContainText(text.cached);
    expect(cacheClears).toBe(1);
    expect(actions).toEqual(["install", "repair"]);
    expect(program.installed).toBe(true);
    await dialog.getByRole("button", { name: text.close, exact: true }).click();

    // Native process output and the native detail inside our own message remain
    // original, including German text identical to a translated package stage.
    const processId = randomUUID();
    let terminalStarts = 0;
    await page.route("**/api/terminal", async (route) => {
      terminalStarts++;
      expect(route.request().postDataJSON()).toMatchObject({
        sessionId: session.id,
        file: session.activeFile,
        language: "python",
      });
      await route.fulfill({
        json: {
          processId,
          sessionId: session.id,
          command: "python main.py",
          actor: "user",
          exited: false,
        },
      });
    });
    await page.route(`**/api/terminal/${processId}/output?**`, (route) =>
      route.fulfill({
        json: {
          processId,
          sessionId: session.id,
          command: "python main.py",
          actor: "user",
          output: nativeLog,
          systemMessages: [
            {
              message: "LEGACY FALLBACK MUST NOT DISPLAY",
              messageKey: "runner:job.startFailed",
              params: { message: "EACCES native fixture detail" },
              outputOffset: 0,
            },
          ],
          offset: Buffer.byteLength(nativeLog),
          nextOffset: Buffer.byteLength(nativeLog),
          exited: true,
          exitCode: 1,
          reason: "runner_restarted",
        },
      }),
    );
    await page
      .getByRole("button", { name: session.title, exact: true })
      .first()
      .click();
    await expect(page.locator("#file-path")).toHaveText(session.activeFile);
    await expect(page.locator("#run-btn")).toBeEnabled();
    await page.locator("#run-btn").click();
    await expect(page.locator("#terminal-output")).toContainText(
      text.terminalFailure,
    );
    await expect(page.locator("#terminal-output")).toContainText(
      nativeLog.trim(),
    );
    await expect(page.locator("#terminal-output")).not.toContainText(
      "LEGACY FALLBACK MUST NOT DISPLAY",
    );
    await expect(page.locator("#process-status")).toHaveText(
      text.terminalEnded,
    );
    expect(terminalStarts).toBe(1);
    await testInfo.attach(`terminal-original-output-${locale}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    const finalFile = await (
      await request.get(
        `/api/workspaces/${session.id}/files/content?path=${session.activeFile}`,
      )
    ).json();
    expect(finalFile.content).toBe(originalFile.content);
    expect(finalFile.version).toBe(originalFile.version);
  });
}
