import { AppError, validateSessionId } from "../storage.js";
import { boundText } from "./core/internalPrediction.js";

const retainedKeys = [
  "type",
  "status",
  "path",
  "version",
  "changeId",
  "proposalId",
  "baseVersion",
  "proposalStatus",
  "undone",
  "processId",
  "traceRunId",
  "testRunId",
  "taskId",
  "taskVersion",
  "suiteVersion",
  "assessment",
  "current",
  "fromStep",
  "nextStep",
  "reason",
  "complete",
  "exited",
  "exitCode",
  "questionId",
  "code",
  "messageId",
  "offset",
  "nextOffset",
  "nextCursor",
  "totalLines",
  "startLine",
  "endLine",
];

// Keep the durable/UI result intact; only project what the model needs.
export function projectToolResult(content) {
  let result;
  try {
    result = JSON.parse(content);
  } catch {
    return content;
  }
  if (
    ["run_terminal_command", "read_terminal_output"].includes(result?.type) &&
    result.modelPage
  ) {
    const { modelPage, ...original } = result;
    return JSON.stringify({ ...original, ...modelPage });
  }
  if (result?.type !== "write_file") return content;
  return JSON.stringify(
    Object.fromEntries(
      retainedKeys
        .filter((key) => result[key] !== undefined)
        .map((key) => [key, result[key]]),
    ),
  );
}

export class ResultLimiter {
  constructor(count, perResult, total, project = projectToolResult) {
    this.count = count;
    this.perResult = perResult;
    this.total = total;
    this.used = 0;
    this.project = project;
  }
  async cap(content, messageId) {
    content = this.project(content);
    const tokens = await this.count(content);
    const budget = Math.max(
      1,
      Math.min(this.perResult, this.total - this.used),
    );
    if (tokens <= budget) {
      this.used += tokens;
      try {
        return JSON.parse(content);
      } catch {
        return content;
      }
    }
    let original;
    try {
      original = JSON.parse(content);
    } catch {
      original = {};
    }
    const metadata = Object.fromEntries(
      retainedKeys
        .filter((k) => original[k] !== undefined)
        .map((k) => [k, original[k]]),
    );
    let result = {
      ...metadata,
      truncated: true,
      sourceMessageId: messageId,
      recovery: { tool: "read_tool_result", messageId, offset: 0 },
    };
    // Keep IDs atomically; huge paths/status strings can also be recovered.
    if ((await this.count(JSON.stringify(result))) > budget)
      result = {
        type: original.type,
        truncated: true,
        sourceMessageId: messageId,
        recovery: { tool: "read_tool_result", messageId, offset: 0 },
      };
    const overhead = await this.count(
      JSON.stringify({ ...result, excerpt: "" }),
    );
    const excerpt = await boundText(
      content,
      Math.max(0, budget - overhead - 16),
      this.count,
    );
    if (excerpt) result.excerpt = excerpt;
    while (
      result.excerpt &&
      (await this.count(JSON.stringify(result))) > budget
    ) {
      result.excerpt = await boundText(
        result.excerpt,
        Math.max(0, (await this.count(result.excerpt)) - 32),
        this.count,
      );
    }
    this.used += await this.count(JSON.stringify(result));
    return result;
  }
}

export async function projectHistory(source, newLimiter) {
  let limiter = newLimiter();
  const result = [];
  for (const m of source) {
    if (m.role === "assistant") limiter = newLimiter();
    if (m.role !== "tool") {
      result.push(m);
      continue;
    }
    const projected = await limiter.cap(m.toolResults[0].content, m.id);
    result.push({
      ...m,
      toolResults: [
        { ...m.toolResults[0], content: JSON.stringify(projected) },
      ],
    });
  }
  return result;
}

export async function readToolResult(
  session,
  messageId,
  offset,
  budget,
  count,
) {
  validateSessionId(messageId);
  if (!Number.isInteger(offset) || offset < 0)
    throw new AppError("Ungültige Ergebnisposition.", 400, "INVALID_REQUEST", {
      messageKey: "learningContent:errors.resultOffset",
      params: {},
    });
  const source = session.messages.find(
    (m) => m.id === messageId && m.role === "tool",
  );
  if (!source)
    throw new AppError(
      "Werkzeugergebnis gehört nicht zu dieser Session oder wurde gelöscht.",
      404,
      "NOT_FOUND",
      { messageKey: "learningContent:errors.resultMissing", params: {} },
    );
  const raw = source.content || "";
  if (offset > raw.length)
    throw new AppError(
      "Die Position liegt hinter dem Ergebnis.",
      400,
      "INVALID_REQUEST",
      { messageKey: "learningContent:errors.resultEnd", params: {} },
    );
  const page = (length) => ({
    type: "read_tool_result",
    messageId,
    offset,
    content: raw.slice(offset, offset + length),
    nextOffset: offset + length < raw.length ? offset + length : null,
  });
  let low = 0,
    high = raw.length - offset,
    best = page(0);
  if ((await count(JSON.stringify(best))) > budget)
    throw new AppError(
      "Das Kontextfenster ist zu klein für eine Ergebnisreferenz.",
      400,
      "CONTEXT_TOO_LARGE",
      { messageKey: "learningContent:errors.resultReferenceSize", params: {} },
    );
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = page(middle);
    if ((await count(JSON.stringify(candidate))) <= budget) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (offset < raw.length && !best.content.length)
    throw new AppError(
      "Das Kontextfenster ist zu klein für den nächsten Ergebnisausschnitt.",
      400,
      "CONTEXT_TOO_LARGE",
      { messageKey: "learningContent:errors.resultExcerptSize", params: {} },
    );
  return best;
}
