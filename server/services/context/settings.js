export const CONTEXT_VERSION = 1;
export const CONTEXT_DEFAULTS = Object.freeze({
  contextSettingsVersion: CONTEXT_VERSION,
  autoCompact: true,
  thresholdPercent: 75,
  compactFloorPercent: 55,
  keepRecentTokens: 6000,
  chunkTokens: 16000,
  summarizerMaxTokens: 1500,
  summaryBudgetTokens: 12000,
  maxToolResultTokens: 4000,
  maxTotalToolResultTokens: 20000,
  summarizerPromptMode: "auto",
});

export function contextCommand(text) {
  const command = typeof text === "string" ? text.trim().toLowerCase() : "";
  if (["/compress", "/compact"].includes(command)) return "compact";
  return command === "/usage" ? "usage" : null;
}
