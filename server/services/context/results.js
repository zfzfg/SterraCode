import { AppError, validateSessionId } from "../storage.js";
import { boundText } from "./core/internalPrediction.js";

const retainedKeys = [
  "type",
  "status",
  "path",
  "version",
  "changeId",
  "undone",
  "processId",
  "exited",
  "exitCode",
  "questionId",
  "code",
  "messageId",
  "offset",
  "nextOffset",
];

export class ResultLimiter {
  constructor(count, perResult, total) {
    this.count = count;
    this.perResult = perResult;
    this.total = total;
    this.used = 0;
  }
  async cap(content, messageId) {
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

export async function readToolResult(
  session,
  messageId,
  offset,
  budget,
  count,
) {
  validateSessionId(messageId);
  if (!Number.isInteger(offset) || offset < 0)
    throw new AppError("Ungültige Ergebnisposition.");
  const source = session.messages.find(
    (m) => m.id === messageId && m.role === "tool",
  );
  if (!source)
    throw new AppError(
      "Werkzeugergebnis gehört nicht zu dieser Session oder wurde gelöscht.",
      404,
      "NOT_FOUND",
    );
  const raw = source.content || "";
  if (offset > raw.length)
    throw new AppError("Die Position liegt hinter dem Ergebnis.");
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
    );
  return best;
}
