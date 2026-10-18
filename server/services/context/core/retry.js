// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
/**
 * Transient engine/channel failures ("terminated", connection resets) kill
 * otherwise-healthy replies. They are worth exactly one retry — but only
 * when nothing side-effectful has happened yet (the caller enforces that).
 */
export const TRANSIENT_ERROR_RE =
  /terminated|econnreset|econnrefused|connection (?:was )?reset|fetch failed|socket hang up|channel.*closed/i;
export function isTransientEngineError(error) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return TRANSIENT_ERROR_RE.test(message);
}
