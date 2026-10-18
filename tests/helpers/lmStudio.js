import { Chat, ChatMessage } from "@lmstudio/sdk";
import { randomUUID } from "node:crypto";

export function openAIMessages(chat) {
  return Chat.from(chat)
    .getMessagesArray()
    .map((m) => ({
      role: m.getRole(),
      content: m.getText(),
      ...(m.getToolCallRequests().length
        ? {
            tool_calls: m.getToolCallRequests().map((r) => ({
              id: r.id,
              type: "function",
              function: {
                name: r.name,
                arguments: JSON.stringify(r.arguments || {}),
              },
            })),
          }
        : {}),
      ...(m.getToolCallResults().length
        ? {
            tool_call_id: m.getToolCallResults()[0].toolCallId,
            content: m.getToolCallResults()[0].content,
          }
        : {}),
    }));
}

// A native SDK contract fixture. It deliberately tries to start another round
// after tools: tests only pass when production's one-round cap actually stops it.
export function fixtureModel({
  identifier = "test-model",
  contextLength = 32768,
  predict,
} = {}) {
  const model = {
    instanceReference: randomUUID(),
    identifier,
    path: `fixture/${identifier}`,
    trainedForToolUse: true,
    contextLength,
    calls: [],
    renders: [],
    async getModelInfo() {
      return {
        identifier: model.identifier,
        path: model.path,
        instanceReference: model.instanceReference || "fixture-instance",
        trainedForToolUse: model.trainedForToolUse,
      };
    },
    async getContextLength() {
      return model.contextLength;
    },
    async countTokens(text) {
      return Math.ceil(text.length / 4);
    },
    async applyPromptTemplate(chat, opts = {}) {
      const rendered = JSON.stringify({
        messages: openAIMessages(chat),
        tools: opts.toolDefinitions || [],
      });
      model.renders.push(rendered);
      return rendered;
    },
    async respond(chat, opts = {}) {
      return request(chat, opts, [], false);
    },
    async act(chat, tools, opts) {
      const history = Chat.from(chat);
      for (let round = 0; round < 5; round++) {
        opts.signal.throwIfAborted();
        opts.onRoundStart?.(round);
        const response = await request(history, opts, tools, true);
        opts.onPredictionCompleted?.(response);
        const calls = response.tool_calls || [];
        const native = calls.map((c, index) => ({
          id: c.id,
          type: "function",
          name: c.function.name,
          arguments: JSON.parse(c.function.arguments || "{}"),
          index,
        }));
        for (const r of native)
          opts.onToolCallRequestEnd?.(round, r.index, { toolCallRequest: r });
        const assistant = ChatMessage.from({
          role: "assistant",
          content: [
            { type: "text", text: response.content },
            ...native.map((r) => ({
              type: "toolCallRequest",
              toolCallRequest: {
                id: r.id,
                type: "function",
                name: r.name,
                arguments: r.arguments,
              },
            })),
          ],
        });
        history.append(assistant);
        opts.onMessage?.(assistant);
        for (const r of native) {
          opts.signal.throwIfAborted();
          const tool = tools.find((t) => t.name === r.name);
          let value;
          if (!tool)
            value = await opts.handleInvalidToolRequest(
              new Error("Unknown tool"),
              r,
            );
          else {
            opts.onToolCallRequestFinalized?.(round, r.index, {
              toolCallRequest: r,
            });
            value = await tool.implementation(r.arguments, {
              callId: r.index,
              signal: opts.signal,
              status: () => {},
              warn: () => {},
            });
          }
          const result = ChatMessage.from({
            role: "tool",
            content: [
              {
                type: "toolCallResult",
                toolCallId: r.id,
                content: JSON.stringify(value),
              },
            ],
          });
          history.append(result);
          opts.onMessage?.(result);
        }
        opts.onRoundEnd?.(round);
        opts.signal.throwIfAborted();
        if (!calls.length) return;
      }
      throw new Error("Test fixture escaped the production round cap");
    },
  };
  async function request(chat, opts, tools, stream) {
    const definitions = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parametersJsonSchema,
      },
    }));
    const body = {
      model: model.identifier,
      messages: openAIMessages(chat),
      tools: definitions,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      stream,
    };
    model.calls.push(body);
    const response = await (predict
      ? predict(body, opts)
      : { content: "Antwort." });
    const result = {
      content: response.content || "",
      nonReasoningContent: response.content || "",
      reasoningContent: response.reasoning_content || "",
      stats: { stopReason: response.stopReason || "eosFound" },
      tool_calls: response.tool_calls,
    };
    if (!response.fragmentsEmitted && result.content)
      opts.onPredictionFragment?.({
        content: result.content,
        reasoningType: "none",
        tokensCount: Math.ceil(result.content.length / 4),
      });
    return result;
  }
  return model;
}

export function httpFixtureFactory({ probe = false } = {}) {
  return (options, settings) => {
    const base = options.baseUrl.replace(/^ws/, "http");
    const model = fixtureModel({
      identifier: settings.activeModel || "Lokaler Test-Tutor",
      predict: async (body, opts) => {
        const response = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!body.stream) return (await response.json()).choices[0].message;
        const reader = response.body.getReader(),
          decoder = new TextDecoder(),
          calls = new Map();
        let buffer = "",
          content = "",
          finished = false;
        const consume = (frame) => {
          const data = frame
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          if (!data) return;
          if (data === "[DONE]") {
            finished = true;
            return;
          }
          const value = JSON.parse(data),
            choice = value.choices?.[0],
            delta = choice?.delta || {};
          if (choice?.finish_reason) finished = true;
          if (delta.content) {
            content += delta.content;
            opts.onPredictionFragment?.({
              content: delta.content,
              reasoningType: "none",
              tokensCount: 1,
            });
          }
          for (const c of delta.tool_calls || []) {
            const call = calls.get(c.index) || {
              id: "",
              type: "function",
              function: { name: "", arguments: "" },
            };
            if (c.id) call.id += c.id;
            if (c.function?.name) call.function.name += c.function.name;
            if (c.function?.arguments)
              call.function.arguments += c.function.arguments;
            calls.set(c.index, call);
          }
        };
        try {
          while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value || new Uint8Array(), {
              stream: !done,
            });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() || "";
            frames.forEach(consume);
            if (done) {
              if (buffer.trim()) consume(buffer);
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (!finished)
          throw new Error("Verbindung vor Abschluss unterbrochen.");
        return {
          content,
          tool_calls: [...calls.values()],
          fragmentsEmitted: true,
        };
      },
    });
    return {
      llm: {
        listLoaded: async () => {
          if (probe) {
            const response = await fetch(`${base}/v1/models`, {
              signal: AbortSignal.timeout(2000),
            });
            if (!response.ok) throw new Error("Offline");
          }
          return [model];
        },
      },
    };
  };
}
