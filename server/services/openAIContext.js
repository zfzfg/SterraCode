import { Chat } from "@lmstudio/sdk";
import { createHash } from "node:crypto";
import { modelHistory } from "./context/history.js";
import { systemPrompt } from "./context/prompt.js";
import { readToolResult } from "./context/results.js";
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
  }
  async initialize() {
    this.signal.throwIfAborted();
  }
  newLimiter() {
    return { cap: async (content) => content };
  }
  async readResult(session, messageId, offset = 0) {
    return readToolResult(session, messageId, offset, Infinity, async () => 0);
  }
  async prepare(
    session,
    definitions,
    { force = false, profile = "", retry = false } = {},
  ) {
    this.signal.throwIfAborted();
    const history = new Map(modelHistory(session).map((m) => [m.id, m]));
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
        if (canon.toolCalls?.length)
          input.push(...(message.providerItems || []));
        for (const call of canon.toolCalls || [])
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: call.args || "{}",
          });
        for (const result of canon.toolResults || [])
          input.push({
            type: "function_call_output",
            call_id: result.toolCallId,
            output: result.content,
          });
      }
      if (history.has(message.id)) {
        if (sourceCount++) sourceHasher.update(",");
        sourceHasher.update(JSON.stringify(history.get(message.id)));
      }
    }
    const root = {
      role: "developer",
      content: systemPrompt(this.settings, session, profile, retry),
    };
    // Always supply current workspace instructions, even after API compaction.
    input = [root, ...input.filter((item) => item.role !== "developer")];
    if (force) {
      input = await this.model.compact(input);
      this.emit("context-report", {
        type: "context_compaction",
        providerState: {
          model: this.model.identifier,
          output: input,
          replace: true,
          sourceHash: sourceHash(session.messages),
        },
        provider: "openai",
      });
    }
    this.model.nativeInput = input;
    let promptTokens, error;
    try {
      promptTokens = await this.model.countInput(input, definitions);
    } catch (cause) {
      this.signal.throwIfAborted();
      error = cause.message;
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
    };
    this.emit("context-usage", this.usage);
    return { chat: Chat.from([]), contextUsage: this.usage };
  }
}
