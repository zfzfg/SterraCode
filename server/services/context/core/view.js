// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
/**
 * Pure logic for turning a chat history into a compressed "view":
 * canonical serialization (stable across turns, used for hashing and token
 * counting), rolling prefix hashes (content-addressed cache keys), round
 * boundaries (where history may be cut without orphaning tool results), and
 * chunk planning.
 */
import { createHash } from "crypto";
export const attachmentName = (file) =>
  typeof file === "string" ? file : file.name;
export const attachmentId = (file) =>
  typeof file === "string" ? file : file.identifier;
/** Prefix marking this plugin's own replies (e.g. /compress stats). */
export const SENTINEL = "[context-compressor]";
export function canon(m) {
  return JSON.stringify({
    id: m.id,
    role: m.role,
    text: m.text,
    toolCalls: (m.toolCalls ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      args: c.args,
    })),
    toolResults: (m.toolResults ?? []).map((r) => ({
      toolCallId: r.toolCallId,
      content: r.content,
    })),
    files: m.files ?? [],
  });
}
/**
 * h[i] = hash chain covering msgs[0..i]. Same prefix => same hash. The seed
 * namespaces the chain: summaries produced under a different model, prompt
 * version, or settings must never be reused for one another.
 */
export function prefixHashes(msgs, seed = "") {
  const hashes = [];
  let prev = seed;
  for (const m of msgs) {
    prev = createHash("sha256")
      .update(prev)
      .update("\x00")
      .update(canon(m))
      .digest("hex");
    hashes.push(prev);
  }
  return hashes;
}
/** Stable namespace seed derived from compaction-relevant settings. */
export function hashNamespace(parts) {
  const stable = JSON.stringify(
    Object.keys(parts)
      .sort()
      .map((key) => [key, parts[key]]),
  );
  return createHash("sha256").update(stable).digest("hex");
}
/**
 * Valid cut indices c (meaning: summarize msgs[0..c), keep msgs[c..]).
 * A cut is valid before any non-tool message: cutting before a tool-result
 * message would orphan it from the assistant message that requested the
 * call. Agentic histories may contain a single user message followed by a
 * long assistant/tool loop, so user-only boundaries would be far too coarse.
 */
export function roundBoundaries(msgs) {
  const boundaries = [];
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].role !== "tool") boundaries.push(i);
  }
  return boundaries;
}
/**
 * Largest valid cut that still keeps at least keepRecentTokens verbatim in
 * the tail. Returns 0 when no cut is allowed.
 */
export function maxAllowedCut(boundaries, tokens, keepRecentTokens) {
  const suffix = new Array(tokens.length + 1).fill(0);
  for (let i = tokens.length - 1; i >= 0; i--) {
    suffix[i] = suffix[i + 1] + tokens[i];
  }
  let best = 0;
  for (const b of boundaries) {
    if (suffix[b] >= keepRecentTokens && b > best) best = b;
  }
  return best;
}
/**
 * Group rounds into summarization chunks of at most chunkTokens each
 * (a single round may exceed chunkTokens; it then forms its own chunk).
 * Returns ascending cut indices, each the end of one chunk, from `from`
 * (exclusive) up to `maxCut` (inclusive, if reachable).
 */
export function chunkEnds(boundaries, tokens, from, chunkTokens, maxCut) {
  const cuts = [];
  const candidates = boundaries.filter((b) => b > from && b <= maxCut);
  let chunkStart = from;
  let chunkSize = 0;
  const roundTokens = (start, end) => {
    let sum = 0;
    for (let i = start; i < end; i++) sum += tokens[i];
    return sum;
  };
  let prev = from;
  for (const b of candidates) {
    const size = roundTokens(prev, b);
    if (chunkSize > 0 && chunkSize + size > chunkTokens) {
      cuts.push(prev);
      chunkStart = prev;
      chunkSize = 0;
    }
    chunkSize += size;
    if (chunkSize >= chunkTokens) {
      cuts.push(b);
      chunkStart = b;
      chunkSize = 0;
    }
    prev = b;
  }
  if (chunkSize > 0 && prev > chunkStart) cuts.push(prev);
  return cuts;
}
/**
 * Index of the first message of the current turn — the last user message —
 * or 0 when there is none. Compaction never cuts past it: the instruction
 * being worked on right now is never replaced by a summary of itself.
 */
export function currentTurnStart(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user" && !msgs[i].contextSnapshot) return i;
  }
  return 0;
}
/**
 * Cuts for the safety pass, which runs when the rendered prompt plus the tool
 * definitions would not fit the window. First the normal rule (keep
 * keepRecentTokens verbatim, and never the current turn); when that yields
 * nothing, the verbatim tail is a preference the window overrides, so the
 * cut may go as deep as the start of the current turn — but never into it.
 */
export function fitCuts(
  boundaries,
  tokens,
  from,
  chunkTokens,
  keepRecentTokens,
  turnStart,
) {
  const normalMax = Math.min(
    maxAllowedCut(boundaries, tokens, keepRecentTokens),
    turnStart,
  );
  const normal = chunkEnds(boundaries, tokens, from, chunkTokens, normalMax);
  if (normal.length > 0) return { cuts: normal, relaxed: false };
  const deepest = Math.min(maxAllowedCut(boundaries, tokens, 0), turnStart);
  if (deepest <= from) return { cuts: [], relaxed: true };
  return {
    cuts: chunkEnds(boundaries, tokens, from, chunkTokens, deepest),
    relaxed: true,
  };
}
/**
 * Transform one message for the model's view: drop this plugin's own
 * replies (SENTINEL) and pure command messages entirely; for messages that
 * mix a command with real content, strip only the command line so the
 * user's actual instruction survives. Returns null to drop the message.
 */
export function transformForView(m) {
  if (m.role === "assistant" && m.text.startsWith(SENTINEL)) return null;
  // Canceled/dead replies leave behind empty assistant messages — pure
  // noise that pollutes the history and the hash chain.
  if (
    m.role === "assistant" &&
    m.text.trim() === "" &&
    (m.toolCalls ?? []).length === 0 &&
    (m.toolResults ?? []).length === 0 &&
    (m.files ?? []).length === 0
  ) {
    return null;
  }
  if (!isCompressCommand(m) && !isUsageCommand(m)) return m;
  const allCommands = [...COMPRESS_COMMANDS, ...USAGE_COMMANDS];
  const stripped = m.text
    .split(/\r?\n/)
    .filter((line) => !allCommands.includes(line.trim().toLowerCase()))
    .join("\n");
  if (stripped.trim() === "") return null;
  return { ...m, text: stripped };
}
/**
 * Drop this plugin's own exchanges from the model's view; messages mixing a
 * command with real content keep the content (command line removed).
 */
export function filterCompressorExchanges(msgs) {
  const out = [];
  for (const m of msgs) {
    const transformed = transformForView(m);
    if (transformed !== null) out.push(transformed);
  }
  return out;
}
/** Commands that force compaction. */
export const COMPRESS_COMMANDS = ["/compress", "/compact"];
/** Commands that report context/token usage. */
export const USAGE_COMMANDS = ["/usage"];
/**
 * Other plugins' prompt preprocessors may inject context around what the
 * user typed, so a command counts when it stands alone on any line of a
 * user message.
 */
function matchesCommand(m, commands) {
  if (m.role !== "user") return false;
  return m.text
    .split(/\r?\n/)
    .some((line) => commands.includes(line.trim().toLowerCase()));
}
/** True when the message is a compress command. */
export function isCompressCommand(m) {
  return matchesCommand(m, COMPRESS_COMMANDS);
}
/** True when the message is the /usage command. */
export function isUsageCommand(m) {
  return matchesCommand(m, USAGE_COMMANDS);
}
/**
 * Chat templates (qwen's tool template among them) refuse to render a
 * conversation with zero user messages ("No user query found in messages").
 * Compaction can produce exactly that in tool-heavy chats, so the view must
 * check and inject a synthetic user message when needed.
 */
export function hasUserMessage(msgs) {
  return msgs.some((m) => m.role === "user");
}
/** Byte-stable synthetic user message for user-less compacted tails. */
export const SYNTHETIC_USER_MESSAGE =
  "Continue the task described in the summary above from where it left off.";
