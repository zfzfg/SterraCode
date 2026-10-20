import { test, expect } from "@playwright/test";

test("OpenAI-Verbrauch anzeigen und begrenzte Ergebnisse offline nachladen", async ({
  page,
  request,
}) => {
  const settings = await (await request.get("/api/chat/settings")).json();
  try {
    expect(
      (
        await request.patch("/api/provider/credentials", {
          data: { provider: "openai", apiKey: "sk-offline-efficiency-fixture" },
        })
      ).ok(),
    ).toBeTruthy();
    await request.patch("/api/chat/settings", {
      data: {
        provider: "openai",
        openAIModel: "e2e-efficiency",
        maxToolResultTokens: 400,
        maxTotalToolResultTokens: 2000,
      },
    });
    const session = await (
      await request.post("/api/sessions", {
        data: { title: "Token-Effizienz", language: "python" },
      })
    ).json();
    const base = `/api/workspaces/${session.id}/files/content`;
    const file = await (await request.get(`${base}?path=main.py`)).json();
    await request.put(base, {
      data: {
        path: "main.py",
        expectedVersion: file.version,
        content: 'print("NACHLADE_MARKER")\n'.repeat(1000),
      },
    });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Token-Effizienz", exact: true })
      .first()
      .click();
    await page.locator("#chat-input").fill("Lies die große Datei");
    await page.locator("#send-btn").click();
    await expect(page.locator("#token-counter")).toContainText(
      "Turnverbrauch: 3.000 Eingabe / 300 Ausgabe",
    );
    await expect(page.locator("#token-counter")).toContainText(
      "Cache gelesen: 50 %",
    );
    await expect(
      page.locator("#chat-messages .message.assistant").last(),
    ).toContainText("NACHLADE_MARKER");
    const saved = await (
      await request.get(`/api/sessions/${session.id}`)
    ).json();
    expect(
      saved.messages.some((m) =>
        m.tool_calls?.some((c) => c.function.name === "read_tool_result"),
      ),
    ).toBe(true);
    expect(
      saved.messages.find(
        (m) => m.role === "tool" && JSON.parse(m.content).type === "read_file",
      ).content.length,
    ).toBeGreaterThan(20000);
    await page.reload();
    await page
      .getByRole("button", { name: "Token-Effizienz", exact: true })
      .first()
      .click();
    await expect(page.locator("#token-counter")).toContainText(
      "Cache gelesen: 50 %",
    );
    await page.screenshot({
      path: "test-results/token-efficiency-desktop.png",
    });
    await page.setViewportSize({ width: 640, height: 800 });
    await page.getByRole("button", { name: "KI-Tutor", exact: true }).click();
    await page.screenshot({ path: "test-results/token-efficiency-mobile.png" });
  } finally {
    // Settings API intentionally has a whitelist; restore only changed fields.
    await request.patch("/api/chat/settings", {
      data: {
        provider: settings.provider,
        openAIModel: settings.openAIModel,
        maxToolResultTokens: settings.maxToolResultTokens,
        maxTotalToolResultTokens: settings.maxTotalToolResultTokens,
      },
    });
    await request.patch("/api/provider/credentials", {
      data: { provider: "openai", apiKey: null },
    });
  }
});
