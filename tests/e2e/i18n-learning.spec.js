import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

const translations = [
  {
    locale: "de",
    check: "Lösung prüfen",
    failed: "Tests fehlgeschlagen",
    passed: "Erforderliche Tests bestanden",
    complete: "Aufgabe abschließen",
    journal: "Freiwilliges Lernjournal",
    saveJournal: "Journaleintrag speichern",
    savedJournal: "Journaleintrag gespeichert.",
    export: "Projekt exportieren",
    exportSelected: "Ausgewählte Dateien exportieren",
    close: "Schließen",
    tracer: "Python Schritt für Schritt",
    record: "Python-Datei aufzeichnen",
    programError: "Unbehandelter Programmfehler",
    toError: "Zum Fehler",
  },
  {
    locale: "en",
    check: "Check solution",
    failed: "Tests failed",
    passed: "Required tests passed",
    complete: "Complete task",
    journal: "Optional learning journal",
    saveJournal: "Save journal entry",
    savedJournal: "Journal entry saved.",
    export: "Export project",
    exportSelected: "Export selected files",
    close: "Close",
    tracer: "Python step by step",
    record: "Record Python file",
    programError: "Unhandled program error",
    toError: "Go to error",
  },
  {
    locale: "es",
    check: "Comprobar solución",
    failed: "Pruebas fallidas",
    passed: "Pruebas obligatorias superadas",
    complete: "Completar tarea",
    journal: "Diario de aprendizaje opcional",
    saveJournal: "Guardar entrada del diario",
    savedJournal: "Entrada del diario guardada.",
    export: "Exportar proyecto",
    exportSelected: "Exportar los archivos seleccionados",
    close: "Cerrar",
    tracer: "Python paso a paso",
    record: "Grabar archivo Python",
    programError: "Error del programa no controlado",
    toError: "Ir al error",
  },
];

for (const text of translations) {
  test(`offline tests, journal, project export and original Python trace in ${text.locale}`, async ({
    page,
    request,
  }) => {
    await page.addInitScript(
      (locale) => localStorage.setItem("sterracode.uiLocale", locale),
      text.locale,
    );
    await page.route("**/api/models**", (route) =>
      route.fulfill({ json: { connected: false, models: [] } }),
    );
    const session = await (
      await request.post("/api/projects/import", {
        data: {
          templateId: "text-analysis",
          operationId: randomUUID(),
          contentLocale: text.locale,
          tutorLocale: text.locale,
        },
      })
    ).json();
    const fileURL = `/api/workspaces/${session.id}/files/content`;
    async function write(content) {
      const previous = await (
        await request.get(`${fileURL}?path=main.py`)
      ).json();
      expect(
        (
          await request.put(fileURL, {
            data: {
              path: "main.py",
              expectedVersion: previous.version,
              content,
            },
          })
        ).ok(),
      ).toBeTruthy();
    }
    async function open() {
      await page.goto("/");
      await expect(page.locator("#new-session-btn")).toBeEnabled();
      await page
        .getByRole("button", { name: session.title, exact: true })
        .first()
        .click();
      await expect(page.locator("#file-path")).toHaveText("main.py");
    }
    await open();
    await expect(page.locator("html")).toHaveAttribute("lang", text.locale);
    const task = page.locator("#task-panel");
    await task.getByRole("button", { name: text.check, exact: true }).click();
    await expect(task.getByRole("status")).toContainText(text.failed);
    await expect(
      task.getByRole("button", { name: text.complete, exact: true }),
    ).toBeDisabled();
    await write("def zaehle_woerter(text):\n    return len(text.split())\n");
    await open();
    await task.getByRole("button", { name: text.check, exact: true }).click();
    await expect(task.getByRole("status")).toContainText(text.passed);
    await task.getByText(text.journal, { exact: true }).click();
    const originalJournal = "Meine Reflexion bleibt: Grüße / mañana.";
    await task.locator("#task-journal-text").fill(originalJournal);
    await task
      .getByRole("button", { name: text.saveJournal, exact: true })
      .click();
    await expect(page.locator("#toasts")).toContainText(text.savedJournal);
    const completed = page.waitForResponse(
      (response) =>
        response.url().endsWith("/complete") &&
        response.request().method() === "POST",
    );
    await task
      .getByRole("button", { name: text.complete, exact: true })
      .click();
    expect((await completed).ok()).toBeTruthy();
    const stored = await (
      await request.get(`/api/sessions/${session.id}`)
    ).json();
    expect(stored.currentTask.completion.evidence.kind).toBe("test_run");
    expect(stored.currentTask.contentLocale).toBe(text.locale);
    await page.getByRole("button", { name: text.export, exact: true }).click();
    const exporter = page.getByRole("dialog", {
      name: text.export,
      exact: true,
    });
    await exporter
      .getByRole("checkbox", { name: "main.py", exact: true })
      .check();
    const downloaded = page.waitForEvent("download");
    await exporter
      .getByRole("button", { name: text.exportSelected, exact: true })
      .click();
    const pkg = JSON.parse(await fs.readFile(await (await downloaded).path()));
    expect(pkg.files[0].content).toContain("return len(text.split())");
    expect(JSON.stringify(pkg)).not.toContain(originalJournal);
    await exporter
      .getByRole("button", { name: text.close, exact: true })
      .click();
    await write(
      'print("Gespeichert – Originalausgabe")\nraise ValueError("Nicht übersetzen: mañana")\n',
    );
    await open();
    await page.locator("#trace-open").click();
    const trace = page.getByRole("dialog", { name: text.tracer, exact: true });
    await trace.getByRole("button", { name: text.record, exact: true }).click();
    await expect(trace.getByRole("status")).toContainText(text.programError);
    await trace
      .getByRole("button", { name: text.toError, exact: true })
      .click();
    await expect(trace).toContainText("Nicht übersetzen: mañana");
    await expect(trace.locator(".trace-output")).toContainText(
      "Gespeichert – Originalausgabe",
    );
    await expect(trace.locator(".trace-source .view-lines")).toContainText(
      "raise ValueError",
    );
    await trace.getByRole("button", { name: text.close, exact: true }).click();
    await expect(page.locator("#trace-open")).toBeFocused();
  });
}
