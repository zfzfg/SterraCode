// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
import { INTERNAL_SOURCE_BOUNDARY } from "./internalPrompt.js";
// Same predicate as src/view.ts's exported hasUserMessage, duplicated locally
// (rather than imported) so this pure planning module's only dependency on
// view.ts stays the CanonMessage type — see src/view.ts#hasUserMessage for
// the original and its rationale (chat templates that reject a userless
// conversation).
function hasUserMessage(tail) {
  return tail.some((m) => m.role === "user");
}
/**
 * Emit tail messages verbatim (fromTailIndex, offset by `offset` into the
 * original tail array) except mid-history system messages, which are always
 * downgraded to annotated user text regardless of strategy — shared by both
 * strategies since neither ever wants a mid-history system role.
 */
function planTail(tail, offset = 0) {
  return tail.map((m, i) =>
    m.role === "system"
      ? { role: "user", text: `[system note] ${m.text}` }
      : { role: m.role, text: m.text, fromTailIndex: offset + i },
  );
}
export function planViewMessages(
  systemText,
  tail,
  strategy,
  syntheticUserText,
) {
  if (strategy === "system") {
    const out = [];
    if (systemText !== undefined)
      out.push({ role: "system", text: systemText });
    if (!hasUserMessage(tail))
      out.push({ role: "user", text: syntheticUserText });
    out.push(...planTail(tail));
    return out;
  }
  // foldSystem: no system role in any output message.
  if (systemText === undefined) {
    // Identical to "system" minus the (absent) system message.
    const out = [];
    if (!hasUserMessage(tail))
      out.push({ role: "user", text: syntheticUserText });
    out.push(...planTail(tail));
    return out;
  }
  if (tail.length > 0 && tail[0].role === "user") {
    // Keep attachment-bearing first turns by replacing only the raw text.
    const merged = { role: "user", text: `${systemText}\n\n${tail[0].text}` };
    if ((tail[0].files ?? []).length > 0) {
      merged.fromTailIndex = 0;
      merged.replaceRawText = true;
    }
    return [merged, ...planTail(tail.slice(1), 1)];
  }
  // Otherwise (tail empty, or starts with assistant/tool/system): inject a
  // new leading user message carrying the folded system text — this also
  // keeps user-first alternation for Gemma-style templates, and already
  // counts as the one required user message, so the tail below never gets a
  // second synthetic user injected.
  const leading = {
    role: "user",
    text: `${systemText}\n\n${syntheticUserText}`,
  };
  return [leading, ...planTail(tail)];
}
/**
 * Build the message list for a plugin-internal prediction (chunk
 * summarization, consolidation merge, attachment memory) from a
 * {system, user} prompt pair, honoring the same no-system-role fold as the
 * compressed view: "system" emits both messages as-is; "foldSystem" merges
 * them into a single user message so the request never carries a system
 * role — the same chat templates that reject a system role in the main view
 * reject it here too.
 */
export function promptChatMessages(
  prompt,
  strategy,
  protectInstruction = false,
) {
  if (strategy === "foldSystem") {
    return [
      {
        role: "user",
        content: `${prompt.system}${protectInstruction ? INTERNAL_SOURCE_BOUNDARY : "\n\n"}${prompt.user}`,
      },
    ];
  }
  return [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
}
