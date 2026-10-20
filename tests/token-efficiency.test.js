import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  openAIUsage,
  lmStudioUsage,
  turnUsage,
} from "../server/services/modelUsage.js";
import {
  appendStateSnapshot,
  systemPrompt,
} from "../server/services/context/prompt.js";
import { modelHistory } from "../server/services/context/history.js";
import { currentTurnStart } from "../server/services/context/core/view.js";
import { sourceHash } from "../server/services/context/sourceHash.js";

// Import storage consumers only after configuring a disposable workspace.
let root, storage, sessions, workspace, tools, terminal, processes;
let ResultLimiter, projectToolResult, projectHistory, readToolResult;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-efficiency-"));
  vi.stubEnv("STERRACODE_DATA_DIR", root);
  ({ ResultLimiter, projectToolResult, projectHistory, readToolResult } =
    await import("../server/services/context/results.js"));
  storage = await import("../server/services/storage.js");
  expect(storage.DATA_DIR).toBe(root);
  sessions = await import("../server/services/sessions.js");
  workspace = await import("../server/services/workspace.js");
  tools = await import("../server/services/toolExecutor.js");
  terminal = await import("../server/services/terminalPages.js");
  processes = await import("../server/services/processes.js");
  await storage.ensureDataDirs();
});
beforeEach(() => {
  vi.stubEnv("STERRACODE_MODE", "local");
  vi.stubEnv("STERRACODE_RUNNER_URL", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("provider consumption", () => {
  it("keeps absent measurements unknown and counts reasoning only within output", () => {
    expect(openAIUsage({})).toBeUndefined();
    expect(lmStudioUsage({})).toBeUndefined();
    const usage = openAIUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 15 },
      },
    });
    expect(usage.cacheReadTokens).toBeNull();
    const totals = turnUsage(
      [{ id: "a", role: "assistant", turnId: "t", usage }],
      "t",
    );
    expect(totals).toMatchObject({
      totalTokens: 120,
      reasoningTokens: 15,
      cacheReadRatio: null,
    });
    expect(
      lmStudioUsage({ promptTokensCount: 8, predictedTokensCount: 2 }),
    ).toMatchObject({ inputTokens: 8, outputTokens: 2, cacheReadTokens: null });
  });
  it("deduplicates responses and weights only paired cache/input measurements", () => {
    const a = {
      id: "a",
      role: "assistant",
      responseId: "resp",
      turnId: "t",
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 },
    };
    const b = {
      id: "b",
      role: "assistant",
      turnId: "t",
      usage: { inputTokens: 900, outputTokens: 20, cacheReadTokens: 810 },
    };
    expect(turnUsage([a, { ...a, id: "duplicate" }, b], "t")).toMatchObject({
      calls: 2,
      inputTokens: 1000,
      totalTokens: 1030,
      cacheReadRatio: 0.86,
    });
    expect(
      turnUsage(
        [
          a,
          { id: "unmeasured", role: "assistant", turnId: "t", modelCall: true },
        ],
        "t",
      ),
    ).toMatchObject({
      inputTokens: null,
      cacheReadRatio: 0.5,
      cacheMeasuredCalls: 1,
    });
    expect(
      turnUsage([a, { id: "synthetic", role: "assistant", turnId: "t" }], "t"),
    ).toMatchObject({ calls: 1, inputTokens: 100 });
    expect(turnUsage([a], "other")).toBeUndefined();
  });
});

describe("model result projection", () => {
  const count = async (text) => Math.ceil(text.length / 4);
  it("removes duplicated code from legacy writes without changing the original result", async () => {
    const raw = JSON.stringify({
      type: "write_file",
      path: "a.py",
      content: "secret-code".repeat(1000),
      status: "proposed",
      proposalId: "proposal",
      baseVersion: "version",
    });
    const projected = JSON.parse(projectToolResult(raw));
    expect(projected).toEqual({
      type: "write_file",
      status: "proposed",
      path: "a.py",
      proposalId: "proposal",
      baseVersion: "version",
    });
    const limiter = () => new ResultLimiter(count, 400, 2000);
    const direct = await limiter().cap(raw, "result");
    const history = await projectHistory(
      [
        {
          id: "result",
          role: "tool",
          text: "",
          toolResults: [{ toolCallId: "call", content: raw }],
        },
      ],
      limiter,
    );
    expect(history[0].toolResults[0].content).toBe(JSON.stringify(direct));
    expect(JSON.parse(raw).content).toContain("secret-code");
  });
  it("bounds large results and recovers the complete original through pages", async () => {
    const id = randomUUID(),
      raw = JSON.stringify({
        type: "read_file",
        path: "large.py",
        version: "hash",
        content: "Grüße 😀\n".repeat(800),
      });
    const capped = await new ResultLimiter(count, 300, 2000).cap(raw, id);
    expect(await count(JSON.stringify(capped))).toBeLessThanOrEqual(300);
    expect(capped).toMatchObject({
      truncated: true,
      version: "hash",
      recovery: { tool: "read_tool_result", messageId: id },
    });
    const session = { messages: [{ id, role: "tool", content: raw }] };
    let offset = 0,
      recovered = "";
    do {
      const page = await readToolResult(session, id, offset, 300, count);
      expect(await count(JSON.stringify(page))).toBeLessThanOrEqual(300);
      recovered += page.content;
      offset = page.nextOffset;
    } while (offset !== null);
    expect(recovered).toBe(raw);
    await expect(
      readToolResult({ messages: [] }, id, 0, 300, count),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("append-only context snapshots", () => {
  it("retains the prefix and the real current instruction across state changes", () => {
    const session = {
      language: "python",
      activeFile: "main.py",
      learningPlan: null,
      currentTask: null,
      messages: [{ id: "u", role: "user", content: "Mein Auftrag" }],
    };
    appendStateSnapshot(session, { turnId: "t" });
    const original = modelHistory(session),
      hash = sourceHash(session.messages);
    appendStateSnapshot(session, { turnId: "t" });
    expect(modelHistory(session)).toEqual(original);
    session.activeFile = "helper.py";
    session.learningPlan = { goal: "Neues Ziel" };
    session.currentTask = { id: "new-task" };
    appendStateSnapshot(session, { turnId: "t" });
    const updated = modelHistory(session);
    expect(updated.slice(0, original.length)).toEqual(original);
    expect(updated.at(-1).text).toContain("new-task");
    expect(currentTurnStart(updated)).toBe(0);
    expect(sourceHash(session.messages)).not.toBe(hash);
    expect(JSON.stringify(updated)).not.toMatch(/sampledAt|createdAt/);
    const settings = { systemPrompt: "Regeln" };
    expect(systemPrompt(settings, session)).toBe(
      systemPrompt(settings, { ...session, activeFile: "another.py" }),
    );
  });
  it("never splits pending tool pairs and honors profile opt-out in hashes and projection", () => {
    const session = {
      language: "python",
      messages: [
        {
          id: "a",
          role: "assistant",
          tool_calls: [
            { id: "c", function: { name: "list_files", arguments: "{}" } },
          ],
        },
      ],
    };
    expect(() => appendStateSnapshot(session, { turnId: "t" })).toThrow(
      /Tool-Paar/,
    );
    session.messages.push({
      id: "r",
      role: "tool",
      tool_call_id: "c",
      content: "{}",
    });
    appendStateSnapshot(session, { profile: "PRIVATE_PROFILE", turnId: "t" });
    expect(JSON.stringify(modelHistory(session))).not.toContain(
      "PRIVATE_PROFILE",
    );
    expect(
      JSON.stringify(modelHistory(session, { includeProfile: true })),
    ).toContain("PRIVATE_PROFILE");
    expect(sourceHash(session.messages)).not.toBe(
      sourceHash(session.messages, { includeProfile: true }),
    );
  });
});

describe("file ranges and terminal pages", () => {
  it("pages a real local command and archives the full original output", async () => {
    const s = await sessions.createSession();
    const context = {
      sessionId: s.id,
      turnId: randomUUID(),
      signal: new AbortController().signal,
    };
    const result = await tools.executeTool(
      "run_terminal_command",
      { command: "node -e \"process.stdout.write('abc'.repeat(10000))\"" },
      context,
    );
    expect(result.type).toBe("run_terminal_command");
    expect(result.output).toBe("abc".repeat(10000));
    expect(result.modelPage.pageTruncated).toBe(true);
    const projected = JSON.parse(projectToolResult(JSON.stringify(result)));
    expect(Buffer.byteLength(projected.output)).toBeLessThanOrEqual(16384);
    const next = await tools.executeTool(
      "read_terminal_output",
      { processId: result.processId, cursor: projected.nextCursor },
      context,
    );
    expect(projected.output + next.modelPage.output).toBe(result.output);
    expect((await processes.readProcess(result.processId, s.id)).output).toBe(
      result.output,
    );
    const empty = await tools.executeTool(
      "read_terminal_output",
      { processId: result.processId, cursor: next.modelPage.nextCursor },
      context,
    );
    expect(empty.modelPage.output).toBe("");
    expect(empty.exited).toBe(true);
  });
  it("reads inclusive ranges with the full version and preserves CRLF and Unicode", async () => {
    const s = await sessions.createSession();
    const content = "eins\r\nGrüße 😀\r\ndrei\n";
    const saved = await workspace.writeFile(s.id, "ranges.py", content, null);
    const page = await workspace.readFile(s.id, "ranges.py", {
      startLine: 2,
      endLine: 2,
    });
    expect(page).toMatchObject({
      content: "Grüße 😀\r\n",
      version: saved.version,
      totalLines: 3,
      startLine: 2,
      endLine: 2,
    });
    expect((await workspace.readFile(s.id, "ranges.py")).content).toBe(content);
    const throughTool = await tools.executeTool(
      "read_file",
      { path: "ranges.py", startLine: 2, endLine: 99 },
      { sessionId: s.id },
    );
    expect(throughTool).toMatchObject({
      content: "Grüße 😀\r\ndrei\n",
      endLine: 3,
    });
    for (const range of [
      { startLine: 0 },
      { endLine: -1 },
      { startLine: 3, endLine: 2 },
      { startLine: 99 },
      { startLine: 1.1 },
    ])
      await expect(
        workspace.readFile(s.id, "ranges.py", range),
      ).rejects.toThrow();
    await workspace.writeFile(s.id, "empty.py", "", null);
    expect(
      await workspace.readFile(s.id, "empty.py", { startLine: 1 }),
    ).toMatchObject({ content: "", totalLines: 1 });
  });

  it.each(["local", "docker:http://runner.test"])(
    "reassembles Unicode pages using %s native offsets and validates cursor binding",
    async (runtime) => {
      const processId = "process",
        sessionId = "session";
      const raw = "Grüße 😀 界\n".repeat(5000);
      const snapshot = { processId, output: raw, exited: true, exitCode: 0 };
      const original = terminal.terminalPage(snapshot, sessionId, runtime);
      expect(Buffer.byteLength(original.output)).toBeLessThanOrEqual(16384);
      expect(original.output).not.toContain("�");
      expect(original.pageTruncated).toBe(true);
      expect(snapshot.output).toBe(raw);
      const archived = terminal.terminalPage(
        snapshot,
        sessionId,
        runtime,
        0,
        true,
      );
      expect(archived.output).toBe(raw);
      const forModel = JSON.parse(
        projectToolResult(
          JSON.stringify({ type: "read_terminal_output", ...archived }),
        ),
      );
      expect(forModel.output).toBe(original.output);
      expect(forModel.nextCursor).toBe(original.nextCursor);
      expect(forModel.modelPage).toBeUndefined();
      if (runtime !== "local") {
        vi.stubEnv("STERRACODE_RUNNER_URL", "http://runner.test");
        const file = path.join(root, "runner-secret");
        await fs.writeFile(file, "fixture-secret");
        vi.stubEnv("STERRACODE_RUNNER_SECRET_FILE", file);
        vi.stubGlobal(
          "fetch",
          vi.fn(async (url) => {
            const offset = Number(new URL(url).searchParams.get("offset"));
            return new Response(
              JSON.stringify({
                ...snapshot,
                output: Buffer.from(raw).subarray(offset).toString("utf8"),
                offset: Buffer.byteLength(raw),
              }),
              { headers: { "X-Runner-Protocol": "1" } },
            );
          }),
        );
      } else {
        // Exercise the local adapter's existing character-offset contract.
        const local = await import("../server/services/localProcesses.js");
        vi.spyOn(local, "readProcess").mockImplementation(
          (id, session, offset) => ({
            ...snapshot,
            output: raw.slice(offset),
            offset: raw.length,
          }),
        );
      }
      let page = original,
        combined = "";
      do {
        combined += page.output;
        page = await terminal.readTerminalPage(
          processId,
          sessionId,
          page.nextCursor,
        );
        expect(Buffer.byteLength(page.output)).toBeLessThanOrEqual(16384);
        expect(page.output).not.toContain("�");
      } while (page.output.length);
      expect(combined).toBe(raw);
      expect(page).toMatchObject({ exited: true, exitCode: 0, output: "" });
      await expect(
        terminal.readTerminalPage("foreign", sessionId, page.nextCursor),
      ).rejects.toThrow(/Cursor/);
      await expect(
        terminal.readTerminalPage(processId, "foreign", page.nextCursor),
      ).rejects.toThrow(/Cursor/);
      await expect(
        terminal.readTerminalPage(
          processId,
          sessionId,
          page.nextCursor + "tampered",
        ),
      ).rejects.toThrow(/Cursor/);
      vi.stubEnv(
        "STERRACODE_RUNNER_URL",
        runtime === "local" ? "http://other.test" : "",
      );
      await expect(
        terminal.readTerminalPage(processId, sessionId, page.nextCursor),
      ).rejects.toThrow(/Cursor/);
    },
  );
});
