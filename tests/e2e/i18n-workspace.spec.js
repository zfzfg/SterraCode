import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

for (const text of [
  {
    locale: "de",
    recovered:
      "Ein ungespeicherter lokaler Stand wurde im Editor wiederhergestellt.",
    saved: "Gespeichert",
    saveError: "Speichern fehlgeschlagen – prüfen",
    action: "Aktion",
    backup: "Name der Sicherungsdatei",
    execute: "Ausführen",
    explain: "Code erklären",
    find: "Suchen",
    replace: "Ersetzen",
    continue: "Antwort fortsetzen",
    offline: "LM Studio offline",
  },
  {
    locale: "en",
    recovered: "An unsaved local draft was restored in the editor.",
    saved: "Saved",
    saveError: "Saving failed – review",
    action: "Action",
    backup: "Backup file name",
    execute: "Execute",
    explain: "Explain code",
    find: "Find",
    replace: "Replace",
    continue: "Continue response",
    offline: "LM Studio offline",
  },
  {
    locale: "es",
    recovered: "Se ha restaurado un borrador local sin guardar en el editor.",
    saved: "Guardado",
    saveError: "No se pudo guardar; revísalo",
    action: "Acción",
    backup: "Nombre del archivo de respaldo",
    execute: "Ejecutar",
    explain: "Explicar código",
    find: "Buscar",
    replace: "Reemplazar",
    continue: "Continuar la respuesta",
    offline: "LM Studio sin conexión",
  },
]) {
  test(`local recovery, conflicts, Monaco and stream cancellation in ${text.locale}`, async ({
    page,
    request,
  }) => {
    await request.patch("/api/chat/settings", {
      data: {
        provider: "lmstudio",
        activeModel: "Lokaler Test-Tutor",
        streaming: true,
      },
    });
    const session = await (
      await request.post("/api/sessions", {
        data: {
          title: `Workspace ${text.locale} ${randomUUID()}`,
          language: "javascript",
          tutorLocale: text.locale,
        },
      })
    ).json();
    const fileURL = `/api/workspaces/${session.id}/files/content`;
    const original = await (
      await request.get(`${fileURL}?path=main.js`)
    ).json();
    const draft = "// Lokaler Originalentwurf: Grüße / mañana\n";
    await page.addInitScript(
      ({ locale, id, version, draft }) => {
        localStorage.setItem("sterracode.uiLocale", locale);
        localStorage.setItem(
          `sterracode:draft:${id}:main.js`,
          JSON.stringify({ content: draft, baseVersion: version }),
        );
      },
      { locale: text.locale, id: session.id, version: original.version, draft },
    );
    await page.goto("/");
    await expect(page.locator("#new-session-btn")).toBeEnabled();
    await page
      .getByRole("button", { name: session.title, exact: true })
      .first()
      .click();
    await expect(page.locator("#toasts")).toContainText(text.recovered);
    const editorInput = page.locator(".monaco-editor textarea").first();
    await editorInput.focus();
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.locator("#save-status")).toHaveText(text.saved);
    const saved = await (await request.get(`${fileURL}?path=main.js`)).json();
    expect(saved.content).toBe(draft);
    await request.put(fileURL, {
      data: {
        path: "main.js",
        content: "// EXTERNAL ORIGINAL\n",
        expectedVersion: saved.version,
      },
    });
    await page.evaluate(() => {
      const model = monaco.editor
        .getModels()
        .find((item) => item.uri.path.endsWith("/main.js"));
      model.setValue("// UNSAVED LOCAL ORIGINAL\n");
    });
    await expect(page.locator("#save-status")).toHaveText(text.saveError);
    await page.locator("#save-status").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(text.action, { exact: true })).toHaveValue(
      "copy",
    );
    await dialog
      .getByLabel(text.backup, { exact: true })
      .fill("recovered-local.js");
    await dialog
      .getByRole("button", { name: text.execute, exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".view-lines")).toContainText(
      "EXTERNAL ORIGINAL",
    );
    const backup = await (
      await request.get(`${fileURL}?path=recovered-local.js`)
    ).json();
    expect(backup.content).toBe("// UNSAVED LOCAL ORIGINAL\n");
    await page.locator("#toasts .toast.error button").click();
    await editorInput.focus();
    await page.keyboard.press("ControlOrMeta+h");
    await expect(
      page
        .locator(".find-widget")
        .getByRole("textbox", { name: text.find, exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator(".find-widget")
        .getByRole("textbox", { name: text.replace, exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator(".view-lines").first().click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: text.explain, exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#send-btn")).toBeEnabled();
    await page.locator("#chat-input").fill("Bitte warte");
    await page.locator("#send-btn").click();
    await expect(
      page.getByText("Ich prüfe das …", { exact: true }),
    ).toBeVisible();
    await page.locator("#stop-chat-btn").click();
    await expect(
      page.getByRole("button", { name: text.continue, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: text.continue, exact: true })
      .click();
    await expect(page.locator("#stop-chat-btn")).toBeVisible();
    await page.locator("#stop-chat-btn").click();
    await expect(
      page.getByRole("button", { name: text.continue, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".message.user")).toHaveCount(1);
    await page.route("**/api/models**", (route) =>
      route.fulfill({ json: { connected: false, models: [] } }),
    );
    await page.locator("#refresh-models").click();
    await expect(page.locator("#connection-text")).toHaveText(text.offline);
    await expect(page.locator("#send-btn")).toBeDisabled();
    await expect(page.locator(".monaco-editor").first()).toBeVisible();
  });
}
