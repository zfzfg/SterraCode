// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
import { countModelTokens } from "./tokenizer.js";
import { setTimeout as delay } from "node:timers/promises";
import { Chat } from "@lmstudio/sdk";
import { promptChatMessages } from "./viewPlan.js";
import {
  extractPayload,
  isTruncatedStop,
  noThinkDirective,
} from "./reasoning.js";
import { isTransientEngineError } from "./retry.js";
import {
  boundText,
  predictInternal,
  LOSS_MARKER,
} from "./internalPrediction.js";
import {
  buildSummaryPrompt,
  buildSummaryRescuePrompt,
  nudgeForRetry,
  renderForSummary,
  structuralDigest,
} from "./summarizer.js";
import { boundSummary, summaryBudgetInstruction } from "./digest.js";
/**
 * Run a prediction and extract its usable payload (finding L1): qwen3.5+
 * models ignore the /no_think soft-switch, reason regardless, and
 * concatenate that reasoning into `content` with no markers — so with a
 * tight maxTokens the model can exhaust the whole budget on reasoning,
 * leaving nonReasoningContent (and so extractPayload) empty even though
 * generation only stopped because it was truncated, not because the model
 * had nothing to say. When that happens, retry the SAME prompt (plus
 * RETRY_NUDGE, applied by the caller's makeRequest closure) once with
 * max(4x maxTokens, 6000) before giving up — at most one retry per call.
 * Live measurement on qwen3.8-27b showed reasoning burn is highly variable
 * (400 truncated; 1600 succeeded needing 1233; 6000 succeeded needing
 * 1101) — a bare 4x multiplier is borderline against a small base
 * maxTokens (bench's 400 -> 1600 still lets an unlucky chunk truncate
 * inside reasoning on the retry), so 6000 is floored in as deterministic
 * headroom for heavy reasoners. contextOverflowPolicy: "stopAtLimit"
 * (already set at every call site) still bounds this on small contexts —
 * a context-limit truncation on the retry still comes back empty and
 * falls through to the caller's existing throw/undefined/digest path. A
 * payload that comes back empty for any other reason (stop reason not
 * truncation — the model simply refused) is returned as-is on the FIRST
 * attempt without retrying (retrying a refusal wastes a full 6000-token
 * round trip for no expected benefit); callers decide whether an empty
 * payload is fatal, skippable, or gets a structural-digest fallback (see
 * structuralDigest in summarizer.ts / finding L2).
 * `makeRequest` issues one prediction at the given maxTokens, told whether
 * this is the retry (so it can apply RETRY_NUDGE and any other
 * retry-specific tweak), and registers its own ctl.onAborted cancellation.
 */
export async function respondForPayload(makeRequest, maxTokens) {
  let result = await makeRequest(maxTokens, false);
  let payload = extractPayload(result);
  if (!payload && isTruncatedStop(result.stats.stopReason)) {
    result = await makeRequest(Math.max(maxTokens * 4, 6000), true);
    payload = extractPayload(result);
  }
  return { payload, stopReason: result.stats.stopReason };
}
export async function summarizeChunk(
  ctl,
  model,
  chunk,
  maxTokens,
  maxExcerptChars,
  onProgress,
  attachmentMemories,
  // Defaults to "system" (today's behavior) so bench/run.ts — which calls
  // this with only the first 5 args — keeps compiling unchanged.
  promptStrategy = "system",
  // Defaults to "full" (today's behavior) for the same reason.
  variant = "full",
  onMode,
) {
  // Thinking models known to honor a no-think soft-switch skip reasoning;
  // other models never see the directive. Reasoning adds nothing to
  // summaries (it's stripped) but multiplies compaction time.
  maxTokens = Math.min(
    maxTokens,
    Math.max(
      1,
      (await countModelTokens(
        model,
        renderForSummary(chunk, attachmentMemories),
      )) - 64,
    ),
  );
  const directive = noThinkDirective(model.identifier);
  const prompt = buildSummaryPrompt(chunk, maxExcerptChars, {
    noThinkDirective: directive,
    attachmentMemories,
    variant,
  });
  prompt.system += summaryBudgetInstruction(maxTokens);
  const attempt = async () => {
    // Most of a chunk's wall time is the model ingesting the excerpt (prompt
    // processing); map that to 0..0.7 and summary generation to 0.7..1.
    const { payload: primary, stopReason } = await respondForPayload(
      (mt, isRetry) => {
        let generatedTokens = 0;
        const prediction = predictInternal(
          model,
          Chat.from(
            promptChatMessages(
              nudgeForRetry(prompt, isRetry),
              promptStrategy,
              true,
            ),
          ),
          {
            maxTokens: mt,
            temperature: 0.2,
            contextOverflowPolicy: "stopAtLimit",
            onPromptProcessingProgress: (p) => onProgress?.(p * 0.7),
            onPredictionFragment: (fragment) => {
              generatedTokens += fragment.tokensCount || 1;
              onProgress?.(0.7 + 0.3 * Math.min(1, generatedTokens / mt));
            },
          },
          ctl,
        );
        return prediction;
      },
      maxTokens,
    );
    if (primary) {
      onMode?.(variant === "compact" ? "compact" : "summary");
      if (isTruncatedStop(stopReason)) {
        ctl.debug?.("summarizer hit maxTokens; summary may be truncated");
      }
      return await boundSummary(
        primary + (isTruncatedStop(stopReason) ? "\n" + LOSS_MARKER : ""),
        maxTokens,
        (text) => countModelTokens(model, text),
      );
    }
    // Finding L3: before falling back to a structural digest, try ONE
    // rescue with the compact prompt variant when the configured variant
    // wasn't already "compact" — a single model call, no further internal
    // retry, at the same headroom budget with the retry nudge (see
    // buildSummaryRescuePrompt in summarizer.ts for the measured evidence:
    // the FULL 10-section prompt is itself what triggers runaway reasoning
    // on some models — swapping to the much shorter compact prompt answered
    // cleanly on the exact chunk that spiraled under the full prompt).
    if (variant !== "compact") {
      const rescuePrompt = buildSummaryRescuePrompt(chunk, maxExcerptChars, {
        noThinkDirective: directive,
        attachmentMemories,
      });
      rescuePrompt.system += summaryBudgetInstruction(maxTokens);
      const rescuePrediction = predictInternal(
        model,
        Chat.from(promptChatMessages(rescuePrompt, promptStrategy, true)),
        {
          maxTokens: Math.max(maxTokens * 4, 6000),
          temperature: 0.2,
          contextOverflowPolicy: "stopAtLimit",
        },
        ctl,
      );
      const rescued = extractPayload(await rescuePrediction);
      if (rescued) {
        onMode?.("compact");
        ctl.debug?.(
          "summarizer's full prompt returned empty; rescued with the compact prompt variant",
        );
        return await boundSummary(rescued, maxTokens, (text) =>
          countModelTokens(model, text),
        );
      }
    }
    // Finding L2 / ruling R9: compaction must never hard-fail on any
    // model. On qwen3.8-27b with garbage-dense (tool-spam) excerpts,
    // reasoning burn is effectively unbounded — one measured chunk burned
    // 32,626 chars of reasoning and was STILL inside it when even the
    // headroom retry's cap hit (no finite retry budget guarantees an
    // answer), and the L3 compact-prompt rescue above (when attempted) can
    // still come back empty too. Either way there is no usable model
    // summary at this point, so fall back to a deterministic, model-free
    // structural digest instead of throwing. The one exception: an aborted
    // prediction must still propagate as a failure, not silently become a
    // digest — Stop must still stop.
    if (ctl.abortSignal.aborted) {
      throw new Error("summarizer returned an empty summary");
    }
    ctl.debug?.(
      "summarizer returned an empty summary even after the headroom retry" +
        (variant !== "compact" ? " and the compact-prompt rescue" : "") +
        "; falling back to a structural digest",
    );
    // maxTokens is this chunk's own summarizer token budget; ~4 chars/token
    // keeps the digest in roughly the same size class as the summary it
    // replaces (scales with the configured summarizerMaxTokens instead of
    // a fixed constant that would be wrong for both tiny and huge configs).
    onMode?.("digest");
    return await boundText(
      structuralDigest(chunk, maxTokens * 4, attachmentMemories),
      maxTokens,
      (text) => countModelTokens(model, text),
    );
  };
  try {
    return await attempt();
  } catch (error) {
    // Summarization has no side effects, so a transient engine failure is
    // always safe to retry once.
    if (!ctl.abortSignal.aborted && isTransientEngineError(error)) {
      await delay(1000, undefined, { signal: ctl.abortSignal });
      return await attempt();
    }
    throw error;
  }
}
