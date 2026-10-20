import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TRACE_LIMITS = {
  events: 1000,
  bytes: 2 * 1024 * 1024,
  timeout: 10000,
  depth: 4,
  items: 20,
  text: 250,
  frames: 30,
};
export function validateTrace(
  trace,
  fail = (message, metadata = {}) => {
    throw Object.assign(new Error(message), metadata);
  },
) {
  if (
    !trace ||
    typeof trace !== "object" ||
    !Array.isArray(trace.files) ||
    trace.files.length < 1 ||
    trace.files.length > 20 ||
    typeof trace.stdin !== "string" ||
    trace.stdin.length > 65536
  )
    return fail("Ungültiger Trace-Snapshot.", {
      messageKey: "runner:trace.snapshot",
      params: {},
    });
  let bytes = 0;
  const names = new Set();
  for (const file of trace.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      file.path.length > 1000 ||
      !file.path.endsWith(".py") ||
      /[\\\x00-\x1f:*?"<>|]/.test(file.path) ||
      path.posix.isAbsolute(file.path) ||
      file.path
        .split("/")
        .some(
          (p) =>
            !p ||
            p === "." ||
            p === ".." ||
            /[. ]$/.test(p) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
        ) ||
      names.has(file.path) ||
      typeof file.content !== "string"
    )
      return fail("Ungültiger Trace-Quellpfad.", {
        messageKey: "runner:trace.path",
        params: {},
      });
    names.add(file.path);
    bytes += Buffer.byteLength(file.content);
  }
  if (bytes > 1024 * 1024 || !names.has(trace.entry))
    return fail("Trace-Snapshot zu groß oder Einstieg fehlt.", {
      messageKey: "runner:trace.size",
      params: {},
    });
  return {
    entry: trace.entry,
    stdin: trace.stdin,
    files: trace.files.map(({ path, content }) => ({ path, content })),
  };
}

// A separate artifact file keeps program stdout out of the trace protocol.
// Retain an open handle: user replacements/symlinks are never reopened by root.
export async function runTrace(
  job,
  trace,
  runtime,
  base,
  launch,
  docker = false,
) {
  const directory = path.join(base, job.id);
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  const source = path.join(directory, "source");
  await fs.mkdir(source, { mode: 0o755 });
  for (const file of trace.files) {
    const full = path.join(source, file.path);
    await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o755 });
    await fs.writeFile(full, file.content, { flag: "wx", mode: 0o444 });
  }
  const input = path.join(directory, "stdin.txt");
  await fs.writeFile(input, trace.stdin, { flag: "wx", mode: 0o444 });
  const artifact = path.join(directory, "events.jsonl");
  const handle = await fs.open(artifact, "wx+", 0o660);
  if (docker && process.platform === "linux") await handle.chown(10002, 10001);
  job.traceData = "";
  let offset = 0;
  let reading = Promise.resolve();
  const collect = () => {
    reading = reading.then(async () => {
      const buffer = Buffer.alloc(TRACE_LIMITS.bytes - offset);
      if (!buffer.length) return;
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      offset += bytesRead;
      // Python emits ASCII JSON, so chunks cannot split a UTF-8 code point.
      job.traceData += buffer.subarray(0, bytesRead).toString("utf8");
    });
    return reading;
  };
  const timer = setInterval(() => {
    void collect().catch(() => {});
  }, 100);
  try {
    const code = await launch(
      runtime.command,
      [
        ...(runtime.prefix || []),
        "-I",
        fileURLToPath(new URL("./python_tracer.py", import.meta.url)),
        source,
        trace.entry,
        artifact,
        input,
      ],
      source,
      TRACE_LIMITS.timeout,
    );
    await collect();
    return code;
  } finally {
    clearInterval(timer);
    await reading.catch(() => {});
    await handle.close();
    // Cleanup belongs to the backend's safe directory remover.
  }
}
