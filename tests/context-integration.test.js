import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixtureModel, openAIMessages } from "./helpers/lmStudio.js";
import { Chat, ChatMessage } from "@lmstudio/sdk";

let root,
  storage,
  sessions,
  teacher,
  transport,
  workspace,
  ContextManager,
  model,
  settings,
  managerModule;
const call = (name, args = {}, id = randomUUID()) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const summaryOrAnswer = (body) => ({
  content: body.stream
    ? "Aufgabe fortgesetzt."
    : "Ziel, Entscheidungen, Dateien und nächste Schritte sind erhalten.",
});
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterracode-context-"));
  process.env.STERRACODE_DATA_DIR = root;
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  teacher = await import("../server/services/teacher.js");
  transport = await import("../server/services/lmStudio.js");
  workspace = await import("../server/services/workspace.js");
  managerModule = await import("../server/services/context/index.js");
  ({ ContextManager } = managerModule);
  await storage.ensureDataDirs();
});
beforeEach(async () => {
  settings = await storage.updateSettings({
    ...storage.defaultSettings(),
    activeModel: "test-model",
  });
  model = fixtureModel({ predict: summaryOrAnswer });
  transport.setLMStudioClientFactory(() => ({
    llm: { listLoaded: async () => [model] },
  }));
});
afterAll(async () => {
  transport.setLMStudioClientFactory();
  if (
    path.dirname(root) === os.tmpdir() &&
    path.basename(root).startsWith("sterracode-context-")
  )
    await fs.rm(root, { recursive: true, force: true });
});
async function manager(session, options = {}) {
  const signal = options.signal || new AbortController().signal;
  const current = await storage.getSettings();
  const connection = await transport.connectModel(current, signal);
  const result = new ContextManager({
    connection,
    settings: current,
    sessionId: session.id,
    signal,
    ...options,
  });
  await result.initialize();
  return result;
}
async function history(count = 8, size = 1800) {
  const s = await sessions.createSession();
  return sessions.mutateSession(s.id, (v) => {
    for (let i = 0; i < count; i++)
      v.messages.push(
        sessions.message(
          i % 2 ? "assistant" : "user",
          `Fakt-${i}: ${"Beschreibung ".repeat(Math.ceil(size / 13))}`,
        ),
      );
  });
}

describe("Native Kontextprüfung und Aktionen", () => {
  it("erhält Zustandsdaten mit Systemrollen-Fallback und strenger Rollenfolge", async () => {
    const apply = model.applyPromptTemplate.bind(model);
    model.applyPromptTemplate = async (chat, opts) => {
      const messages = openAIMessages(chat);
      if (messages.some((m) => m.role === "system"))
        throw new Error("system role not supported");
      if (
        messages.some(
          (m, i) => i && m.role === "user" && messages[i - 1].role === "user",
        )
      )
        throw new Error("conversation roles must alternate");
      return apply(chat, opts);
    };
    const s = await sessions.createSession();
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "MEIN_AUFTRAG",
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    expect(model.calls[0].messages.every((m) => m.role !== "system")).toBe(
      true,
    );
    expect(JSON.stringify(model.calls[0].messages)).toContain("MEIN_AUFTRAG");
    expect(JSON.stringify(model.calls[0].messages)).toContain(
      "ZUSTANDS-SNAPSHOT",
    );
    expect(result.session.messages.find((m) => m.role === "user").content).toBe(
      "MEIN_AUFTRAG",
    );
  });
  it("behält den letzten exakten Zustand auch wenn dessen Snapshot komprimiert wurde", async () => {
    const { appendStateSnapshot } =
      await import("../server/services/context/prompt.js");
    await storage.updateSettings({
      keepRecentTokens: 300,
      chunkTokens: 1000,
      summarizerMaxTokens: 200,
    });
    const s = await sessions.createSession();
    const current = await sessions.mutateSession(s.id, (v) => {
      v.messages.push(sessions.message("user", "Mein ursprünglicher Auftrag"));
      v.currentTask = { id: "EXAKTE_AUFGABE", title: "Erhalten" };
      appendStateSnapshot(v, { turnId: randomUUID() });
      for (let i = 0; i < 20; i++)
        v.messages.push(
          sessions.message(
            i % 2 ? "assistant" : "user",
            "Unwichtige Beispiele. ".repeat(150),
          ),
        );
      v.messages.push(sessions.message("user", "Weiter"));
    });
    const ctx = await manager(current);
    const result = await ctx.prepare(current, [], { force: true });
    expect(result.contextUsage.coveredMessages).toBeGreaterThan(2);
    expect(JSON.stringify(openAIMessages(result.chat))).toContain(
      "EXAKTE_AUFGABE",
    );
    const restarted = await manager(current);
    const again = await restarted.prepare(current, [], { diagnostics: true });
    expect(openAIMessages(again.chat)).toEqual(openAIMessages(result.chat));
  });
  it("speichert tatsächliche SDK-Nutzung ohne Cache-Werte zu erfinden", async () => {
    model = fixtureModel({
      predict: () => ({
        content: "Antwort",
        stats: { promptTokensCount: 1000, predictedTokensCount: 25 },
      }),
    });
    const s = await sessions.createSession();
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Hallo",
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    expect(result.turn.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 25,
      totalTokens: 1025,
      cacheReadRatio: null,
    });
    expect(result.contextUsage.consumption).toEqual(result.turn.usage);
  });
  it("erfasst SDK-Verbrauch auch für interne Zusammenfassungen", async () => {
    await storage.updateSettings({
      keepRecentTokens: 100,
      chunkTokens: 1000,
      summarizerMaxTokens: 200,
    });
    model = fixtureModel({
      predict: () => ({
        content: "Zusammenfassung des Lernstands.",
        stats: { promptTokensCount: 500, predictedTokensCount: 50 },
      }),
    });
    const s = await history(20, 1500);
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "/compact",
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    const receipts = result.session.messages.filter(
      (m) => m.turnId === result.turn.id && m.event?.type === "model_usage",
    );
    expect(receipts.length).toBeGreaterThan(0);
    expect(result.turn.usage).toMatchObject({
      calls: receipts.length,
      inputTokens: receipts.length * 500,
      outputTokens: receipts.length * 50,
    });
    expect(JSON.stringify(receipts)).not.toContain("Fakt-");
  });
  it("misst inklusive Tools und verwendet genau das reservierte Antwortlimit", async () => {
    model.contextLength = 4096;
    await storage.updateSettings({ maxTokensResponse: 32768 });
    const s = await sessions.createSession();
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Hallo",
      stream: true,
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    expect(model.calls).toHaveLength(1);
    for (const request of model.calls) {
      const count = await model.countTokens(
        JSON.stringify({ messages: request.messages, tools: request.tools }),
      );
      expect(count + request.max_tokens).toBeLessThanOrEqual(
        model.contextLength,
      );
    }
    expect(result.contextUsage.measurementQuality).toBe("exact");
    expect(result.contextUsage.toolSchemaTokens).toBeGreaterThan(0);
    expect(result.contextUsage.reservedOutputTokens).toBe(
      model.calls[0].max_tokens,
    );
    expect(result.contextUsage.reservedOutputTokens).toBeLessThan(32768);
  });
  it.each(["countTokens", "applyPromptTemplate"])(
    "sendet bei fehlender %s-Prüfung keine Generierung",
    async (method) => {
      model[method] = async () => {
        throw new Error("Messdienst nicht verfügbar");
      };
      const s = await sessions.createSession();
      const result = await teacher.runTeacher({
        sessionId: s.id,
        userMessage: "Unverändert speichern",
      });
      expect(result.turn.status).toBe("error");
      expect(
        result.session.messages.some(
          (m) => m.content === "Unverändert speichern",
        ),
      ).toBe(true);
      expect(model.calls).toHaveLength(0);
    },
  );
  it.each([0, NaN, -10])(
    "hält bei ungültiger Kontextgröße %s an",
    async (size) => {
      model.contextLength = size;
      const s = await sessions.createSession();
      const result = await teacher.runTeacher({
        sessionId: s.id,
        userMessage: "Hallo",
      });
      expect(result.turn.code).toBe("CONTEXT_UNVERIFIED");
      expect(model.calls).toHaveLength(0);
    },
  );
  it("bewahrt eine zu große aktuelle Anweisung und hält ohne Modellaufruf an", async () => {
    model.contextLength = 4096;
    const s = await sessions.createSession(),
      text = "x".repeat(40000);
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: text,
    });
    expect(result.turn.code).toBe("CONTEXT_TOO_LARGE");
    expect(result.session.messages.find((m) => m.role === "user").content).toBe(
      text,
    );
    expect(model.calls).toHaveLength(0);
  });
  it("liefert /usage ohne ausgewähltes Modell als klar gekennzeichnete Schätzung", async () => {
    await storage.updateSettings({ activeModel: null });
    const s = await sessions.createSession();
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "/usage",
    });
    expect(result.turn.status).toBe("done");
    expect(result.contextUsage.measurementQuality).toBe("estimated");
    expect(result.contextUsage.contextLength).toBeNull();
    expect(
      result.session.messages.filter((m) => m.role === "user"),
    ).toHaveLength(0);
    expect(result.session.messages.at(-1).event.type).toBe("context_usage");
    expect(model.calls).toHaveLength(0);
  });
  it("faltet Systemtext nur bei einem erkannten Templatefehler", async () => {
    const original = model.applyPromptTemplate;
    model.applyPromptTemplate = async (chat, opts) => {
      if (openAIMessages(chat).some((m) => m.role === "system"))
        throw new Error("System role not supported");
      return original(chat, opts);
    };
    const s = await sessions.createSession();
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Hallo",
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    expect(model.calls[0].messages.every((m) => m.role !== "system")).toBe(
      true,
    );
  });
  it("behandelt gemischten Text als Nutzerinhalt und weist widersprüchliche Aktionen zurück", async () => {
    const s = await sessions.createSession();
    await expect(
      teacher.runTeacher({
        sessionId: s.id,
        userMessage: "Hallo",
        contextAction: "usage",
      }),
    ).rejects.toMatchObject({ status: 400 });
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Erkläre /usage bitte",
    });
    expect(
      result.session.messages.some(
        (m) => m.role === "user" && m.content === "Erkläre /usage bitte",
      ),
    ).toBe(true);
    expect(model.calls).toHaveLength(1);
  });
});

describe("Chunks, Cache und Arbeitsstand", () => {
  it("erhält den ursprünglichen Auftrag unabhängig von unvollständigen Zusammenfassungen und überspringt Onboarding-Antworten", async () => {
    await storage.updateSettings({
      keepRecentTokens: 0,
      chunkTokens: 1000,
      summarizerMaxTokens: 200,
      summaryBudgetTokens: 200,
    });
    const s = await sessions.createSession();
    const goal =
      "Projektcode STERN-1847, Dateiname pruefung.py, nächster Schritt ABSCHLUSSTEST.";
    const original = await sessions.mutateSession(s.id, (v) => {
      v.messages.push(
        sessions.message("user", "Direkt anfangen", {
          questionId: v.messages[0].event.questionId,
        }),
        sessions.message("user", goal),
      );
      for (let i = 0; i < 8; i++)
        v.messages.push(
          sessions.message(
            i % 2 ? "assistant" : "user",
            "Unwichtige Lernbeispiele. ".repeat(100),
          ),
        );
    });
    model = fixtureModel({
      predict: () => ({
        content: "Es wurden nur allgemeine Lernbeispiele besprochen.",
      }),
    });
    const ctx = await manager(original);
    const compact = await ctx.prepare(original, [], { force: true });
    expect(compact.contextUsage.rootInstructionRetained).toBe(true);
    expect(
      openAIMessages(compact.chat).find((m) => m.role === "system").content,
    ).toContain(goal);
    const next = await sessions.mutateSession(s.id, (v) =>
      v.messages.push(sessions.message("user", "Nenne die Projektdaten.")),
    );
    const rebuilt = await manager(next);
    const recalled = await rebuilt.prepare(next, [], { diagnostics: true });
    expect(
      openAIMessages(recalled.chat).find((m) => m.role === "system").content,
    ).toContain(goal);
    expect(recalled.contextUsage.rootInstructionTruncated).toBe(false);
  });
  it("begrenzt einen langen ursprünglichen Auftrag ohne die aktuelle Anweisung zu kürzen", async () => {
    const s = await history(4, 6000);
    await storage.updateSettings({
      keepRecentTokens: 0,
      chunkTokens: 1000,
      summarizerMaxTokens: 200,
    });
    const ctx = await manager(s);
    const result = await ctx.prepare(s, [], { force: true });
    expect(result.contextUsage.rootInstructionTruncated).toBe(true);
    const latest = s.messages.findLast((m) => m.role === "user");
    expect(
      openAIMessages(result.chat).some(
        (m) => m.role === "user" && m.content === latest.content,
      ),
    ).toBe(true);
    expect(
      result.contextUsage.promptTokens + result.maxTokens,
    ).toBeLessThanOrEqual(result.contextUsage.contextLength);
  });
  it("begrenzt Fortschrittsmeldungen auch bei sehr vielen Tokenfragmenten", async () => {
    await storage.updateSettings({
      keepRecentTokens: 0,
      chunkTokens: 1000,
      summarizerMaxTokens: 200,
    });
    const s = await history();
    model = fixtureModel({
      predict: (_body, opts) => {
        for (let i = 0; i < 500; i++)
          opts.onPredictionFragment?.({
            content: "x",
            tokensCount: 1,
            reasoningType: "none",
          });
        return { content: "Ziel, Dateien und nächste Schritte erhalten." };
      },
    });
    const progress = [];
    const ctx = await manager(s, {
      onEvent: (event, value) => {
        if (event === "context-progress" && value.percent !== undefined)
          progress.push(value);
      },
    });
    await ctx.prepare(s, [], { force: true });
    const chunks = Map.groupBy(progress, (p) => `${p.chunk}/${p.total}`);
    for (const updates of chunks.values()) {
      expect(updates.length).toBeLessThanOrEqual(101);
      expect(new Set(updates.map((p) => p.percent)).size).toBe(updates.length);
      expect(updates.map((p) => p.percent)).toEqual(
        updates.map((p) => p.percent).sort((a, b) => a - b),
      );
    }
  });
  it("verwendet den tatsächlichen Prozessstatus statt einer veralteten laufenden Ausgabe", async () => {
    const s = await sessions.createSession();
    const { startProcess, waitProcess } =
      await import("../server/services/processes.js");
    const job = await startProcess({
      sessionId: s.id,
      command: "node -e \"process.stdout.write('fertig')\"",
      actor: "user",
    });
    await waitProcess(job.processId, s.id);
    const current = await sessions.mutateSession(s.id, (v) => {
      v.messages.push(
        sessions.message(
          "tool",
          JSON.stringify({
            type: "read_terminal_output",
            processId: job.processId,
            exited: false,
            output: "alter Zwischenstand",
          }),
          { tool_call_id: "historical" },
        ),
      );
    });
    const ctx = await manager(current);
    const view = await ctx.prepare(current, [], { diagnostics: true });
    expect(
      openAIMessages(view.chat).find((m) => m.role === "system").content,
    ).toContain('"status":"exited"');
  });
  it("komprimiert manuell ohne Tutorantwort, behält Originale und verwendet Chunks nach Neustart erneut", async () => {
    await storage.updateSettings({
      keepRecentTokens: 500,
      chunkTokens: 1000,
      summarizerMaxTokens: 200,
    });
    const s = await history();
    const original = JSON.stringify(s.messages);
    const first = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "/compact",
    });
    expect(first.turn.status, first.turn.error).toBe("done");
    expect(first.contextUsage.coveredMessages).toBeGreaterThan(0);
    expect(model.calls.every((c) => !c.stream)).toBe(true);
    expect(
      JSON.stringify(
        first.session.messages.filter(
          (m) =>
            !["context_compaction", "model_usage", "context_snapshot"].includes(
              m.event?.type,
            ),
        ),
      ),
    ).toBe(original);
    const count = model.calls.length;
    const rebuilt = await manager(first.session);
    const prepared = await rebuilt.prepare(first.session, [], {
      diagnostics: true,
    });
    // A different tool schema is intentionally a different namespace.
    const { TOOL_DEFINITIONS } = await import("../server/services/tools.js");
    const matched = await rebuilt.prepare(first.session, TOOL_DEFINITIONS, {
      diagnostics: true,
    });
    expect(matched.contextUsage.coveredMessages).toBe(
      first.contextUsage.coveredMessages,
    );
    expect(model.calls).toHaveLength(count);
    expect(
      openAIMessages(prepared.chat).some((m) => m.content.includes("Fakt-")),
    ).toBe(true);
    const current = first.session.messages.findLast((m) => m.role === "user");
    expect(
      openAIMessages(matched.chat).some(
        (m) => m.role === "user" && m.content === current.content,
      ),
    ).toBe(true);
  });
  it("hält die neueste Anweisung auch nach Komprimierung während desselben Turns wörtlich", async () => {
    const s = await history(10, 1800);
    await storage.updateSettings({
      keepRecentTokens: 0,
      chunkTokens: 1000,
      summarizerMaxTokens: 200,
    });
    const ctx = await manager(s);
    const current = s.messages.findLast((m) => m.role === "user");
    const result = await ctx.prepare(s, [], { force: true });
    expect(ctx.state.coveredCount).toBeGreaterThan(s.messages.indexOf(current));
    expect(
      openAIMessages(result.chat).some(
        (m) => m.role === "user" && m.content === current.content,
      ),
    ).toBe(true);
  });
  it("verwirft einen veralteten Cache nach Edit und erhält alte summaries nur als Altdaten", async () => {
    await storage.updateSettings({ keepRecentTokens: 0, chunkTokens: 1000 });
    const s = await history();
    await sessions.mutateSession(s.id, (v) => {
      v.summaries = [{ text: "ALTE GEHEIME ZUSAMMENFASSUNG" }];
    });
    await teacher.runTeacher({ sessionId: s.id, userMessage: "/compact" });
    const first = s.messages.find((m) => m.role === "user");
    const edited = await teacher.editUserMessage({
      sessionId: s.id,
      messageId: first.id,
      newContent: "NEUER AUFTRAG",
    });
    expect(edited.summaries).toEqual([
      { text: "ALTE GEHEIME ZUSAMMENFASSUNG" },
    ]);
    const ctx = await manager(edited);
    const prepared = await ctx.prepare(edited, [], { diagnostics: true });
    expect(prepared.contextUsage.coveredMessages).toBe(0);
    expect(JSON.stringify(openAIMessages(prepared.chat))).not.toContain(
      "ALTE GEHEIME",
    );
    expect(JSON.stringify(openAIMessages(prepared.chat))).not.toContain(
      "Fakt-0",
    );
  });
  it("behält fertig gespeicherte Chunks nach Abbruch und setzt sie später fort", async () => {
    await storage.updateSettings({
      keepRecentTokens: 0,
      chunkTokens: 1000,
      summarizerMaxTokens: 200,
    });
    const s = await history();
    const controller = new AbortController();
    let summaries = 0;
    model = fixtureModel({
      predict: (body) => {
        if (!body.stream && ++summaries === 2) {
          controller.abort();
          controller.signal.throwIfAborted();
        }
        return summaryOrAnswer(body);
      },
    });
    const first = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "/compact",
      signal: controller.signal,
    });
    expect(first.turn.status).toBe("aborted");
    const cachePath = path.join(root, "context", s.id, "cache.json");
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    expect(Object.keys(cached.entries).length).toBeGreaterThan(0);
    const prefix = JSON.stringify(
      Object.values(cached.entries)[0].chunkSummaries,
    );
    const second = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "/compact",
    });
    expect(second.turn.status, second.turn.error).toBe("done");
    expect(await fs.readFile(cachePath, "utf8")).toContain(
      JSON.parse(prefix)[0],
    );
  });
  it("startet bei beschädigtem Cache neu und kürzt ohne messbaren Gewinn keine Originale", async () => {
    const s = await history(4, 40);
    const ctx = await manager(s);
    await fs.writeFile(
      path.join(root, "context", s.id, "cache.json"),
      "{broken",
    );
    const rebuilt = await manager(s);
    const before = JSON.stringify(s.messages);
    await rebuilt.prepare(s, [], { force: true });
    expect(JSON.stringify(s.messages)).toBe(before);
    expect(ctx.cache.size).toBe(0);
  });
  it("erhält Fragen, Dateiversionen und Rückgängig-Status unabhängig von generierten Zusammenfassungen", async () => {
    const s = await history();
    const initial = await workspace.readFile(s.id, s.activeFile);
    const change = await workspace.writeFile(
      s.id,
      s.activeFile,
      "print('test')",
      initial.version,
      { actor: "ai" },
    );
    const question = {
      type: "ask_question",
      questionId: randomUUID(),
      question: "Welche Schleife?",
      options: ["for", "while"],
    };
    await sessions.mutateSession(s.id, (v) => {
      v.messages.push(
        sessions.message("tool", JSON.stringify(change), {
          tool_call_id: "saved-write",
        }),
        sessions.message("event", "", { event: question }),
      );
      v.learningPlan = {
        goal: "Schleifen",
        topics: [{ id: "loop", title: "for", done: true }],
      };
    });
    await workspace.undoChange(s.id, change.changeId);
    const current = await sessions.loadSession(s.id);
    const ctx = await manager(current);
    const prepared = await ctx.prepare(current, [], { diagnostics: true });
    const text = JSON.stringify(openAIMessages(prepared.chat));
    expect(text).toContain(change.changeId);
    expect(text).toContain("undone");
    expect(text).toContain(question.questionId);
    expect(text).toContain("Welche Schleife?");
    expect(text).toContain("Schleifen");
  });
  it("erzwingt ein begrenztes Summarybudget auch wenn die Zusammenführung leer bleibt", async () => {
    const s = await history(20, 2500);
    await storage.updateSettings({
      keepRecentTokens: 0,
      chunkTokens: 1000,
      summarizerMaxTokens: 200,
      summaryBudgetTokens: 200,
    });
    model = fixtureModel({
      predict: (body) => ({
        content: body.messages.some((m) =>
          m.content.includes("SUMMARIES TO CONSOLIDATE"),
        )
          ? ""
          : "Beleg und konkrete Entscheidung. ".repeat(12),
      }),
    });
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "/compact",
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    const cache = JSON.parse(
      await fs.readFile(path.join(root, "context", s.id, "cache.json"), "utf8"),
    );
    const latest = Object.values(cache.entries).sort(
      (a, b) => b.coveredCount - a.coveredCount,
    )[0];
    expect(
      await model.countTokens(latest.chunkSummaries.join("\n\n")),
    ).toBeLessThanOrEqual(200);
  });
});

describe("Werkzeuge und Fortsetzung", () => {
  it("unterscheidet wiederverwendete Provider-IDs über mehrere SDK-Runden und erhält Versionsprüfungen", async () => {
    const s = await sessions.createSession();
    let round = 0;
    model = fixtureModel({
      predict: () => {
        if (round++ === 0)
          return {
            tool_calls: [
              call(
                "write_file",
                {
                  path: "eins.txt",
                  code: "EINS",
                  reason: "Erste Datei",
                  expectedVersion: "null",
                },
                "0",
              ),
            ],
          };
        if (round === 2)
          return {
            tool_calls: [
              call(
                "write_file",
                {
                  path: "zwei.txt",
                  code: "ZWEI",
                  reason: "Zweite Datei",
                  expectedVersion: null,
                },
                "0",
              ),
            ],
          };
        return { content: "Beide Dateien gespeichert." };
      },
    });
    const turnId = randomUUID();
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Zwei Dateien schreiben",
      turnId,
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    expect((await workspace.readFile(s.id, "eins.txt")).content).toBe("EINS");
    expect((await workspace.readFile(s.id, "zwei.txt")).content).toBe("ZWEI");
    const calls = result.session.messages.flatMap((m) => m.tool_calls || []);
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
    expect(calls.every((c) => /^[a-zA-Z0-9]{9}$/.test(c.id))).toBe(true);
    const { executeTool } = await import("../server/services/toolExecutor.js");
    const refused = await executeTool(
      "write_file",
      {
        path: "eins.txt",
        code: "Überschreiben",
        reason: "Test",
        expectedVersion: "null",
      },
      { sessionId: s.id, turnId, signal: new AbortController().signal },
    );
    expect(refused.code).toBe("CONFLICT");
    expect((await workspace.readFile(s.id, "eins.txt")).content).toBe("EINS");
    const count = model.calls.length;
    await teacher.runTeacher({
      sessionId: s.id,
      turnId,
      userMessage: "Zwei Dateien schreiben",
    });
    expect(model.calls).toHaveLength(count);
    expect(await workspace.listChanges(s.id)).toHaveLength(2);
  });
  it("wartet auch bei vorzeitig gestarteter SDK-Implementierung auf die Speicherung der Anfrage", async () => {
    let durable = false,
      executed = false;
    const r = {
      type: "function",
      id: "eager",
      name: "write_file",
      arguments: { path: "a.txt" },
    };
    const native = {
      act: async (_chat, tools, opts) => {
        opts.onToolCallRequestEnd(0, 0, { toolCallRequest: r });
        const pending = tools[0].implementation(r.arguments, { callId: 0 });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(executed).toBe(false);
        opts.onPredictionCompleted({
          nonReasoningContent: "",
          reasoningContent: "",
          stats: { stopReason: "toolCalls" },
        });
        opts.onMessage(
          ChatMessage.from({
            role: "assistant",
            content: [{ type: "toolCallRequest", toolCallRequest: r }],
          }),
        );
        await pending;
        opts.onRoundEnd(0);
        opts.signal.throwIfAborted();
      },
    };
    const definition = {
      type: "function",
      function: {
        name: "write_file",
        description: "",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    };
    const result = await transport.runModelPass({
      model: native,
      chat: Chat.empty(),
      definitions: [definition],
      maxTokens: 512,
      temperature: 0,
      signal: new AbortController().signal,
      onAssistant: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        durable = true;
      },
      onExecute: async () => {
        expect(durable).toBe(true);
        executed = true;
        return { id: randomUUID(), content: '{"type":"write_file"}' };
      },
      capResult: async (content) => JSON.parse(content),
    });
    expect(result.capped).toBe("rounds");
    expect(executed).toBe(true);
  });
  it("speichert parsebare ungültige Tool-Anfragen samt Fehler und beendet die Runde", async () => {
    const s = await sessions.createSession();
    let round = 0;
    const act = model.act;
    model.act = async (chat, tools, opts) => {
      if (round++) return act(chat, tools, opts);
      const r = {
        type: "function",
        id: "invalid",
        name: "not_a_tool",
        arguments: {},
      };
      const pending = opts.handleInvalidToolRequest(
        new Error("Unknown tool"),
        r,
      );
      opts.onPredictionCompleted({
        nonReasoningContent: "",
        reasoningContent: "",
        stats: { stopReason: "toolCalls" },
      });
      opts.onMessage(
        ChatMessage.from({
          role: "assistant",
          content: [{ type: "toolCallRequest", toolCallRequest: r }],
        }),
      );
      await pending;
      opts.onRoundEnd(0);
      opts.signal.throwIfAborted();
    };
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Bitte Werkzeug nutzen",
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    const raw = result.session.messages.find((m) => m.role === "tool");
    expect(JSON.parse(raw.content).code).toBe("INVALID_TOOL_REQUEST");
    expect(raw.tool_call_id).toBe(
      result.session.messages.find((m) => m.tool_calls?.length).tool_calls[0]
        .id,
    );
  });
  it("meldet vollständig unlesbare Tool-Anfragen sowie leere oder abgeschnittene Antworten ehrlich", async () => {
    const s = await sessions.createSession();
    model.act = async (_chat, _tools, opts) => {
      await opts.handleInvalidToolRequest(new Error("Bad JSON"));
    };
    const invalid = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Werkzeug",
    });
    expect(invalid.turn.code).toBe("INVALID_TOOL_REQUEST");
    model = fixtureModel({ predict: () => ({ content: "" }) });
    const empty = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Hallo",
    });
    expect(empty.turn.code).toBe("EMPTY_RESPONSE");
    model = fixtureModel({
      predict: () => ({
        content: "Teilantwort",
        stopReason: "maxPredictedTokensReached",
      }),
    });
    const limited = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Fortsetzen",
    });
    expect(limited.turn.code).toBe("RESPONSE_LIMIT");
    expect(limited.session.messages.at(-1).incomplete).toBe(true);
    expect(limited.contextUsage.stale).toBe(true);
  });
  it("verwendet nach Neuladen neue Messungen und stoppt bei geändertem Kontextfenster", async () => {
    const s = await sessions.createSession();
    const ctx = await manager(s);
    model.instanceReference = randomUUID();
    const fresh = await transport.connectModel(
      await storage.getSettings(),
      new AbortController().signal,
    );
    await ctx.replaceConnection(fresh);
    await expect(
      ctx.prepare(s, [], { diagnostics: true }),
    ).resolves.toHaveProperty("contextUsage.measurementQuality", "exact");
    model.contextLength = 8192;
    await expect(
      ctx.prepare(s, [], { diagnostics: true }),
    ).rejects.toMatchObject({ code: "MODEL_CHANGED" });
    expect(model.calls).toHaveLength(0);
  });
  it("speichert große Resultate vollständig und macht sie portionsweise wieder lesbar", async () => {
    const s = await sessions.createSession();
    await workspace.writeFile(
      s.id,
      "gross.txt",
      "Anfang\n" + "Testdaten ".repeat(8000) + "\nENDE",
      null,
    );
    let rounds = 0;
    model = fixtureModel({
      predict: (body) =>
        body.stream && rounds++ === 0
          ? { tool_calls: [call("read_file", { path: "gross.txt" })] }
          : { content: "Gelesen." },
    });
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Lies gross.txt",
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    const raw = result.session.messages.find((m) => m.role === "tool");
    expect(raw.content).toContain("ENDE");
    expect(raw.content.length).toBeGreaterThan(70000);
    const capped = JSON.parse(
      model.calls[1].messages.findLast((m) => m.role === "tool").content,
    );
    expect(capped.truncated).toBe(true);
    expect(capped.sourceMessageId).toBe(raw.id);
    expect(capped.version).toBeDefined();
    const ctx = await manager(result.session);
    await ctx.prepare(result.session, [], { diagnostics: true });
    let offset = 0,
      recovered = "";
    do {
      const page = await ctx.readResult(result.session, raw.id, offset);
      expect(await model.countTokens(JSON.stringify(page))).toBeLessThanOrEqual(
        ctx.sizes.maxToolResultTokens,
      );
      recovered += page.content;
      offset = page.nextOffset;
    } while (offset !== null);
    expect(recovered).toBe(raw.content);
    const other = await sessions.createSession();
    await expect(ctx.readResult(other, raw.id, 0)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("ordnet zwei gleichnamige Werkzeuge eindeutig zu und führt sie vor der nächsten Anfrage dauerhaft aus", async () => {
    const s = await sessions.createSession();
    let round = 0;
    model = fixtureModel({
      predict: async (body) => {
        if (round++ === 0)
          return {
            tool_calls: [
              call(
                "write_file",
                {
                  path: "a.txt",
                  code: "A",
                  expectedVersion: null,
                  reason: "A",
                },
                "a",
              ),
              call(
                "write_file",
                {
                  path: "b.txt",
                  code: "B",
                  expectedVersion: null,
                  reason: "B",
                },
                "b",
              ),
            ],
          };
        const saved = await sessions.loadSession(s.id);
        expect(saved.messages.filter((m) => m.role === "tool")).toHaveLength(2);
        expect(
          body.messages
            .filter((m) => m.role === "tool")
            .map((m) => JSON.parse(m.content).path),
        ).toEqual(["a.txt", "b.txt"]);
        return { content: "Beide gespeichert." };
      },
    });
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Schreibe zwei Dateien",
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    expect((await workspace.readFile(s.id, "a.txt")).content).toBe("A");
    expect((await workspace.readFile(s.id, "b.txt")).content).toBe("B");
    expect(model.calls).toHaveLength(2);
  });
  it("komprimiert zwischen langen Werkzeugrunden ohne eine zweite Tool-Schleife", async () => {
    model.contextLength = 8192;
    await storage.updateSettings({
      thresholdPercent: 45,
      compactFloorPercent: 25,
      keepRecentTokens: 500,
      chunkTokens: 1000,
      summarizerMaxTokens: 200,
    });
    const s = await sessions.createSession();
    let round = 0;
    model = fixtureModel({
      contextLength: 8192,
      predict: (body) =>
        !body.stream
          ? {
              content: "Schritte abgeschlossen, aktueller Auftrag unverändert.",
            }
          : round++ < 7
            ? {
                content: "Fortschritt ".repeat(100),
                tool_calls: [
                  call("add_explanation", {
                    title: "Schritt",
                    content: "Beleg ".repeat(1000),
                  }),
                ],
              }
            : { content: "Fertig." },
    });
    const events = [];
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "ARBEITE BIS ZUM ENDE",
      onEvent: (event) => events.push(event),
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    expect(model.calls.filter((c) => c.stream)).toHaveLength(8);
    expect(events).toContain("context-report");
    for (const request of model.calls.filter((c) => c.stream)) {
      expect(
        request.messages.some(
          (m) => m.role === "user" && m.content === "ARBEITE BIS ZUM ENDE",
        ),
      ).toBe(true);
      expect(
        (await model.countTokens(
          JSON.stringify({ messages: request.messages, tools: request.tools }),
        )) + request.max_tokens,
      ).toBeLessThanOrEqual(8192);
    }
  });
  it("repariert nach Neustart fehlende Resultate als unbekannt und wiederholt ausgeführte Schritte nicht automatisch", async () => {
    const s = await sessions.createSession(),
      old = randomUUID();
    await sessions.mutateSession(s.id, (v) => {
      v.messages.push(
        sessions.message("user", "Datei schreiben", { turnId: old }),
        sessions.message("assistant", "", {
          turnId: old,
          tool_calls: [call("write_file", {}, "interrupted")],
        }),
      );
      v.turns[old] = {
        id: old,
        status: "running",
        toolExecutions: { interrupted: "started" },
      };
    });
    const result = await teacher.runTeacher({ sessionId: s.id, retryOf: old });
    expect(result.turn.status, result.turn.error).toBe("done");
    expect(model.calls).toHaveLength(1);
    expect(JSON.stringify(model.calls[0])).toContain("TOOL_RESULT_UNKNOWN");
    expect(
      result.session.messages.filter((m) => m.role === "tool"),
    ).toHaveLength(1);
  });
  it("wiederholt einen transienten Fehler nur vor sichtbarer Ausgabe und Werkzeugausführung", async () => {
    const s = await sessions.createSession();
    let attempts = 0;
    model = fixtureModel({
      predict: () => {
        if (attempts++ === 0) throw new Error("connection reset");
        return { content: "Wieder verbunden." };
      },
    });
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Hallo",
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    expect(attempts).toBe(2);
    model = fixtureModel({
      predict: (_body, opts) => {
        opts.onPredictionFragment({
          content: "Sichtbar",
          reasoningType: "none",
        });
        throw new Error("connection reset");
      },
    });
    transport.setLMStudioClientFactory(() => ({
      llm: { listLoaded: async () => [model] },
    }));
    const failed = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Noch einmal",
    });
    expect(failed.turn.status).toBe("error");
    expect(model.calls).toHaveLength(1);
  });
  it("isoliert parallele Sessions und lehnt überlappende Aktionen derselben Session ab", async () => {
    const first = await sessions.createSession(),
      second = await sessions.createSession();
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    model = fixtureModel({
      predict: async () => {
        await waiting;
        return { content: "Fertig." };
      },
    });
    const running = teacher.runTeacher({
      sessionId: first.id,
      userMessage: "ERSTE SESSION",
    });
    while (!model.calls.length)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(
      teacher.runTeacher({ sessionId: first.id, userMessage: "/usage" }),
    ).rejects.toMatchObject({ code: "TURN_BUSY" });
    const another = teacher.runTeacher({
      sessionId: second.id,
      userMessage: "ZWEITE SESSION",
    });
    release();
    const results = await Promise.all([running, another]);
    expect(results.every((r) => r.turn.status === "done")).toBe(true);
    const firstPrompt = model.calls.find((r) =>
      JSON.stringify(r).includes("ERSTE SESSION"),
    );
    expect(JSON.stringify(firstPrompt)).not.toContain("ZWEITE SESSION");
    expect(await fs.readdir(path.join(root, "context"))).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
  });
});

describe("Migration und Einstellungen", () => {
  it("sichert den sessionspezifischen Cache beim Löschen mit und entfernt dessen aktive Kopie", async () => {
    const s = await history();
    await storage.updateSettings({ keepRecentTokens: 0, chunkTokens: 1000 });
    await teacher.runTeacher({ sessionId: s.id, userMessage: "/compact" });
    await sessions.removeSession(s.id);
    await expect(
      fs.access(path.join(root, "context", s.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const backups = await fs.readdir(path.join(root, "backups"));
    const deleted = backups.find((n) => n.startsWith(`deleted-${s.id}-`));
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(root, "backups", deleted, "context", "cache.json"),
          "utf8",
        ),
      ).entries,
    ).toBeDefined();
  });
  it("sichert alte Einstellungen und Sessions genau einmal und behält deren Originalverlauf", async () => {
    const old = {
      ...storage.defaultSettings(),
      tokenThreshold: 3333,
      keepRecentMessages: 8,
      theme: "light",
    };
    delete old.contextSettingsVersion;
    await storage.writeJSON(path.join(root, "settings.json"), old);
    const migrated = await storage.getSettings();
    expect(migrated.thresholdPercent).toBe(75);
    expect(migrated.theme).toBe("light");
    expect(migrated.tokenThreshold).toBeUndefined();
    const s = await sessions.createSession();
    delete s.contextVersion;
    s.summaries = [{ text: "Altdaten" }];
    await storage.writeJSON(sessions.sessionFile(s.id), s);
    const before = (await fs.readdir(path.join(root, "backups"))).length;
    const current = await sessions.loadSession(s.id);
    await sessions.loadSession(s.id);
    expect(current.contextVersion).toBe(1);
    expect(current.schemaVersion).toBe(2);
    expect(current.summaries).toEqual(s.summaries);
    expect(current.messages).toEqual(s.messages);
    expect(await fs.readdir(path.join(root, "backups"))).toHaveLength(
      before + 1,
    );
  });
  it.each([
    { thresholdPercent: 50, compactFloorPercent: 50 },
    { chunkTokens: 1000.5 },
    { summaryBudgetTokens: 0 },
    { maxToolResultTokens: 4000, maxTotalToolResultTokens: 1000 },
  ])("prüft zusammenhängende Budgeteinstellungen %j", async (update) => {
    await expect(storage.updateSettings(update)).rejects.toMatchObject({
      status: 400,
    });
  });
});
