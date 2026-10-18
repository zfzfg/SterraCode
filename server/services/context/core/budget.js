// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
/** A round costs a reply (~512) plus a tool result (its cap, or 2,048 when unlimited). */
function passAllowance(rounds, toolCap) {
  return Math.max(1, rounds) * ((toolCap > 0 ? toolCap : 2048) + 512);
}
export function effectiveSizes(cfg) {
  const overhead = Math.max(0, cfg.fixedOverheadTokens ?? 0);
  const ctx =
    cfg.contextLength === undefined || cfg.contextLength <= 0
      ? undefined
      : Math.max(0, cfg.contextLength - overhead);
  if (ctx === undefined) {
    return {
      keepRecentTokens: cfg.keepRecentTokens,
      chunkTokens: cfg.chunkTokens,
      reservedOutputTokens: cfg.reservedOutputTokens,
      summarizerMaxTokens: cfg.summarizerMaxTokens,
      maxToolResultTokens: cfg.maxToolResultTokens ?? 0,
      roundsPerPass: cfg.roundsPerPass ?? 0,
      passAllowanceTokens: passAllowance(
        cfg.roundsPerPass ?? 0,
        cfg.maxToolResultTokens ?? 0,
      ),
      marginTokens: 2000,
      mergeMaxTokens: Math.min(3000, 2 * cfg.summarizerMaxTokens),
      usableContextTokens: undefined,
      clamped: [],
    };
  }
  const clamped = [];
  const clamp = (name, configured, floor, fraction) => {
    const cap = Math.max(floor, Math.floor(ctx * fraction));
    if (configured > cap) {
      clamped.push(name);
      return cap;
    }
    return configured;
  };
  const keepRecentTokens = clamp(
    "keepRecentTokens",
    cfg.keepRecentTokens,
    512,
    0.25,
  );
  const chunkTokens = clamp("chunkTokens", cfg.chunkTokens, 1024, 0.3);
  const reservedOutputTokens = clamp(
    "reservedOutputTokens",
    cfg.reservedOutputTokens,
    256,
    0.25,
  );
  const summarizerMaxTokens = clamp(
    "summarizerMaxTokens",
    cfg.summarizerMaxTokens,
    200,
    0.15,
  );
  // One tool result may not eat more than 15% of the usable window: a turn
  // grows by whole tool results between budget checks, and the floor only
  // leaves a few thousand tokens of room on a small window.
  const configuredToolCap = cfg.maxToolResultTokens ?? 0;
  const maxToolResultTokens =
    configuredToolCap > 0
      ? clamp("maxToolResultTokens", configuredToolCap, 512, 0.15)
      : configuredToolCap;
  // Budget checks happen between passes; on a small window a pass must be
  // short enough that its rounds cannot outgrow the room the floor leaves.
  // One round per 6k of usable window, never fewer than one — on a 16k
  // model with a full tools provider that is a check before every round.
  const configuredRounds = cfg.roundsPerPass ?? 0;
  let roundsPerPass = configuredRounds;
  if (configuredRounds > 0) {
    const cap = Math.max(1, Math.floor(ctx / 6000));
    if (configuredRounds > cap) {
      clamped.push("roundsPerPass");
      roundsPerPass = cap;
    }
  }
  // Never reserve more than a quarter of the window for a pass: on a large
  // window a pass rarely uses every round at the full result cap, and the
  // reserve would otherwise eat the room the trigger is meant to leave.
  const passAllowanceTokens = Math.min(
    passAllowance(roundsPerPass, maxToolResultTokens),
    Math.max(1024, Math.floor(ctx * 0.25)),
  );
  const marginTokens = Math.min(2000, Math.max(512, Math.floor(ctx * 0.1)));
  const mergeMaxTokens = Math.min(
    3000,
    2 * summarizerMaxTokens,
    Math.max(600, Math.floor(ctx * 0.15)),
  );
  return {
    keepRecentTokens,
    chunkTokens,
    reservedOutputTokens,
    summarizerMaxTokens,
    maxToolResultTokens,
    roundsPerPass,
    passAllowanceTokens,
    marginTokens,
    mergeMaxTokens,
    usableContextTokens: ctx,
    clamped,
  };
}
/**
 * Which summarizer system-prompt variant to use this turn. Forced modes
 * ("full"/"compact") always win; "auto" always resolves to "full" — bench
 * 2026-08-24: full beat compact on recall at 3B and 18B; auto stays full —
 * compact remains the rescue prompt and a manual option.
 */
export function pickPromptVariant(mode) {
  if (mode !== "auto") return mode;
  return "full";
}
