import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Chat } from "@lmstudio/sdk";

let temp,
  storage,
  sessions,
  teacher,
  credentials,
  openai,
  lm,
  responses,
  requests;
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const message = (text) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});
function streaming(response) {
  const text = (response.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content)
    .map((item) => item.text || "")
    .join("");
  const frames = [
    ...(text ? [{ type: "response.output_text.delta", delta: text }] : []),
    {
      type:
        response.status === "incomplete"
          ? "response.incomplete"
          : "response.completed",
      response,
    },
  ];
  const encoded = new TextEncoder().encode(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let index = 0; index < encoded.length; index += 31)
          controller.enqueue(encoded.slice(index, index + 31));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "sterracode-openai-"));
  vi.stubEnv("STERRACODE_DATA_DIR", temp);
  vi.stubEnv("STERRACODE_OPENAI_API_KEY_FILE", "");
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  teacher = await import("../server/services/teacher.js");
  credentials = await import("../server/services/providerCredentials.js");
  openai = await import("../server/services/openAI.js");
  lm = await import("../server/services/lmStudio.js");
  await storage.ensureDataDirs();
});
beforeEach(async () => {
  vi.stubEnv("STERRACODE_OPENAI_API_KEY_FILE", "");
  await credentials.updateProviderCredentials({
    provider: "openai",
    apiKey: "sk-fixture-private-key",
  });
  await storage.updateSettings({
    ...storage.defaultSettings(),
    provider: "openai",
    openAIModel: "fixture-responses-model",
  });
  responses = [];
  requests = [];
  openai.setOpenAITransportForTests(async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, options, body });
    if (url.endsWith("/models"))
      return jsonResponse({ data: [{ id: "fixture-responses-model" }] });
    if (url.endsWith("/responses/input_tokens"))
      return jsonResponse({
        input_tokens: Math.ceil(JSON.stringify(body).length / 4),
      });
    const response = responses.shift() || {
      status: "completed",
      output: [message("Antwort Grüße 世界")],
    };
    return body.stream ? streaming(response) : jsonResponse(response);
  });
});
afterAll(async () => {
  openai.setOpenAITransportForTests();
  vi.unstubAllEnvs();
  await fs.rm(temp, { recursive: true, force: true });
});
describe("OpenAI key handling", () => {
  it("returns only configured metadata and rejects general settings credentials", async () => {
    expect(await credentials.getProviderCredentials()).toEqual({
      openai: { configured: true, source: "saved" },
    });
    expect(JSON.stringify(await storage.getSettings())).not.toContain(
      "sk-fixture-private-key",
    );
    await expect(
      storage.updateSettings({ apiKey: "sk-secret" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    if (process.platform !== "win32")
      expect(
        (await fs.stat(path.join(temp, "provider-secrets.json"))).mode & 0o777,
      ).toBe(0o600);
    await credentials.updateProviderCredentials({
      provider: "openai",
      apiKey: null,
    });
    expect((await credentials.getProviderCredentials()).openai.configured).toBe(
      false,
    );
    await expect(credentials.getOpenAIKey()).rejects.toMatchObject({
      code: "OPENAI_KEY_REQUIRED",
    });
  });
  it("prioritizes a read-only secret file and never sends keys to a configurable URL", async () => {
    const file = path.join(temp, "openai-secret");
    await fs.writeFile(file, "sk-file-private-key\n");
    vi.stubEnv("STERRACODE_OPENAI_API_KEY_FILE", file);
    expect(await credentials.getOpenAIKey()).toBe("sk-file-private-key");
    await expect(
      credentials.updateProviderCredentials({
        provider: "openai",
        apiKey: null,
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_SECRET" });
    await lm.listLoadedModels({
      provider: "openai",
      lmStudioUrl: "http://attacker.invalid",
    });
    expect(requests[0].url).toBe("https://api.openai.com/v1/models");
    expect(requests[0].options.redirect).toBe("error");
    expect(requests[0].options.headers.Authorization).toBe(
      "Bearer sk-file-private-key",
    );
  });
});
describe("Responses provider", () => {
  it("counts duplicate completion frames once", async () => {
    const response = {
      id: "same-completion",
      status: "completed",
      output: [message("Einmal")],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 50 },
      },
    };
    openai.setOpenAITransportForTests(async (url) => {
      if (url.endsWith("/responses/input_tokens"))
        return jsonResponse({ input_tokens: 100 });
      const frame = `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
      return new Response(frame + frame, {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const session = await sessions.createSession();
    const result = await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "Einmal zählen",
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    expect(result.turn.usage).toMatchObject({
      calls: 1,
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(
      result.session.messages.filter((m) => m.responseId === response.id),
    ).toHaveLength(1);
  });
  it("removes obsolete snapshots on edit and deletion before producing new state", async () => {
    const session = await sessions.createSession();
    const first = await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "Alter Auftrag",
    });
    const user = first.session.messages.find((m) => m.role === "user");
    const snapshot = first.session.messages.find(
      (m) => m.event?.type === "context_snapshot",
    );
    const edited = await teacher.editUserMessage({
      sessionId: session.id,
      messageId: user.id,
      newContent: "Neuer Auftrag",
    });
    expect(edited.messages.some((m) => m.id === snapshot.id)).toBe(false);
    requests.length = 0;
    const next = await teacher.runTeacher({
      sessionId: session.id,
      existingUserMessageId: user.id,
    });
    expect(next.turn.status, next.turn.error).toBe("done");
    const input = requests.find((r) => r.url.endsWith("/responses")).body.input;
    expect(JSON.stringify(input)).not.toContain("Alter Auftrag");
    expect(JSON.stringify(input)).toContain("Neuer Auftrag");
    const removed = await teacher.deleteLastUserMessage({
      sessionId: session.id,
    });
    expect(
      removed.session.messages.some(
        (m) => m.event?.type === "context_snapshot",
      ),
    ).toBe(false);
  });
  it("records measured usage across streaming tool rounds without counting token probes or /usage", async () => {
    const session = await sessions.createSession();
    responses.push({
      id: "resp-usage-tools",
      status: "completed",
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        input_tokens_details: { cached_tokens: 800, cache_write_tokens: 200 },
        output_tokens_details: { reasoning_tokens: 60 },
      },
      output: [
        {
          type: "function_call",
          call_id: "usage-files",
          name: "list_files",
          arguments: "{}",
        },
      ],
    });
    responses.push({
      id: "resp-usage-answer",
      status: "completed",
      usage: {
        input_tokens: 3000,
        output_tokens: 200,
        input_tokens_details: { cached_tokens: 2700, cache_write_tokens: 300 },
        output_tokens_details: { reasoning_tokens: 120 },
      },
      output: [message("Fertig")],
    });
    const result = await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "Verbrauch prüfen",
      stream: true,
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    expect(result.turn.usage).toMatchObject({
      calls: 2,
      inputTokens: 4000,
      outputTokens: 300,
      reasoningTokens: 180,
      totalTokens: 4300,
      cacheReadRatio: 0.875,
      cacheWriteTokens: 500,
    });
    expect(result.contextUsage.consumption).toEqual(result.turn.usage);
    const assistants = result.session.messages.filter(
      (m) => m.role === "assistant",
    );
    expect(assistants.map((m) => m.responseId)).toEqual([
      "resp-usage-tools",
      "resp-usage-answer",
    ]);
    expect(assistants.every((m) => m.usage)).toBe(true);
    const snapshots = result.session.messages.filter(
      (m) => m.event?.type === "context_snapshot",
    );
    const diagnosed = await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "/usage",
    });
    expect(diagnosed.turn.usage).toBeUndefined();
    expect(
      diagnosed.session.messages.filter(
        (m) => m.event?.type === "context_snapshot",
      ),
    ).toEqual(snapshots);
    expect(requests.filter((r) => r.url.endsWith("/responses"))).toHaveLength(
      2,
    );
  });
  it("exposes usage for JSON responses and leaves missing cache fields unknown", async () => {
    const { model } = await openai.connectOpenAIModel(
      await storage.getSettings(),
    );
    responses.push({
      id: "json-usage",
      status: "completed",
      usage: { input_tokens: 90, output_tokens: 10 },
      output: [message("JSON")],
    });
    const result = await model.respond(Chat.from("Hallo"));
    expect(result).toMatchObject({
      responseId: "json-usage",
      usage: {
        inputTokens: 90,
        outputTokens: 10,
        cacheReadTokens: null,
        reasoningTokens: null,
      },
    });
  });
  it("records standalone JSON compaction usage and never reprojects the returned window", async () => {
    const session = await sessions.createSession();
    await teacher.runTeacher({ sessionId: session.id, userMessage: "Vorher" });
    const window = [
      {
        type: "function_call",
        call_id: "compact-read",
        name: "read_file",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "compact-read",
        output: "UNTOUCHED_".repeat(3000),
      },
      { type: "compaction", encrypted_content: "opaque-native-window" },
    ];
    openai.setOpenAITransportForTests(async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (url.endsWith("/responses/compact"))
        return jsonResponse({
          id: "compact-usage",
          output: window,
          usage: { input_tokens: 2000, output_tokens: 200 },
        });
      if (url.endsWith("/responses/input_tokens"))
        return jsonResponse({ input_tokens: 500 });
      return streaming({ status: "completed", output: [message("Weiter")] });
    });
    const compacted = await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "/compact",
    });
    expect(compacted.turn.usage).toMatchObject({
      calls: 1,
      inputTokens: 2000,
      outputTokens: 200,
      totalTokens: 2200,
      cacheReadRatio: null,
    });
    requests.length = 0;
    await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "Fortsetzen",
    });
    expect(
      requests.find((r) => r.url.endsWith("/responses")).body.input.slice(1, 4),
    ).toEqual(window);
  });
  it("preserves an identical input prefix when the active file changes", async () => {
    const session = await sessions.createSession();
    await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "Erster Auftrag",
    });
    const before = requests.find((r) => r.url.endsWith("/responses")).body
      .input;
    await sessions.mutateSession(session.id, (s) => {
      s.activeFile = "other.py";
    });
    const result = await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "Zweiter Auftrag",
    });
    expect(result.turn.status, result.turn.error).toBe("done");
    const after = requests.filter((r) => r.url.endsWith("/responses")).at(-1)
      .body.input;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1).content).toContain("other.py");
    const snapshots = result.session.messages.filter(
      (m) => m.event?.type === "context_snapshot",
    );
    expect(snapshots).toHaveLength(2);
    const unchanged = await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "Weiter",
    });
    expect(
      unchanged.session.messages.filter(
        (m) => m.event?.type === "context_snapshot",
      ),
    ).toEqual(snapshots);
  });
  it("projects legacy writes and limits large OpenAI results while preserving original recovery data", async () => {
    await storage.updateSettings({
      maxToolResultTokens: 400,
      maxTotalToolResultTokens: 2000,
    });
    const s = await sessions.createSession();
    const original = "print('large file')\n".repeat(1000);
    const raw = JSON.stringify({
      type: "read_file",
      path: "large.py",
      content: original,
      version: "version",
    });
    const resultId = randomUUID();
    const session = await sessions.mutateSession(s.id, (v) =>
      v.messages.push(
        sessions.message("user", "Lies die Datei"),
        sessions.message("assistant", "", {
          tool_calls: [
            {
              id: "legacy-write",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "large.py", code: original }),
              },
            },
          ],
        }),
        sessions.message(
          "tool",
          JSON.stringify({
            type: "write_file",
            content: original,
            status: "applied",
            path: "large.py",
            version: "version",
          }),
          { tool_call_id: "legacy-write" },
        ),
        sessions.message("assistant", "", {
          tool_calls: [
            {
              id: "legacy-read",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        }),
        {
          ...sessions.message("tool", raw, { tool_call_id: "legacy-read" }),
          id: resultId,
        },
      ),
    );
    const { OpenAIContext } =
      await import("../server/services/openAIContext.js");
    const connection = await openai.connectOpenAIModel(
      await storage.getSettings(),
    );
    const manager = new OpenAIContext({
      connection,
      settings: await storage.getSettings(),
      signal: new AbortController().signal,
    });
    await manager.prepare(session, []);
    const outputs = connection.model.nativeInput.filter(
      (i) => i.type === "function_call_output",
    );
    expect(JSON.parse(outputs[0].output)).toEqual({
      type: "write_file",
      status: "applied",
      path: "large.py",
      version: "version",
    });
    expect(JSON.parse(outputs[1].output)).toMatchObject({
      truncated: true,
      recovery: { messageId: resultId },
    });
    expect(Math.ceil(outputs[1].output.length / 4)).toBeLessThanOrEqual(400);
    let offset = 0,
      recovered = "";
    do {
      const page = await manager.readResult(session, resultId, offset);
      recovered += page.content;
      offset = page.nextOffset;
    } while (offset !== null);
    expect(recovered).toBe(raw);
    const first = JSON.stringify(connection.model.nativeInput);
    await manager.prepare(session, []);
    expect(JSON.stringify(connection.model.nativeInput)).toBe(first);
    expect(
      (await sessions.loadSession(s.id)).messages.find((m) => m.id === resultId)
        .content,
    ).toBe(raw);
  });
  it("isolates token memos and context namespaces by provider and effective LM Studio origin", async () => {
    const { ContextManager, contextProviderIdentity } =
      await import("../server/services/context/index.js");
    const session = await sessions.createSession();
    const make = (provider, count) =>
      new ContextManager({
        connection: {
          identity: "identical-model-metadata",
          model: { countTokens: async () => count },
        },
        settings: { provider, lmStudioUrl: "http://original.example" },
        sessionId: session.id,
        signal: new AbortController().signal,
      });
    expect(await make("lmstudio", 10).count("identical-token-input")).toBe(10);
    expect(await make("openai", 20).count("identical-token-input")).toBe(20);
    const original = contextProviderIdentity({
      provider: "lmstudio",
      lmStudioUrl: "http://original.example",
    });
    vi.stubEnv("STERRACODE_LM_STUDIO_OVERRIDE_URL", "https://other-lm.example");
    try {
      expect(await make("lmstudio", 30).count("identical-token-input")).toBe(
        30,
      );
      expect(
        contextProviderIdentity({
          provider: "lmstudio",
          lmStudioUrl: "http://original.example",
        }),
      ).not.toBe(original);
    } finally {
      vi.stubEnv("STERRACODE_LM_STUDIO_OVERRIDE_URL", "");
    }
  });
  it("tests model access and exact remote input counts without generating a response", async () => {
    const result = await openai.testOpenAIConnection(
      await storage.getSettings(),
    );
    expect(result).toMatchObject({
      provider: "openai",
      status: "ready",
      tokenization: true,
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1/responses/input_tokens",
    ]);
  });
  it("measures full message and function schemas with the Responses count endpoint", async () => {
    const { model } = await lm.connectModel(await storage.getSettings());
    const tools = [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ];
    const rendered = await model.applyPromptTemplate(
      Chat.from([
        { role: "system", content: "Root" },
        { role: "user", content: "Hello" },
      ]),
      { toolDefinitions: tools },
    );
    await model.countTokens(rendered);
    expect(requests.at(-1).body).toMatchObject({
      model: "fixture-responses-model",
      input: [
        { role: "developer", content: "Root" },
        { role: "user", content: "Hello" },
      ],
      tools: [{ type: "function", name: "read_file", strict: false }],
    });
  });
  it("streams and persists one final assistant response through the existing teacher", async () => {
    const session = await sessions.createSession();
    const events = [];
    const result = await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "Hallo",
      stream: true,
      onEvent: (type, data) => events.push({ type, data }),
    });
    expect(result.turn.status).toBe("done");
    expect(
      result.session.messages
        .filter((m) => m.role === "assistant")
        .map((m) => m.content),
    ).toEqual(["Antwort Grüße 世界"]);
    expect(
      events.some(
        (event) => event.type === "token" && event.data.token.includes("世界"),
      ),
    ).toBe(true);
    const generation = requests.find((request) =>
      request.url.endsWith("/responses"),
    );
    expect(generation.body).toMatchObject({
      store: false,
      stream: true,
      parallel_tool_calls: false,
      truncation: "disabled",
      include: ["reasoning.encrypted_content"],
    });
  });
  it("persists a tool request before execution and carries encrypted reasoning to the next pass", async () => {
    const session = await sessions.createSession();
    responses.push({
      status: "completed",
      output: [
        {
          id: "rs_fixture",
          type: "reasoning",
          summary: [],
          encrypted_content: "opaque-fixture-reasoning",
        },
        {
          type: "function_call",
          call_id: "call_fixture",
          name: "list_files",
          arguments: "{}",
        },
      ],
    });
    responses.push({
      status: "completed",
      output: [message("Die Dateien sind gelesen.")],
    });
    const result = await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "Welche Dateien?",
    });
    expect(result.turn.status).toBe("done");
    const generations = requests.filter((request) =>
      request.url.endsWith("/responses"),
    );
    expect(generations).toHaveLength(2);
    const input = generations[1].body.input;
    expect(
      input.some(
        (item) =>
          item.type === "reasoning" &&
          item.encrypted_content === "opaque-fixture-reasoning",
      ),
    ).toBe(true);
    expect(
      input.some(
        (item) =>
          item.type === "function_call" && item.call_id === "call_fixture",
      ),
    ).toBe(true);
    expect(
      input.some(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === "call_fixture",
      ),
    ).toBe(true);
    const assistant = result.session.messages.find((m) => m.tool_calls?.length);
    expect(assistant.providerItems[0].type).toBe("reasoning");
    expect(
      result.session.messages.findIndex((m) => m === assistant),
    ).toBeLessThan(result.session.messages.findIndex((m) => m.role === "tool"));
  });
  it("does not impose a local output limit on OpenAI helper responses", async () => {
    const { model } = await lm.connectModel(await storage.getSettings());
    const result = await model.respond(
      Chat.from([
        { role: "system", content: "Summarize" },
        { role: "user", content: "Known context" },
      ]),
      { maxTokens: 500 },
    );
    expect(result.content).toContain("Antwort");
    expect(
      requests.find((request) => request.url.endsWith("/responses")).body,
    ).toMatchObject({ tools: [], store: false });
    expect(
      requests.find((request) => request.url.endsWith("/responses")).body,
    ).not.toHaveProperty("max_output_tokens");
  });
  it("delegates compaction and token limits independently of local settings", async () => {
    await storage.updateSettings({
      autoCompact: false,
      maxTokensResponse: 256,
      thresholdPercent: 95,
    });
    const session = await sessions.createSession();
    const result = await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "Ungekürzter Auftrag",
    });
    expect(result.turn.status).toBe("done");
    const body = requests.find((r) => r.url.endsWith("/responses")).body;
    expect(body.context_management).toEqual([{ type: "compaction" }]);
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("compact_threshold");
    expect(body.input).toContainEqual({
      role: "user",
      content: "Ungekürzter Auftrag",
    });
    expect(body.tools.some((t) => t.name === "trigger_summarize")).toBe(false);
    expect(result.contextUsage).toMatchObject({
      managedBy: "openai",
      contextLength: null,
      reservedOutputTokens: 0,
    });
    await expect(
      storage.updateSettings({ openAIContextLength: 4096 }),
    ).rejects.toThrow("Unbekannte Einstellung");
    await expect(
      fs.access(path.join(temp, "context", session.id, "cache.json")),
    ).rejects.toThrow();
  });
  it("replays encrypted server compaction across turns without replaying the old transcript", async () => {
    const session = await sessions.createSession();
    const compact = {
      type: "compaction",
      id: "cmp_auto",
      encrypted_content: "opaque-auto",
    };
    responses.push({
      status: "completed",
      output: [compact, message("Erledigt")],
    });
    const first = await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "Alte Anweisung",
    });
    expect(first.turn.status).toBe("done");
    expect(
      first.session.messages.find((m) => m.role === "assistant").providerState
        .output[0],
    ).toEqual(compact);
    requests.length = 0;
    await teacher.runTeacher({ sessionId: session.id, userMessage: "Weiter" });
    const body = requests.find((r) => r.url.endsWith("/responses")).body;
    expect(body.input).toContainEqual(compact);
    expect(body.input).not.toContainEqual({
      role: "user",
      content: "Alte Anweisung",
    });
    expect(body.input).toContainEqual({ role: "user", content: "Weiter" });
    expect(body.input[0].role).toBe("developer");
  });
  it("uses standalone OpenAI compaction and preserves its complete returned window", async () => {
    const session = await sessions.createSession();
    await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "Erster Auftrag",
    });
    const window = [
      { role: "user", content: "Von OpenAI beibehaltener Kontext" },
      {
        type: "compaction",
        id: "cmp_manual",
        encrypted_content: "opaque-manual",
      },
    ];
    openai.setOpenAITransportForTests(async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (url.endsWith("/responses/compact"))
        return jsonResponse({ output: window });
      if (url.endsWith("/responses/input_tokens"))
        return jsonResponse({ input_tokens: 30 });
      return streaming({
        status: "completed",
        output: [message("Weitergearbeitet")],
      });
    });
    const compacted = await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "/compact",
    });
    expect(compacted.turn.status).toBe("done");
    expect(
      requests.filter((r) => r.url.endsWith("/responses/compact")),
    ).toHaveLength(1);
    expect(
      compacted.session.messages.some((m) => m.event?.providerState?.replace),
    ).toBe(true);
    for (const text of ["Weiter", "Noch weiter"]) {
      requests.length = 0;
      await teacher.runTeacher({ sessionId: session.id, userMessage: text });
      const input = requests.find((r) => r.url.endsWith("/responses")).body
        .input;
      expect(input.slice(1, 3)).toEqual(window);
    }
  });
  it("invalidates opaque compaction when its source history changes", async () => {
    const session = await sessions.createSession();
    responses.push({
      status: "completed",
      output: [
        { type: "compaction", encrypted_content: "obsolete" },
        message("Antwort"),
      ],
    });
    await teacher.runTeacher({
      sessionId: session.id,
      userMessage: "Ursprünglich",
    });
    await sessions.mutateSession(session.id, (s) => {
      s.messages.find((m) => m.role === "user").content = "Korrigierte Quelle";
    });
    requests.length = 0;
    await teacher.runTeacher({ sessionId: session.id, userMessage: "Weiter" });
    const input = requests.find((r) => r.url.endsWith("/responses")).body.input;
    expect(input.some((item) => item.type === "compaction")).toBe(false);
    expect(input).toContainEqual({
      role: "user",
      content: "Korrigierte Quelle",
    });
  });
  it("discovers selectable model IDs directly from OpenAI", async () => {
    openai.setOpenAITransportForTests(async (url) => {
      expect(url).toBe("https://api.openai.com/v1/models");
      return jsonResponse({
        data: [{ id: "z-model" }, { id: "new-model" }, { id: 4 }],
      });
    });
    expect(await openai.listOpenAIModels()).toEqual([
      { identifier: "new-model", displayName: "new-model" },
      { identifier: "z-model", displayName: "z-model" },
    ]);
  });
  it("does not execute incomplete calls and preserves an interrupted stream without replay", async () => {
    const { model } = await lm.connectModel(await storage.getSettings()),
      execute = vi.fn();
    responses.push({
      status: "incomplete",
      output: [
        {
          type: "function_call",
          call_id: "unfinished",
          name: "list_files",
          arguments: "{}",
        },
      ],
    });
    const result = await openai.runOpenAIModelPass({
      model,
      chat: Chat.from("Hello"),
      definitions: [],
      maxTokens: 32,
      signal: new AbortController().signal,
      onAssistant: vi.fn(),
      onExecute: execute,
      capResult: vi.fn(),
    });
    expect(result.stopReason).toBe("maxPredictedTokensReached");
    expect(execute).not.toHaveBeenCalled();
    openai.setOpenAITransportForTests(
      async () =>
        new Response(
          'data: {"type":"response.output_text.delta","delta":"Part"}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    await expect(
      openai.runOpenAIModelPass({
        model,
        chat: Chat.from("Hello"),
        definitions: [],
        maxTokens: 32,
        signal: new AbortController().signal,
        onAssistant: vi.fn(),
        onExecute: execute,
        capResult: vi.fn(),
      }),
    ).rejects.toMatchObject({
      code: "OPENAI_STREAM_INTERRUPTED",
      passStats: { visibleChars: 4, executedTools: 0 },
    });
  });
  it("never returns a remote error body containing secrets", async () => {
    openai.setOpenAITransportForTests(async () =>
      jsonResponse(
        {
          error: {
            message: "sk-fixture-private-key source text",
            code: "invalid_api_key",
          },
        },
        401,
      ),
    );
    const result = await openai.testOpenAIConnection(
      await storage.getSettings(),
    );
    expect(result.code).toBe("OPENAI_AUTH_FAILED");
    expect(JSON.stringify(result)).not.toContain("sk-fixture-private-key");
  });
  it("records malformed tool arguments safely without executing them", async () => {
    const { model } = await lm.connectModel(await storage.getSettings());
    responses.push({
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "bad_arguments",
          name: "list_files",
          arguments: "{broken",
        },
      ],
    });
    const execute = vi.fn(),
      invalid = vi.fn(),
      assistant = vi.fn();
    await openai.runOpenAIModelPass({
      model,
      chat: Chat.from("Hello"),
      definitions: [
        { type: "function", function: { name: "list_files", parameters: {} } },
      ],
      maxTokens: 32,
      signal: new AbortController().signal,
      onAssistant: assistant,
      onExecute: execute,
      onInvalid: invalid,
      capResult: vi.fn(),
    });
    expect(execute).not.toHaveBeenCalled();
    expect(invalid).toHaveBeenCalledOnce();
    expect(assistant.mock.calls[0][0].tool_calls[0].function.arguments).toBe(
      "{}",
    );
  });
  it("cancels before sending an OpenAI request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    await expect(openai.listOpenAIModels(controller.signal)).rejects.toThrow(
      "user cancelled",
    );
    expect(requests).toHaveLength(0);
  });
});
