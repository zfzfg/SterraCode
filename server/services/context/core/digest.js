// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
import { boundText, LOSS_MARKER } from "./internalPrediction.js";
/** Last resort: retain concrete evidence, shorten the oldest prose first, keep chronological order. */
export async function digestProse(summaries, maxTokens, count) {
  const wrapper =
    "The earlier part of this conversation was compressed to save context space.";
  const cleaned = summaries
    .join("\n\n")
    .replace(
      new RegExp(
        wrapper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "[\\s\\S]*?mentioning the compression\\.\\s*",
        "g",
      ),
      "",
    )
    .replace(/^=== SUMMARY OF EARLIER CONVERSATION \(part \d+\) ===\s*$/gm, "")
    .replace(/\[context-compressor:[^\]]*\]/g, "");
  const units = cleaned
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)
    .map((value) => value.trim())
    .filter(Boolean);
  // Keep the last occurrence of identical prose, avoiding growth from repeated status reports.
  const unique = new Map();
  units.forEach((text) => {
    unique.delete(text);
    unique.set(text, { text });
  });
  let kept = [...unique.values()];
  const priority = (text) =>
    (/\d/.test(text) ? 2 : 0) +
    (/https?:\/\/|["`]|[\\/][\w.-]+/.test(text) ? 4 : 0) +
    (/\b(?:constraint|decision|budget|deadline|database|source|finding|preference|must|never)\b/i.test(
      text,
    )
      ? 8
      : 0);
  const render = () =>
    LOSS_MARKER + "\n" + kept.map((unit) => unit.text).join("\n");
  while (kept.length > 1 && (await count(render())) > maxTokens) {
    const lowest = Math.min(...kept.map((unit) => priority(unit.text)));
    kept.splice(
      kept.findIndex((unit) => priority(unit.text) === lowest),
      1,
    );
  }
  return await boundText(render(), maxTokens, count);
}
/** Keep a fitting model answer verbatim; reduce oversized answers by evidence before slicing. */
export async function boundSummary(text, maxTokens, count) {
  return (await count(text)) <= maxTokens
    ? text
    : await digestProse([text], maxTokens, count);
}
export const summaryBudgetInstruction = (tokens) =>
  `\nThe stored summary must fit within ${tokens} tokens. Preserve task facts, current values and their sources; shorten background prose first.`;
