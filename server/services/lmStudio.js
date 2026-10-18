export async function callLMStudio({
  messages,
  tools = [],
  model,
  lmStudioUrl,
  stream = false,
  temperature = 0.4,
  maxTokens,
  maxTokensResponse = 2048,
  signal,
}) {
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens || maxTokensResponse,
    stream,
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const response = await fetch(`${lmStudioUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
      : AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw new Error(
      `LM Studio (${response.status}): ${(await response.text()).slice(0, 1000)}`,
    );
  return stream ? response : response.json();
}
export async function completionStream(options) {
  const response = await callLMStudio({ ...options, stream: true });
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  const result = { role: "assistant", content: "", tool_calls: [] };
  const calls = new Map();
  let buffer = "",
    done = false;
  function consume(frame) {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      done = true;
      return;
    }
    const value = JSON.parse(data);
    if (value.error) throw new Error(value.error.message || "LM-Studio-Fehler");
    const choice = value.choices?.[0];
    if (choice?.finish_reason) done = true;
    const delta = choice?.delta || {};
    if (delta.content) {
      result.content += delta.content;
      options.onToken?.(delta.content);
    }
    if (delta.reasoning_content) options.onReasoning?.(delta.reasoning_content);
    for (const part of delta.tool_calls || []) {
      const call = calls.get(part.index) || {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      if (part.id) call.id += part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments)
        call.function.arguments += part.function.arguments;
      if (call.function.arguments.length > 2 * 1024 * 1024)
        throw new Error("Tool-Aufruf ist zu groß.");
      calls.set(part.index, call);
    }
  }
  try {
    while (true) {
      const { value, done: ended } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !ended });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || "";
      for (const frame of frames) consume(frame);
      if (ended) {
        if (buffer.trim()) consume(buffer);
        break;
      }
    }
    if (!done)
      throw new Error(
        "Verbindung zum Modell vor Abschluss der Antwort unterbrochen.",
      );
    result.tool_calls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => c);
    if (result.tool_calls.some((c) => !c.id || !c.function.name))
      throw new Error("Unvollständiger Tool-Aufruf.");
    return result;
  } finally {
    reader.releaseLock();
  }
}
