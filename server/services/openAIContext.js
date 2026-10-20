import { Chat } from "@lmstudio/sdk";
import { createHash } from "node:crypto";
import { modelHistory } from "./context/history.js";
import { systemPrompt } from "./context/prompt.js";
import {
  ResultLimiter,
  projectHistory,
  readToolResult,
} from "./context/results.js";
import { CONTEXT_DEFAULTS } from "./context/settings.js";
import { estimateTokens } from "./context/core/estimate.js";
import { sourceHash } from "./context/sourceHash.js";

// OpenAI owns compaction and token limits. Only opaque provider state and the
// original transcript are persisted here; the LM Studio compressor is not used.
export class OpenAIContext {
  constructor({ connection, settings, signal, onEvent = () => {} }) {
    this.model = connection.model;
    this.settings = settings;
    this.signal = signal;
    this.emit = onEvent;
    this.counts = new Map();
    this.count = async (text) => {
      this.signal.throwIfAborted();
      const key = createHash("sha256").update(text).digest("hex");
      if (!this.counts.has(key)) {
        const count = await this.model.countTokens(text);
        if (this.counts.size >= 256) this.counts.clear();
        this.counts.set(key, count);
      }
      return this.counts.get(key);
    };
  }
  async initialize() {
    this.signal.throwIfAborted();
  }
  newLimiter() {
    return new ResultLimiter(
      this.count,
      this.settings.maxToolResultTokens ?? CONTEXT_DEFAULTS.maxToolResultTokens,
      this.settings.maxTotalToolResultTokens ??
        CONTEXT_DEFAULTS.maxTotalToolResultTokens,
    );
  }
  async readResult(session, messageId, offset = 0) {
    // Leave room for the immediate result limiter's recovery envelope.
    return readToolResult(
      session,
      messageId,
      offset,
      Math.max(
        200,
        (this.settings.maxToolResultTokens ??
          CONTEXT_DEFAULTS.maxToolResultTokens) - 128,
      ),
      this.count,
    );
  }
  async prepare(
    session,
    definitions,
    { force = false, profile = "", retry = false } = {},
  ) {
    this.signal.throwIfAborted();
    const history = new Map(
      modelHistory(session, {
        includeProfile: this.settings.crossChatProfileEnabled,
      }).map((m) => [m.id, m]),
    );
    const resultMessages = new Map();
    let input = [];
    const sourceHasher = createHash("sha256").update("[");
    let sourceCount = 0;
    for (const message of session.messages) {
      const state = message.providerState || message.event?.providerState;
      if (
        state?.model === this.model.identifier &&
        state.sourceHash === sourceHasher.copy().update("]").digest("hex") &&
        Array.isArray(state.output)
      ) {
        if (state.replace) input = [...state.output];
        else {
          // Server-side output can replace everything preceding its latest
          // compaction item. Standalone compact output must remain intact.
          const cut = state.output.findLastIndex(
            (item) => item.type === "compaction",
          );
          if (cut >= 0) input = state.output.slice(cut);
          else input.push(...state.output);
        }
      } else if (history.has(message.id)) {
        const canon = history.get(message.id);
        if (canon.text || (canon.role !== "tool" && !canon.toolCalls?.length))
          input.push({ role: canon.role, content: canon.text });
        if (canon.toolCalls?.length && !state)
          input.push(...(message.providerItems || []));
        for (const call of canon.toolCalls || [])
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: call.args || "{}",
          });
        for (const result of canon.toolResults || []) {
          const item = {
            type: "function_call_output",
            call_id: result.toolCallId,
            output: result.content,
          };
          resultMessages.set(item, message.id);
          input.push(item);
        }
      }
      if (history.has(message.id)) {
        if (sourceCount++) sourceHasher.update(",");
        sourceHasher.update(JSON.stringify(history.get(message.id)));
      }
    }
    // Project only original results that survived provider compaction. Native
    // compact windows are opaque and must never be reserialized or truncated.
    const retained = new Set(
      input.map((item) => resultMessages.get(item)).filter(Boolean),
    );
    const projected = new Map(
      (
        await projectHistory(
          [...history.values()].filter(
            (m) => m.role !== "tool" || retained.has(m.id),
          ),
          () => this.newLimiter(),
        )
      ).map((m) => [m.id, m]),
    );
    input = input.map((item) => {
      const id = resultMessages.get(item);
      return id
        ? { ...item, output: projected.get(id).toolResults[0].content }
        : item;
    });
    const root = {
      role: "developer",
      content: systemPrompt(this.settings, session, profile, retry),
    };
    // Always supply current workspace instructions, even after API compaction.
    input = [root, ...input.filter((item) => item.role !== "developer")];
    if (force) {
      const compacted = await this.model.compact(input);
      input = [
        root,
        ...compacted.output.filter((item) => item.role !== "developer"),
      ];
      this.emit("context-report", {
        type: "context_compaction",
        modelCall: true,
        usage: compacted.usage,
        responseId: compacted.responseId,
        providerState: {
          model: this.model.identifier,
          output: input,
          replace: true,
          sourceHash: sourceHash(session.messages, {
            includeProfile: this.settings.crossChatProfileEnabled,
          }),
        },
        provider: "openai",
      });
    }
    this.model.nativeInput = input;
    let promptTokens, error, errorKey, errorParams;
    try {
      promptTokens = await this.model.countInput(input, definitions);
    } catch (cause) {
      this.signal.throwIfAborted();
      error = cause.message;
      errorKey = cause.messageKey;
      errorParams = cause.params;
      promptTokens = estimateTokens(JSON.stringify(input));
    }
    this.usage = {
      provider: "openai",
      model: this.model.identifier,
      managedBy: "openai",
      promptTokens,
      transcriptTokens: estimateTokens(JSON.stringify([...history.values()])),
      contextLength: null,
      remainingTokens: null,
      reservedOutputTokens: 0,
      measurementQuality: error ? "estimated" : "exact",
      coveredMessages: 0,
      chunkCount: 0,
      lastMode: "openai",
      sampledAt: new Date().toISOString(),
      ...(error ? { error } : {}),
      ...(errorKey ? { errorKey, errorParams: errorParams || {} } : {}),
    };
    this.emit("context-usage", this.usage);
    return { chat: Chat.from([]), contextUsage: this.usage };
  }
}
