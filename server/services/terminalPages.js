import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "./storage.js";
import { readProcess } from "./processes.js";
import { runnerEnabled } from "./runnerClient.js";

const secret = randomBytes(32);
export const TERMINAL_PAGE_BYTES = 16 * 1024;
const sign = (text) =>
  createHmac("sha256", secret).update(text).digest("base64url");
export function terminalRuntime() {
  return runnerEnabled()
    ? `docker:${process.env.STERRACODE_RUNNER_URL || ""}`
    : "local";
}
function encodeCursor(sessionId, processId, runtime, offset) {
  const data = Buffer.from(
    JSON.stringify({ sessionId, processId, runtime, offset }),
  ).toString("base64url");
  return `${data}.${sign(data)}`;
}
function decodeCursor(cursor, sessionId, processId, runtime) {
  if (cursor === undefined) return 0;
  try {
    if (typeof cursor !== "string" || cursor.length > 2048) throw new Error();
    const [data, mac, extra] = cursor.split(".");
    const actual = Buffer.from(mac || "", "base64url"),
      expected = Buffer.from(sign(data), "base64url");
    if (
      extra !== undefined ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new Error();
    const value = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (
      value.sessionId !== sessionId ||
      value.processId !== processId ||
      value.runtime !== runtime ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 0
    )
      throw new Error();
    return value.offset;
  } catch {
    throw new AppError(
      "Ungültiger Terminal-Cursor für diesen Prozess oder diese Laufzeit.",
      undefined,
      undefined,
      { messageKey: "serverFeature:terminal.invalidCursor", params: {} },
    );
  }
}

// HTTP process offsets keep their native semantics. Only model tools use cursors.
export function terminalPage(
  snapshot,
  sessionId,
  runtime,
  offset = 0,
  preserveOriginal = false,
) {
  const raw = snapshot.output || "";
  let chars = 0,
    bytes = 0;
  for (const char of raw) {
    const length = Buffer.byteLength(char, "utf8");
    if (bytes + length > TERMINAL_PAGE_BYTES) break;
    chars += char.length;
    bytes += length;
  }
  const next = offset + (runtime.startsWith("docker:") ? bytes : chars);
  const modelPage = {
    output: raw.slice(0, chars),
    pageTruncated: chars < raw.length,
    nextCursor: encodeCursor(sessionId, snapshot.processId, runtime, next),
  };
  // The session stores the full receipt for recovery even after a process
  // expires. The model receives only modelPage through projectToolResult.
  return preserveOriginal
    ? { ...snapshot, modelPage }
    : { ...snapshot, ...modelPage };
}
export async function readTerminalPage(
  processId,
  sessionId,
  cursor,
  preserveOriginal = false,
) {
  const runtime = terminalRuntime();
  const offset = decodeCursor(cursor, sessionId, processId, runtime);
  const snapshot = await readProcess(processId, sessionId, offset);
  return terminalPage(snapshot, sessionId, runtime, offset, preserveOriginal);
}
