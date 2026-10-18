// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
import { countModelTokens } from "./tokenizer.js";
import { Chat, ChatMessage } from "@lmstudio/sdk";
import { INTERNAL_SOURCE_BOUNDARY } from "./internalPrompt.js";
export const LOSS_MARKER = "[context-compressor: older detail omitted]";
/** Exact tokenizer bound, including the omission marker; no flat chars/token assumption. */
export async function boundText(text, maxTokens, count) {
  if (maxTokens <= 0) return "";
  if ((await count(text)) <= maxTokens) return text;
  if ((await count(LOSS_MARKER)) > maxTokens) return "";
  let low = 0,
    high = text.length;
  const candidate = (length) => {
    const head = Math.floor(length * 0.3),
      tail = length - head;
    return (
      text.slice(0, head) +
      "\n" +
      LOSS_MARKER +
      "\n" +
      (tail > 0 ? text.slice(-tail) : "")
    );
  };
  let best = LOSS_MARKER;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = candidate(middle);
    if ((await count(value)) <= maxTokens) {
      best = value;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}
/** Internal predictions have no tools. Keep the compressor instruction intact and trim only source data. */
export async function prepareInternalPrediction(model, input, requestedTokens) {
  if (!Number.isFinite(requestedTokens) || requestedTokens < 1)
    throw new Error("Internal generation budget must be positive");
  requestedTokens = Math.floor(requestedTokens);
  const context = await model.getContextLength();
  if (!Number.isFinite(context) || context <= 0)
    throw new Error(
      "Cannot safely budget an internal prediction: context length unknown",
    );
  const reserve = Math.max(
    1,
    Math.min(requestedTokens, Math.floor(context / 3)),
  );
  const messages = input.getMessagesArray().map((m) => ChatMessage.from(m));
  const buildChat = () => {
    const chat = Chat.empty();
    messages.forEach((m) => chat.append(m));
    return chat;
  };
  let user = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].getRole() === "user") {
      user = i;
      break;
    }
  const render = async () => {
    const count = await countModelTokens(
      model,
      await model.applyPromptTemplate(buildChat()),
    );
    if (!Number.isFinite(count) || count < 0)
      throw new Error("Invalid tokenizer result for internal prompt");
    return count;
  };
  let tokens = await render();
  if (tokens + reserve > context && user >= 0) {
    const original = messages[user].getText();
    const boundary = original.indexOf(INTERNAL_SOURCE_BOUNDARY);
    const prefix =
      boundary < 0
        ? ""
        : original.slice(0, boundary + INTERNAL_SOURCE_BOUNDARY.length);
    const text = original.slice(prefix.length);
    let low = 0,
      high = text.length;
    let best;
    while (low <= high) {
      const length = Math.floor((low + high) / 2);
      const head = Math.floor(length * 0.3),
        tail = length - head;
      messages[user].replaceText(
        prefix +
          text.slice(0, head) +
          "\n" +
          LOSS_MARKER +
          "\n" +
          (tail ? text.slice(-tail) : ""),
      );
      if ((await render()) + reserve <= context) {
        best = messages[user].getText();
        low = length + 1;
      } else high = length - 1;
    }
    if (best === undefined)
      throw new Error(
        "Internal prediction cannot fit its instruction and output reserve",
      );
    messages[user].replaceText(best);
    tokens = await render();
  }
  if (tokens + reserve > context)
    throw new Error("Internal prediction exceeds the safe context budget");
  return {
    chat: buildChat(),
    maxTokens: Math.min(requestedTokens, context - tokens),
  };
}
export async function predictInternal(model, input, opts, ctl) {
  if (ctl.abortSignal.aborted)
    throw ctl.abortSignal.reason ?? new Error("Aborted");
  const fitted = await prepareInternalPrediction(
    model,
    input,
    Number(opts.maxTokens ?? 1500),
  );
  if (ctl.abortSignal.aborted)
    throw ctl.abortSignal.reason ?? new Error("Aborted");
  // A short-lived child signal avoids accumulating SDK listeners on the whole turn.
  const controller = new AbortController();
  const mirror = () => controller.abort(ctl.abortSignal.reason);
  ctl.abortSignal.addEventListener("abort", mirror, { once: true });
  try {
    return await model.respond(fitted.chat, {
      ...opts,
      maxTokens: fitted.maxTokens,
      signal: controller.signal,
    });
  } finally {
    ctl.abortSignal.removeEventListener("abort", mirror);
  }
}
