import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { LMStudioClient } from "@lmstudio/sdk";

// Read only connection selection from personal settings, then import the app
// against an isolated data directory. No personal session or workspace is used.
const configurationPath = path.resolve(
  process.env.STERRACODE_DATA_DIR ||
    path.join(import.meta.dirname, "../server/data"),
  "settings.json",
);
const saved = JSON.parse(await fs.readFile(configurationPath, "utf8"));
const endpoint = new URL(saved.lmStudioUrl);
endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
const client = new LMStudioClient({
  baseUrl: endpoint.href.replace(/\/$/, ""),
});
const controller = new AbortController();
const timeout = setTimeout(
  () => controller.abort(new Error("Live-Prüfung nach zehn Minuten beendet.")),
  600000,
);
process.once("SIGINT", () =>
  controller.abort(new Error("Live-Prüfung abgebrochen.")),
);
let temporary,
  ownedModel,
  exitCode = 0;
try {
  let selected = (await client.llm.listLoaded()).find(
    (m) => m.identifier === saved.activeModel,
  );
  if (!selected && process.argv.includes("--load")) {
    const candidates = (await client.system.listDownloadedModels()).filter(
      (m) => m.type === "llm" && m.modelKey === saved.activeModel,
    );
    assert.equal(
      candidates.length,
      1,
      "Das konfigurierte Modell ist nicht eindeutig im lokalen Modellbestand vorhanden.",
    );
    console.log(
      `Lade temporäre Instanz von ${saved.activeModel} mit 8192 Tokens …`,
    );
    ownedModel = await client.llm.load(candidates[0].modelKey, {
      identifier: `sterracode-validation-${randomUUID()}`,
      config: { contextLength: 8192 },
      ttl: 300,
      signal: controller.signal,
      verbose: false,
    });
    selected = ownedModel;
  }
  assert.ok(
    selected,
    "Kein ausgewähltes Modell geladen. Modell in LM Studio laden oder explizit --load verwenden.",
  );
  console.log(
    `Prüfe ${selected.identifier} mit ${await selected.getContextLength()} Tokens.`,
  );
  temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "sterracode-live-context-"),
  );
  process.env.STERRACODE_DATA_DIR = temporary;
  const storage = await import("../server/services/storage.js");
  const sessions = await import("../server/services/sessions.js");
  const workspace = await import("../server/services/workspace.js");
  const { runTeacher } = await import("../server/services/teacher.js");
  await storage.ensureDataDirs();
  await storage.updateSettings({
    lmStudioUrl: saved.lmStudioUrl,
    activeModel: selected.identifier,
    temperature: 0.1,
    maxTokensResponse: 2048,
    keepRecentTokens: 512,
    chunkTokens: 2000,
    summarizerMaxTokens: 400,
    summaryBudgetTokens: 1200,
    allowAITerminalCommands: false,
  });
  const session = await sessions.createSession({
    title: "Isolierte Live-Kontextprüfung",
  });
  const filler =
    "Wir besprechen Schleifen, Bedingungen und verständliche Fehlermeldungen anhand kleiner Beispiele. ".repeat(
      32,
    );
  const toolsOnly = process.argv.includes("--tools-only");
  const rounds = toolsOnly
    ? 0
    : Math.ceil(
        ((await selected.getContextLength()) * 1.5) /
          (await selected.countTokens(filler)),
      );
  await sessions.mutateSession(session.id, (s) => {
    s.messages.push(
      sessions.message(
        "user",
        "Merke diese verbindlichen Projektdaten: Projektcode STERN-1847, Dateiname pruefung.py, nächster Schritt ABSCHLUSSTEST. Führe jetzt keine Aktionen aus.",
      ),
      sessions.message("assistant", "Projektdaten aufgenommen."),
    );
    for (let i = 0; i < rounds; i++) {
      s.messages.push(
        sessions.message("user", `Lernabschnitt ${i}: ${filler}`),
      );
      s.messages.push(
        sessions.message(
          "assistant",
          `Abschnitt ${i} wurde besprochen. Als Randnotiz bleiben kleine Schritte und konkrete Ergebnisse hilfreich.`,
        ),
      );
    }
  });
  const original = (await sessions.loadSession(session.id)).messages;
  const events = [];
  let lastProgress;
  const onEvent = (event, value) => {
    if (event === "context-report") events.push(value);
    const progress = `${value.phase}:${value.chunk}:${value.percent}`;
    if (event === "context-progress" && progress !== lastProgress) {
      lastProgress = progress;
      console.log(
        `${value.message}${value.percent !== undefined ? ` (${value.percent} %)` : ""}`,
      );
    }
  };
  let compact;
  if (!toolsOnly) {
    compact = await runTeacher({
      sessionId: session.id,
      contextAction: "compact",
      signal: controller.signal,
      onEvent,
    });
    assert.equal(compact.turn.status, "done", compact.turn.error);
    console.log(
      `Gemessen: ${compact.contextUsage.transcriptTokens} Verlauf-Tokens, ${compact.contextUsage.promptTokens} Prompt-Tokens nach Komprimierung.`,
    );
    assert.ok(
      compact.contextUsage.coveredMessages > 0,
      "Es wurde kein Abschnitt komprimiert.",
    );
    assert.ok(
      events.some((e) => e.afterTokens < e.beforeTokens),
      "Die Komprimierung hat keinen Platz gespart.",
    );
    assert.deepEqual(
      compact.session.messages.filter(
        (m) => !["context_compaction", "context_usage"].includes(m.event?.type),
      ),
      original,
    );
    assert.ok(
      compact.contextUsage.transcriptTokens >
        compact.contextUsage.contextLength,
      "Die Testkonversation ist nicht länger als das geladene Kontextfenster.",
    );
  }
  const recall = await runTeacher({
    sessionId: session.id,
    userMessage:
      "Nenne nur die drei ursprünglich festgelegten Projektdaten: Projektcode, Dateiname und nächster Schritt. Benutze keine Werkzeuge.",
    signal: controller.signal,
  });
  assert.equal(recall.turn.status, "done", recall.turn.error);
  const answer = recall.session.messages
    .filter((m) => m.turnId === recall.turn.id && m.role === "assistant")
    .map((m) => m.content)
    .join("\n");
  for (const fact of ["STERN-1847", "pruefung.py", "ABSCHLUSSTEST"])
    assert.ok(
      answer.includes(fact),
      `Erinnerung fehlt: ${fact}. Antwort: ${answer}`,
    );
  const write = await runTeacher({
    sessionId: session.id,
    userMessage:
      "Erstelle jetzt ausschließlich pruefung.txt im Workspace mit genau dem Inhalt KONTEXT_OK. Verwende write_file mit expectedVersion null. Benutze kein Terminal und bestätige danach kurz.",
    signal: controller.signal,
    onEvent: (event, value) => {
      if (event === "message" && value.role === "assistant" && value.tool_calls)
        console.log(
          JSON.stringify({
            requests: value.tool_calls.map((c) => ({
              name: c.function.name,
              arguments: c.function.arguments.slice(0, 600),
            })),
          }),
        );
      if (event === "message" && value.role === "tool") {
        const result = JSON.parse(value.content);
        console.log(
          JSON.stringify({
            tool: result.type,
            path: result.path,
            status: result.status,
            error: result.error,
            code: result.code,
          }),
        );
      }
    },
  });
  assert.equal(write.turn.status, "done", write.turn.error);
  assert.equal(
    (await workspace.readFile(session.id, "pruefung.txt")).content?.trim(),
    "KONTEXT_OK",
  );
  const tool = write.session.messages.find(
    (m) =>
      m.turnId === write.turn.id &&
      m.role === "tool" &&
      JSON.parse(m.content).type === "write_file",
  );
  assert.ok(tool, "Der echte Datei-Tool-Aufruf fehlt.");
  const undone = await workspace.undoChange(
    session.id,
    JSON.parse(tool.content).changeId,
  );
  assert.equal(undone.exists, false);
  await assert.rejects(
    workspace.readFile(session.id, "pruefung.txt"),
    (error) => error.status === 404,
  );
  console.log(
    JSON.stringify({
      status: "passed",
      model: saved.activeModel,
      contextLength: await selected.getContextLength(),
      transcriptTokens: compact?.contextUsage.transcriptTokens,
      promptTokens: compact?.contextUsage.promptTokens,
      coveredMessages: compact?.contextUsage.coveredMessages,
      promptBeforeTokens: events.find((event) => event.changed)?.beforeTokens,
      compaction: toolsOnly ? "skipped" : "passed",
      recall: "3/3",
      fileTool: "passed",
      undo: "passed",
    }),
  );
} catch (error) {
  exitCode = 1;
  console.error(error.stack || error.message);
} finally {
  clearTimeout(timeout);
  if (ownedModel)
    await ownedModel
      .unload()
      .catch((e) =>
        console.error(`Testmodell konnte nicht entladen werden: ${e.message}`),
      );
  if (ownedModel)
    try {
      // An open SterraCode window can automatically select the only loaded test
      // instance. Restore just that temporary selection, preserving other edits.
      const current = JSON.parse(await fs.readFile(configurationPath, "utf8"));
      if (current.activeModel === ownedModel.identifier) {
        const file = `${configurationPath}.${randomUUID()}.tmp`;
        await fs.writeFile(
          file,
          JSON.stringify(
            { ...current, activeModel: saved.activeModel },
            null,
            2,
          ),
          "utf8",
        );
        await fs.rename(file, configurationPath);
      }
    } catch (error) {
      exitCode = 1;
      console.error(
        `Temporäre Modellauswahl konnte nicht zurückgesetzt werden: ${error.message}`,
      );
    }
  if (
    temporary &&
    path.dirname(path.resolve(temporary)) === path.resolve(os.tmpdir()) &&
    path.basename(temporary).startsWith("sterracode-live-context-")
  )
    await fs.rm(temporary, { recursive: true, force: true });
}
process.exit(exitCode);
