// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
/**
 * The compaction decision: given the current history, cache coverage, and
 * token budget, decide which chunk cuts to summarize this turn. Lazy for
 * auto mode (only enough chunks to get back under the limit), exhaustive for
 * a forced /compress.
 */
import { chunkEnds, maxAllowedCut, roundBoundaries } from "./view.js";
const NO_PLAN = { cuts: [], reason: null };
export function planCompaction(input) {
  const boundaries = roundBoundaries(input.msgs);
  const maxCut = maxAllowedCut(
    boundaries,
    input.tokens,
    input.keepRecentTokens,
  );
  let cuts = chunkEnds(
    boundaries,
    input.tokens,
    input.coveredUpTo,
    input.chunkTokens,
    maxCut,
  );
  if (input.maxChunks !== undefined && input.maxChunks > 0) {
    cuts = cuts.slice(0, input.maxChunks);
  }
  if (cuts.length === 0) return { ...NO_PLAN };
  if (input.force) return { cuts, reason: "force" };
  if (!input.autoCompact || input.limit === undefined) return { ...NO_PLAN };
  const sumRange = (from, to) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += input.tokens[i];
    return sum;
  };
  let viewTokens =
    input.summaryTokens + sumRange(input.coveredUpTo, input.msgs.length);
  if (viewTokens <= input.limit) return { ...NO_PLAN };
  const target =
    input.floor !== undefined
      ? Math.min(input.floor, input.limit)
      : input.limit;
  const taken = [];
  let from = input.coveredUpTo;
  for (const cut of cuts) {
    viewTokens =
      viewTokens - sumRange(from, cut) + input.estSummaryTokensPerChunk;
    taken.push(cut);
    from = cut;
    if (viewTokens < target) break;
  }
  return { cuts: taken, reason: "auto" };
}
