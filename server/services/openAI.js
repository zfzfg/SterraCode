import { Chat } from "@lmstudio/sdk";
import { randomUUID } from "node:crypto";
import { AppError } from "./storage.js";
import { getOpenAIKey } from "./providerCredentials.js";

// Transport injection is exclusively a module test seam. Neither settings nor
// request bodies can change this origin or send a credential to another host.
let transport = (...args) => fetch(...args);
export function setOpenAITransportForTests(value) {
  transport = value || ((...args) => fetch(...args));
}
const fail = (message, code = "OPENAI_UNAVAILABLE", status = 503) =>
  new AppError(message, status, code);
async function safeJSON(response) {
  try {
    return await response.json();
  } catch {
    throw fail(
      "OpenAI hat keine gültige JSON-Antwort geliefert.",
      "OPENAI_INVALID_RESPONSE",
      502,
    );
  }
}
async function request(endpoint, { body, signal, timeout = 20000 } = {}) {
  signal?.throwIfAborted();
  const key = await getOpenAIKey();
  let response;
  try {
    response = await transport(`https://api.openai.com/v1${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([
        signal || new AbortController().signal,
        AbortSignal.timeout(timeout),
      ]),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw fail(
      "Die OpenAI-API ist nicht erreichbar oder hat das Zeitlimit überschritten.",
    );
  }
  if (!response.ok) {
    // The remote body can include request text or credentials. Return only
    // known categories and never persist or log that body.
    let code;
    try {
      code = (await response.json()).error?.code;
    } catch {}
    if (code === "context_length_exceeded")
      throw fail(
        "OpenAI hat die Kontextgrenze des Modells gemeldet. Den Kontext über /compact verdichten oder ein anderes Modell auswählen.",
        "CONTEXT_UNVERIFIED",
      );
    if ([401, 403].includes(response.status))
      throw fail(
        "OpenAI-Zugang abgewiesen. API-Schlüssel und Modellberechtigung prüfen.",
        "OPENAI_AUTH_FAILED",
        502,
      );
    if (response.status === 429)
      throw fail(
        "OpenAI-Anfrage begrenzt. API-Kontingent und Ratenlimit prüfen.",
        "OPENAI_RATE_LIMITED",
        429,
      );
    throw fail(
      "OpenAI hat die Anfrage abgewiesen. Modell-ID, Responses-Unterstützung und Einstellungen prüfen.",
      "OPENAI_REQUEST_FAILED",
      502,
    );
  }
  return response;
}
async function countPayload(payload, signal) {
  const value = await safeJSON(
    await request("/responses/input_tokens", { body: payload, signal }),
  );
  if (!Number.isInteger(value.input_tokens) || value.input_tokens < 0)
    throw fail(
      "OpenAI liefert keine gültige Tokenzählung.",
      "CONTEXT_UNVERIFIED",
    );
  return value.input_tokens;
}
export async function listOpenAIModels(signal) {
  const response = await safeJSON(await request("/models", { signal }));
  if (!Array.isArray(response.data))
    throw fail("OpenAI liefert keine gültige Modellliste.");
  return response.data
    .filter((model) => typeof model.id === "string")
    .map((model) => ({ identifier: model.id, displayName: model.id }))
    .sort((a, b) => a.identifier.localeCompare(b.identifier));
}
const toolsFor = (definitions = []) =>
  definitions.map((definition) => ({
    type: "function",
    name: definition.function.name,
    description: definition.function.description,
    parameters: definition.function.parameters,
    strict: false,
  }));
export function inputFor(chat, reasoning = new Map()) {
  const input = [],
    included = new Set();
  for (const message of Chat.from(chat).getMessagesArray()) {
    const role = message.getRole(),
      text = message.getText(),
      calls = message.getToolCallRequests();
    if (text || (role !== "tool" && !calls.length))
      input.push({
        role: role === "system" ? "developer" : role,
        content: text,
      });
    for (const call of calls) {
      for (const item of reasoning.get(call.id) || []) {
        if (!included.has(item.id)) {
          input.push(item);
          included.add(item.id);
        }
      }
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments || {}),
      });
    }
    for (const result of message.getToolCallResults())
      input.push({
        type: "function_call_output",
        call_id: result.toolCallId,
        output: result.content,
      });
  }
  return input;
}

async function responsePayload(body, signal, onToken, onReasoning) {
  const response = await request("/responses", {
    body: {
      ...body,
      store: false,
      include: ["reasoning.encrypted_content"],
      stream: Boolean(onToken || onReasoning),
    },
    signal,
    timeout: 120000,
  });
  if (!onToken && !onReasoning) {
    const result = await safeJSON(response);
    if (result.status === "failed" || result.error)
      throw fail(
        "OpenAI hat die Antwort abgebrochen.",
        "OPENAI_RESPONSE_FAILED",
        502,
      );
    return result;
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    completed;
  function consume(frame) {
    const text = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!text || text === "[DONE]") return;
    const event = JSON.parse(text);
    if (event.type === "response.output_text.delta")
      onToken?.(event.delta || "");
    if (event.type === "response.reasoning_summary_text.delta")
      onReasoning?.(event.delta || "");
    if (["response.completed", "response.incomplete"].includes(event.type))
      completed = event.response;
    if (["response.failed", "error"].includes(event.type))
      throw fail(
        "OpenAI hat die Antwort vorzeitig abgebrochen.",
        "OPENAI_RESPONSE_FAILED",
        502,
      );
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      if (buffer.length > 16 * 1024 * 1024)
        throw fail(
          "OpenAI-Stream überschreitet das Ausgabelimit.",
          "OUTPUT_LIMIT",
          502,
        );
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || "";
      frames.forEach(consume);
      if (done) {
        if (buffer.trim()) consume(buffer);
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!completed)
    throw fail(
      "OpenAI-Verbindung vor Abschluss unterbrochen. Die sichtbare Teilantwort bleibt erhalten.",
      "OPENAI_STREAM_INTERRUPTED",
      502,
    );
  return completed;
}
const visibleText = (response) =>
  (response.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .map((part) =>
      part.type === "output_text"
        ? part.text
        : part.type === "refusal"
          ? part.refusal
          : "",
    )
    .join("");
const outputReasoning = (response) =>
  (response.output || [])
    .filter((item) => item.type === "reasoning" && item.encrypted_content)
    .map(({ id, type, summary, encrypted_content }) => ({
      id,
      type,
      summary: summary || [],
      encrypted_content,
    }));
export async function connectOpenAIModel(settings, signal) {
  await getOpenAIKey();
  signal?.throwIfAborted();
  const identifier = settings.openAIModel;
  if (!identifier)
    throw new AppError(
      "Bitte eine OpenAI-Modell-ID in den Einstellungen auswählen.",
      400,
      "NO_MODEL",
    );
  const info = {
    identifier,
    path: `openai/${identifier}`,
    instanceReference: `openai:${identifier}`,
    trainedForToolUse: true,
  };
  const prefix = `\0sterracode-openai:${randomUUID()}:`;
  const reasoning = new Map();
  const model = {
    provider: "openai",
    identifier,
    trainedForToolUse: true,
    getModelInfo: async () => info,
    getContextLength: async () => null,
    nativeInput: null,
    countInput: (input, definitions = []) =>
      countPayload(
        { model: identifier, input, tools: toolsFor(definitions) },
        signal,
      ),
    async compact(input) {
      const result = await safeJSON(
        await request("/responses/compact", {
          body: { model: identifier, input },
          signal,
          timeout: 120000,
        }),
      );
      if (
        !Array.isArray(result.output) ||
        !result.output.some(
          (item) => item.type === "compaction" && item.encrypted_content,
        )
      )
        throw fail(
          "OpenAI liefert keinen gültigen komprimierten Kontext.",
          "OPENAI_INVALID_RESPONSE",
          502,
        );
      return result.output;
    },
    setProviderHistory(messages) {
      reasoning.clear();
      for (const message of messages)
        if (message.providerItems?.length)
          for (const call of message.tool_calls || [])
            reasoning.set(call.id, message.providerItems);
    },
    input: (chat) => model.nativeInput ?? inputFor(chat, reasoning),
    applyPromptTemplate: async (chat, options = {}) =>
      prefix +
      JSON.stringify({
        model: identifier,
        input: inputFor(chat, reasoning),
        tools: toolsFor(options.toolDefinitions),
      }),
    countTokens: async (text) =>
      countPayload(
        text.startsWith(prefix)
          ? JSON.parse(text.slice(prefix.length))
          : { model: identifier, input: text },
        signal,
      ),
    async respond(chat, options = {}) {
      const response = await responsePayload(
        {
          model: identifier,
          input: inputFor(chat, reasoning),
          tools: [],
        },
        options.signal || signal,
      );
      options.onPredictionFragment?.({
        content: visibleText(response),
        reasoningType: "none",
        tokensCount: response.usage?.output_tokens || 1,
      });
      return {
        content: visibleText(response),
        nonReasoningContent: visibleText(response),
        stats: {
          stopReason:
            response.status === "incomplete"
              ? "maxPredictedTokensReached"
              : "eosFound",
        },
      };
    },
  };
  return {
    model,
    info,
    identity: JSON.stringify([
      info.identifier,
      info.path,
      info.instanceReference,
    ]),
  };
}

export async function testOpenAIConnection(settings, signal) {
  try {
    const models = await listOpenAIModels(signal);
    if (!settings.openAIModel)
      return {
        connected: true,
        provider: "openai",
        status: "no-model",
        models: models.map((model) => ({
          id: model.identifier,
          name: model.displayName,
        })),
      };
    const tokenCount = await countPayload(
      { model: settings.openAIModel, input: "SterraCode Verbindungstest" },
      signal,
    );
    return {
      connected: true,
      provider: "openai",
      status: "ready",
      tokenization: true,
      tokenCount,
      models: models.map((model) => ({
        id: model.identifier,
        name: model.displayName,
      })),
    };
  } catch (error) {
    return {
      connected: false,
      provider: "openai",
      status: "offline",
      code: error.code || "OPENAI_UNAVAILABLE",
      error:
        error instanceof AppError
          ? error.message
          : "OpenAI hat keine gültige Antwort geliefert.",
    };
  }
}

export async function runOpenAIModelPass({
  model,
  chat,
  definitions,
  maxTokens,
  signal,
  onToken,
  onReasoning,
  onAssistant,
  onExecute,
  onInvalid,
  capResult,
  allocateCallId,
}) {
  let visibleChars = 0,
    executedTools = 0;
  try {
    const response = await responsePayload(
      {
        model: model.identifier,
        input: model.input(chat),
        tools: toolsFor(definitions),
        context_management: [{ type: "compaction" }],
        parallel_tool_calls: false,
        truncation: "disabled",
      },
      signal,
      (text) => {
        visibleChars += text.length;
        onToken?.(text);
      },
      onReasoning,
    );
    if (
      !["completed", "incomplete"].includes(response.status) ||
      !Array.isArray(response.output)
    )
      throw fail(
        "OpenAI hat keine abgeschlossene gültige Antwort geliefert.",
        "OPENAI_INVALID_RESPONSE",
        502,
      );
    const raw = (
      response.status === "incomplete" ? [] : response.output || []
    ).filter((item) => item.type === "function_call");
    const invalid = new Set();
    const callIds = new Set();
    const calls = raw.map((item) => {
      const id = item.call_id || allocateCallId?.() || randomUUID();
      if (
        typeof id !== "string" ||
        callIds.has(id) ||
        typeof item.name !== "string" ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(item.name)
      )
        throw fail(
          "OpenAI hat einen ungültigen Werkzeugaufruf geliefert.",
          "OPENAI_INVALID_RESPONSE",
          502,
        );
      callIds.add(id);
      let args;
      try {
        args = JSON.parse(item.arguments || "{}");
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new Error();
      } catch {
        args = {};
        invalid.add(id);
      }
      return {
        id,
        type: "function",
        function: { name: item.name, arguments: JSON.stringify(args) },
      };
    });
    await onAssistant({
      content: visibleText(response),
      tool_calls: calls,
      thinking: "",
      providerItems: outputReasoning(response),
      providerState: {
        model: model.identifier,
        output: response.output.flatMap((item) => {
          if (item.type !== "function_call") return [item];
          const call = calls.find((call) => call.id === item.call_id);
          return call ? [{ ...item, arguments: call.function.arguments }] : [];
        }),
      },
    });
    for (const call of calls) {
      signal.throwIfAborted();
      let args;
      try {
        if (invalid.has(call.id)) throw new Error();
        args = JSON.parse(call.function.arguments);
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new Error();
      } catch {
        await onInvalid?.(
          {
            type: "tool_error",
            tool: call.function.name,
            code: "INVALID_TOOL_REQUEST",
            error: "OpenAI hat ungültige Werkzeugargumente geliefert.",
          },
          call,
        );
        continue;
      }
      if (
        !definitions.some(
          (definition) => definition.function.name === call.function.name,
        )
      ) {
        await onInvalid?.(
          {
            type: "tool_error",
            tool: call.function.name,
            code: "INVALID_TOOL_REQUEST",
            error: "Unbekanntes Werkzeug.",
          },
          call,
        );
        continue;
      }
      executedTools++;
      const saved = await onExecute(call, args, signal);
      await capResult(saved.content, saved.id);
    }
    return {
      capped: calls.length ? "rounds" : undefined,
      hadTools: Boolean(calls.length),
      invalidUnparsed: false,
      empty: !calls.length && !visibleText(response).trim(),
      stopReason:
        response.status === "incomplete"
          ? "maxPredictedTokensReached"
          : "eosFound",
    };
  } catch (error) {
    if (!(error instanceof AppError) && !signal.aborted)
      error = fail(
        "OpenAI hat keine gültige vollständige Antwort geliefert.",
        "OPENAI_INVALID_RESPONSE",
        502,
      );
    error.passStats = { visibleChars, executedTools };
    throw error;
  }
}
