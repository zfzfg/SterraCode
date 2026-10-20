// Provider usage is distinct from a measurement of the next prompt's size.
const value = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);
export function openAIUsage(response) {
  if (!response.usage) return undefined;
  const u = response.usage;
  return {
    inputTokens: value(u.input_tokens),
    outputTokens: value(u.output_tokens),
    reasoningTokens: value(u.output_tokens_details?.reasoning_tokens),
    cacheReadTokens: value(u.input_tokens_details?.cached_tokens),
    cacheWriteTokens: value(u.input_tokens_details?.cache_write_tokens),
  };
}
export function lmStudioUsage(stats) {
  if (
    !stats ||
    (stats.promptTokensCount === undefined &&
      stats.predictedTokensCount === undefined)
  )
    return undefined;
  return {
    inputTokens: value(stats.promptTokensCount),
    outputTokens: value(stats.predictedTokensCount),
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  };
}
export function turnUsage(messages, turnId) {
  const calls = [],
    seen = new Set();
  for (const m of messages) {
    const record = m.role === "event" && m.event?.modelCall ? m.event : m;
    if (
      m.turnId !== turnId ||
      (m.role !== "assistant" && !m.event?.modelCall) ||
      !(record.modelCall || record.usage || record.responseId)
    )
      continue;
    const key = record.responseId || m.id;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push(record.usage);
  }
  if (!calls.some(Boolean)) return undefined;
  const sum = (key) =>
    calls.every((u) => Number.isFinite(u?.[key]))
      ? calls.reduce((n, u) => n + u[key], 0)
      : null;
  const paired = calls.filter(
    (u) =>
      Number.isFinite(u?.cacheReadTokens) && Number.isFinite(u?.inputTokens),
  );
  const cacheInputTokens = paired.reduce((n, u) => n + u.inputTokens, 0);
  const inputTokens = sum("inputTokens"),
    outputTokens = sum("outputTokens");
  return {
    calls: calls.length,
    measuredCalls: calls.filter(Boolean).length,
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null,
    reasoningTokens: sum("reasoningTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheWriteTokens: sum("cacheWriteTokens"),
    cacheMeasuredCalls: paired.length,
    cacheInputTokens,
    cacheReadRatio: cacheInputTokens
      ? paired.reduce((n, u) => n + u.cacheReadTokens, 0) / cacheInputTokens
      : null,
  };
}
