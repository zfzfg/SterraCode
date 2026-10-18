// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
/**
 * Memoized token counting. Counting goes through the model's real tokenizer
 * (injected), but each distinct message is only counted once per process.
 */
import { canon, attachmentName } from "./view.js";
export const PER_MESSAGE_OVERHEAD = 4;
/**
 * Plain-text rendering of a message for token counting — canon() is a JSON
 * serialization (role/text/toolCalls/toolResults/files scaffolding plus
 * escaping) that the model never actually sees; counting it systematically
 * inflates estimates by ~20-30 tokens per message. This is what the model's
 * chat template roughly renders instead: one line per role/text, tool call,
 * tool result, and file, newline-joined. No truncation.
 */
export function renderForCount(m) {
  const lines = [`${m.role}: ${m.text}`];
  for (const c of m.toolCalls ?? []) {
    lines.push(`tool call: ${c.name}(${c.args})`);
  }
  for (const r of m.toolResults ?? []) {
    lines.push(`tool result: ${r.content}`);
  }
  for (const f of m.files ?? []) {
    lines.push(`file: ${attachmentName(f)}`);
  }
  return lines.join("\n");
}
export class TokenCounter {
  count;
  perMessageOverhead;
  memo = new Map();
  active = 0;
  waiting = [];
  async tokenize(text) {
    if (this.active >= 8)
      await new Promise((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      const tokens = await this.count(text);
      if (!Number.isFinite(tokens) || tokens < 0)
        throw new Error("Invalid tokenizer result");
      return tokens;
    } finally {
      const next = this.waiting.shift();
      if (next)
        next(); // transfer the slot rather than allowing a ninth request
      else this.active--;
    }
  }
  constructor(count, perMessageOverhead = PER_MESSAGE_OVERHEAD) {
    this.count = count;
    this.perMessageOverhead = perMessageOverhead;
  }
  async countMessage(m) {
    // canon() stays the memo key (stable, content-addressed identity) even
    // though what actually gets tokenized is the plain-text rendering.
    const key = canon(m);
    let pending = this.memo.get(key);
    if (!pending) {
      pending = this.tokenize(renderForCount(m));
      this.memo.set(key, pending);
      void pending.catch(() => {
        if (this.memo.get(key) === pending) this.memo.delete(key);
      });
      while (this.memo.size > 4096)
        this.memo.delete(this.memo.keys().next().value);
    } else {
      this.memo.delete(key);
      this.memo.set(key, pending);
    }
    return (await pending) + this.perMessageOverhead;
  }
  /** Per-message counts (incl. overhead), aligned with the input array. */
  async countMessages(msgs) {
    return Promise.all(msgs.map((m) => this.countMessage(m)));
  }
}
