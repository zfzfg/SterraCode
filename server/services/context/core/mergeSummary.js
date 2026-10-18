// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
import { countModelTokens } from "./tokenizer.js";
import { setTimeout as delay } from "node:timers/promises";
import { Chat } from "@lmstudio/sdk";
import { respondForPayload } from "./chunkSummary.js";
import { predictInternal } from "./internalPrediction.js";
import { boundSummary, summaryBudgetInstruction } from "./digest.js";
import { extractPayload, noThinkDirective } from "./reasoning.js";
import { isTransientEngineError } from "./retry.js";
import {
  buildMergePrompt,
  buildMergeRescuePrompt,
  nudgeForRetry,
} from "./summarizer.js";
import { promptChatMessages } from "./viewPlan.js";
/** Same merge/retry/rescue path for production and live drift measurements. */
export async function generateMergedSummary(
  ctl,
  model,
  summaries,
  maxTokens,
  maxExcerptChars,
  variant,
  strategy = "system",
  onProgress,
  onMode,
  legacyBenchmark = false,
) {
  const directive = noThinkDirective(model.identifier);
  const prompt = buildMergePrompt(summaries, maxExcerptChars, {
    variant,
    noThinkDirective: directive,
  });
  if (!legacyBenchmark) prompt.system += summaryBudgetInstruction(maxTokens);
  const request = async (p, tokens) => {
    let generated = 0;
    const chat = Chat.from(promptChatMessages(p, strategy, true));
    const opts = {
      maxTokens: tokens,
      temperature: 0.2,
      contextOverflowPolicy: "stopAtLimit",
      onPromptProcessingProgress: (value) => onProgress?.(value * 0.7),
      onPredictionFragment: (fragment) => {
        generated += fragment.tokensCount || 1;
        onProgress?.(0.7 + 0.3 * Math.min(1, generated / tokens));
      },
    };
    return legacyBenchmark
      ? await model.respond(chat, opts)
      : await predictInternal(model, chat, opts, ctl);
  };
  const attempt = async () => {
    const { payload } = await respondForPayload(
      (tokens, retry) => request(nudgeForRetry(prompt, retry), tokens),
      maxTokens,
    );
    if (payload) {
      onMode?.(variant === "compact" ? "compact" : "summary");
      return payload;
    }
    if (variant !== "compact") {
      const rescuePrompt = buildMergeRescuePrompt(summaries, maxExcerptChars, {
        noThinkDirective: directive,
      });
      if (!legacyBenchmark)
        rescuePrompt.system += summaryBudgetInstruction(maxTokens);
      const rescued = extractPayload(
        await request(rescuePrompt, Math.max(maxTokens * 4, 6000)),
      );
      if (rescued) {
        onMode?.("compact");
        return rescued;
      }
    }
    return undefined;
  };
  let payload;
  try {
    payload = await attempt();
  } catch (error) {
    if (ctl.abortSignal.aborted || !isTransientEngineError(error)) throw error;
    await delay(1000, undefined, { signal: ctl.abortSignal });
    payload = await attempt();
  }
  if (ctl.abortSignal.aborted)
    throw ctl.abortSignal.reason ?? new Error("Aborted");
  return payload && !legacyBenchmark
    ? await boundSummary(payload, maxTokens, (text) =>
        countModelTokens(model, text),
      )
    : payload;
}
