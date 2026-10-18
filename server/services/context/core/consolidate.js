// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
/**
 * Rolling summary consolidation (pragmatic L1): when the assembled summary
 * block outgrows its budget, the oldest chunk summaries are merged into one
 * consolidated summary while the newest stay verbatim. Bounds summary mass
 * so the compact-to-floor target stays reachable at any conversation length.
 */
export function pickConsolidation(
  summaries,
  tokenCounts,
  budgetTokens,
  keepNewest,
  mergeMaxTokens,
) {
  if (budgetTokens <= 0) return null;
  const total = tokenCounts.reduce((a, b) => a + b, 0);
  if (total <= budgetTokens) return null;
  const mergeCount = summaries.length - keepNewest;
  if (mergeCount < 2) return null;
  const keptTokens = tokenCounts.slice(mergeCount).reduce((a, b) => a + b, 0);
  // No-gain guard: consolidation must actually shrink the block by a real
  // margin, or repeated re-folds would thrash (and compound drift).
  const projected = mergeMaxTokens + keptTokens;
  if (total - projected < mergeMaxTokens) return null;
  return {
    merge: summaries.slice(0, mergeCount),
    keep: summaries.slice(mergeCount),
  };
}
export function effectiveSummaryBudget(opts) {
  const lowerClamp = opts.mergeMaxTokens + opts.summarizerMaxTokens;
  if (opts.floorTokens === undefined) {
    return {
      budget: opts.configuredBudget,
      keepNewest: opts.keepNewest,
      floorReachable: true,
    };
  }
  const margin = opts.marginTokens ?? 2000;
  const available =
    opts.floorTokens - opts.keepRecentTokens - opts.systemPromptTokens - margin;
  if (available < lowerClamp) {
    // The floor cannot hold even a minimal summary block: keep a working
    // budget (never negative) and report the floor as unreachable so the
    // handler can clamp and warn.
    return { budget: lowerClamp, keepNewest: 1, floorReachable: false };
  }
  return {
    budget: Math.min(opts.configuredBudget, available),
    keepNewest: opts.keepNewest,
    floorReachable: true,
  };
}
