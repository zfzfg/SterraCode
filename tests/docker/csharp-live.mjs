// Focused regression for root runtime probes creating NuGet's global mutex.
// Execute as root inside an otherwise idle, disposable runner container.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { removeTree } from "../../runner/common.js";
import { LOCK } from "../../runner/catalog.js";

const key = (
  await fs.readFile(
    process.env.STERRACODE_RUNNER_SECRET_FILE || "/run/secrets/runner_key",
    "utf8",
  )
).trim();
const base = "http://127.0.0.1:3001/v1";
async function api(route, method = "GET", body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(`${response.status} ${JSON.stringify(value)}`);
  return value;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runtimeDirectory = await fs.stat(
  path.join(process.env.RUNNER_TOOL_CACHE_DIR || "/tool-cache", "runtime"),
);
assert.equal(runtimeDirectory.uid, 10002);
assert.equal(runtimeDirectory.mode & 0o777, 0o700);
async function packageAction(action) {
  const value = await api("/programs/csharp/actions", "POST", {
    action,
    stopRunning: true,
  });
  const id = value.job.id;
  for (let i = 0; i < 900; i++) {
    const state = await api(`/program-jobs/${id}`);
    if (state.state === "succeeded") return;
    if (["failed", "interrupted", "cancelled"].includes(state.state))
      throw new Error(JSON.stringify(state));
    await sleep(1000);
  }
  throw new Error("C# package action timed out");
}
for (let i = 0; i < 120; i++) {
  const status = await api("/status");
  if (status.status === "ready") break;
  if (status.status === "error") throw new Error(JSON.stringify(status));
  await sleep(500);
}
await packageAction("install");
// Repeatedly exercise the exact runtime endpoint used by app polling.
let runtime;
for (let i = 0; i < 3; i++) {
  runtime = (await api("/runtimes")).find((r) => r.language === "csharp");
  assert(runtime.available);
  assert.equal(
    runtime.version,
    LOCK.apt["dotnet-sdk-8.0"].version.replace(/-\d+$/, ""),
  );
}
const sessionId = randomUUID(),
  workspaceRoot = process.env.STERRACODE_WORKSPACE_DIR || "/workspaces",
  workspace = path.join(workspaceRoot, sessionId);
await fs.mkdir(workspace, { mode: 0o2770 });
await fs.chown(workspace, 10001, 10001);
await fs.chmod(workspace, 0o2770);
await fs.writeFile(
  path.join(workspace, "main.cs"),
  'System.Console.WriteLine("STERRA_CSHARP_NATIVE_OK");',
  { mode: 0o664 },
);
try {
  const job = await api("/jobs", "POST", {
    id: randomUUID(),
    sessionId,
    type: "file",
    file: "main.cs",
    language: "csharp",
    actor: "user",
    executionTimeout: 30000,
    compilationTimeout: 120000,
  });
  for (let i = 0; i < 300; i++) {
    const state = await api(
      `/jobs/${job.processId}/output?sessionId=${sessionId}`,
    );
    if (state.exited) {
      assert.equal(state.exitCode, 0, state.output);
      assert(state.output.includes("STERRA_CSHARP_NATIVE_OK"));
      console.log(
        JSON.stringify(
          {
            ok: true,
            regression: "unprivileged-runtime-probes-before-dotnet-build",
            sdkVersion: runtime.version,
            state: state.state,
            output: state.output,
            at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      break;
    }
    if (i === 299) throw new Error("C# execution did not finish");
    await sleep(500);
  }
} finally {
  await api(`/sessions/${sessionId}/block`, "POST", {});
  await removeTree(workspaceRoot, sessionId);
  await packageAction("remove");
}
