import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_LIMITS } from "./schema.js";

// One reserved job, sequential children, and one immutable source copy per case.
export async function runTests(
  job,
  test,
  runtime,
  base,
  launch,
  docker = false,
) {
  job.testResults = [];
  const started = Date.now();
  for (const [index, c] of test.suite.cases.entries()) {
    if (
      job.stopping ||
      job.reason ||
      Date.now() - started >= TEST_LIMITS.suiteTimeout
    )
      break;
    const directory = path.join(base, job.id, String(index));
    const source = path.join(directory, "source");
    await fs.mkdir(source, { recursive: true, mode: 0o755 });
    for (const file of test.files) {
      const full = path.join(source, file.path);
      await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o755 });
      await fs.writeFile(full, file.content, { flag: "wx", mode: 0o444 });
    }
    const input = path.join(directory, "args.json");
    await fs.writeFile(input, JSON.stringify(c.args), {
      flag: "wx",
      mode: 0o444,
    });
    const artifact = path.join(directory, "result.json");
    const handle = await fs.open(artifact, "wx+", 0o660);
    if (docker && process.platform === "linux")
      await handle.chown(10002, 10001);
    let result;
    const outputStart = job.output.length;
    job.testOutputRemaining = TEST_LIMITS.resultBytes;
    job.testOutputTruncated = false;
    try {
      const code = await launch(
        runtime.command,
        [
          ...(runtime.prefix || []),
          "-I",
          fileURLToPath(new URL("./python_functions.py", import.meta.url)),
          source,
          test.suite.entry.path,
          test.suite.entry.function,
          input,
          artifact,
        ],
        source,
        Math.max(
          1,
          Math.min(
            TEST_LIMITS.caseTimeout,
            TEST_LIMITS.suiteTimeout - (Date.now() - started),
          ),
        ),
      );
      const buffer = Buffer.alloc(TEST_LIMITS.resultBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      try {
        result = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
        if (
          bytesRead > TEST_LIMITS.resultBytes ||
          code !== 0 ||
          !["return", "program_error", "serialization_error"].includes(
            result.kind,
          )
        )
          throw new Error();
      } catch {
        result = {
          kind: "invalid_result",
          message:
            "Kein gültiges Harness-Ergebnis; stdout zählt nicht als Testnachweis.",
        };
      }
      if (job.reason)
        result = {
          kind: job.reason,
          message:
            job.reason === "timeout"
              ? "Zeitlimit des Testfalls erreicht. Schleifen und Eingaben prüfen."
              : "Ausführung abgebrochen.",
        };
    } finally {
      await handle.close();
    }
    job.testResults.push({
      id: c.id,
      ...result,
      output: job.output.slice(
        outputStart,
        outputStart + TEST_LIMITS.resultBytes,
      ),
      outputTruncated: job.testOutputTruncated,
    });
  }
  for (const c of test.suite.cases.slice(job.testResults.length))
    job.testResults.push({
      id: c.id,
      kind: "not_run",
      message: "Nach Abbruch oder Zeitlimit nicht ausgeführt.",
    });
  return job.reason || job.stopping ? 1 : 0;
}
