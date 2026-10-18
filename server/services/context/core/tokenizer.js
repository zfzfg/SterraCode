// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
/** Shared gate for SDK tokenizer RPCs, including internal summaries and parallel chats. */
let active = 0;
const waiting = [];
export async function countModelTokens(model, text) {
  if (active >= 8) await new Promise((resolve) => waiting.push(resolve));
  else active++;
  try {
    const count = await model.countTokens(text);
    if (!Number.isFinite(count) || count < 0)
      throw new Error("Invalid tokenizer result");
    return count;
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
