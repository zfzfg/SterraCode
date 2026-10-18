// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
import { Chat, ChatMessage } from "@lmstudio/sdk";
import { currentTurnStart, SYNTHETIC_USER_MESSAGE } from "./view.js";
import { planViewMessages } from "./viewPlan.js";
/** Tokenizer/transport failures must not silently change the instruction role. */
export function isSystemRoleRejection(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /system (?:role|message|prompt)[^\n]*(?:not supported|not allowed|unsupported|not permitted|forbidden)|no system (?:role|message|prompt)|(?:only|unsupported|not support)[^\n]*(?:user and assistant|system)|conversation roles must alternate/i.test(
    message,
  );
}
/**
 * Thin assembler over planViewMessages: chat templates require at most one
 * system message, at position 0 (the "system" strategy) — or, for
 * no-system-role templates (stock Gemma, some Mistral variants), none at all
 * (the "foldSystem" strategy, folded into a leading/merged user turn
 * instead). The system prompt and summary arrive pre-merged in systemText.
 */
export function buildView(systemText, pairs, coveredUpTo, strategy) {
  const view = Chat.empty();
  const tail = pairs.slice(coveredUpTo);
  const activeIndex = currentTurnStart(
    pairs.map((p) =>
      p.continuation ? { role: "assistant", text: "" } : p.canon,
    ),
  );
  if (activeIndex < coveredUpTo && pairs[activeIndex]?.canon.role === "user")
    tail.unshift(pairs[activeIndex]);
  const planned = planViewMessages(
    systemText,
    tail.map((p) => p.canon),
    strategy,
    SYNTHETIC_USER_MESSAGE,
  );
  for (const msg of planned) {
    const raw =
      msg.fromTailIndex !== undefined ? tail[msg.fromTailIndex].raw : undefined;
    if (raw !== undefined) {
      if (msg.replaceRawText) {
        const copy = ChatMessage.from(raw);
        copy.replaceText(msg.text);
        view.append(copy);
      } else view.append(raw);
    } else {
      view.append(msg.role, msg.text);
    }
  }
  return view;
}
