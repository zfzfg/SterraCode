import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

let server, directory, baseURL, setupKey, auth, setOpenAITransportForTests;
const password = "Browser-Testpasswort-2026";
let openAIGenerations = 0;
test.beforeAll(async () => {
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "sterracode-auth-browser-"),
  );
  process.env.STERRACODE_DATA_DIR = directory;
  const { ensureDataDirs } = await import("../../server/services/storage.js");
  const { createAuthService } = await import("../../server/services/auth.js");
  const { loadConfig } = await import("../../server/config.js");
  const { createApp } = await import("../../server/app.js");
  await ensureDataDirs();
  auth = createAuthService({ dataDir: directory });
  ({ setOpenAITransportForTests } =
    await import("../../server/services/openAI.js"));
  setOpenAITransportForTests(async (url, options) => {
    if (!url.startsWith("https://api.openai.com/v1/"))
      throw new Error("Unexpected OpenAI origin");
    const body = options.body ? JSON.parse(options.body) : {};
    if (url.endsWith("/models"))
      return new Response(
        JSON.stringify({
          data: [
            { id: "fixture-reasoning-model" },
            { id: "fixture-other-model" },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    if (url.endsWith("/input_tokens"))
      return new Response(
        JSON.stringify({
          input_tokens: Math.ceil(JSON.stringify(body).length / 4),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    openAIGenerations++;
    const output = {
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "OpenAI-Fixture antwortet ohne kostenpflichtigen API-Aufruf.",
            },
          ],
        },
      ],
    };
    if (!body.stream)
      return new Response(JSON.stringify(output), {
        headers: { "Content-Type": "application/json" },
      });
    return new Response(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: output.output[0].content[0].text })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: output })}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  setupKey = await auth.createSetupKey();
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
  setOpenAITransportForTests?.();
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
});

test("geschützte Ersteinrichtung, HTTP-Cookie, Programmassistent und erneute Anmeldung", async ({
  page,
  context,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseURL);
  await expect(
    page.getByRole("heading", { name: "SterraCode einrichten" }),
  ).toBeVisible();
  await page.getByLabel("Einrichtungsschlüssel").fill("ungueltiger-schluessel");
  await page
    .getByLabel("Administratorpasswort", { exact: true })
    .fill(password);
  await page.getByLabel("Passwort wiederholen", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Einrichtung abschließen", exact: true })
    .click();
  await expect(
    page.getByText("Einrichtungsschlüssel ist ungültig oder abgelaufen.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Einrichtungsschlüssel").fill(setupKey);
  await page
    .getByRole("button", { name: "Einrichtung abschließen", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Programme auswählen" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Weiter zur KI-Verbindung" }).click();
  await expect(
    page.getByRole("heading", { name: "KI verbinden" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Neue Session", exact: true }),
  ).toBeEnabled();
  const cookie = (await context.cookies()).find(
    (item) => item.name === "sterracode.session",
  );
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.secure).toBe(false);
  expect(cookie.sameSite).toBe("Lax");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Neue Session", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "Programme auswählen" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Einstellungen", exact: true })
    .click();
  await page.getByRole("button", { name: "Abmelden", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Bei SterraCode anmelden" }),
  ).toBeVisible();
  await page
    .getByLabel("Administratorpasswort", { exact: true })
    .fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Neue Session", exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});

test("OpenAI-Zugangsdaten bleiben verborgen und die Modellwahl ist ausdrücklich", async ({
  page,
}) => {
  await auth.initializePassword(password);
  await page.goto(baseURL);
  await page
    .getByLabel("Administratorpasswort", { exact: true })
    .fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Neue Session", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Einstellungen", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "KI-Anbieter", exact: true })
    .selectOption("openai");
  await page.getByLabel("OpenAI-Modell-ID", { exact: true }).fill("");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Einstellungen", exact: true })
    .click();
  await page
    .getByRole("button", { name: "KI-Zugangsdaten", exact: true })
    .click();
  const secret = "sk-browser-fixture-private-key";
  await page
    .getByLabel("Neuer OpenAI-API-Schlüssel", { exact: true })
    .fill(secret);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/provider/credentials") &&
      response.request().method() === "PATCH",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  expect(await (await saved).json()).toEqual({
    openai: { configured: true, source: "saved" },
  });
  await expect(page.locator("#model-select")).toBeEnabled();
  await expect(page.locator("#model-select")).toHaveValue("");
  expect(openAIGenerations).toBe(0);
  const settingsResponse = await page.request.get(
    `${baseURL}/api/chat/settings`,
  );
  expect((await settingsResponse.json()).openAIModel).toBe("");
  const metadata = await page.request.get(
    `${baseURL}/api/provider/credentials`,
  );
  expect(await metadata.text()).not.toContain(secret);
  expect(
    await page
      .locator('input[type="password"]')
      .evaluateAll((inputs) => inputs.some((input) => input.value.length > 0)),
  ).toBe(false);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage })),
  ).not.toContain(secret);
  await page
    .getByRole("button", { name: "Einstellungen", exact: true })
    .click();
  await page
    .getByRole("button", { name: "KI-Zugangsdaten", exact: true })
    .click();
  await expect(
    page.getByLabel("Neuer OpenAI-API-Schlüssel", { exact: true }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await page.getByRole("button", { name: "Neue Session", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("OpenAI Browserprüfung");
  await page
    .getByRole("button", { name: "Session erstellen", exact: true })
    .click();
  await page.locator("#model-select").selectOption("fixture-reasoning-model");
  await expect(page.locator("#connection-text")).toHaveText("OpenAI verbunden");
  await page.locator("#chat-input").fill("Hallo OpenAI-Fixture");
  await page.locator("#chat-input").press("Enter");
  await expect(page.locator("#chat-messages")).toContainText(
    "OpenAI-Fixture antwortet ohne kostenpflichtigen API-Aufruf.",
  );
  await expect(page.locator("#token-counter")).toContainText("Kontext:");
  expect(openAIGenerations).toBe(1);
  await page
    .getByRole("button", { name: "Einstellungen", exact: true })
    .click();
  await page
    .getByLabel("OpenAI-Modell-ID", { exact: true })
    .fill("fixture-manual-alias");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  await expect(page.locator("#model-select")).toHaveValue(
    "fixture-manual-alias",
  );
  await expect(page.locator("#connection-text")).toHaveText("OpenAI verbunden");
  await expect(page.locator("#token-counter")).toHaveText("Kontext bereit");
});
