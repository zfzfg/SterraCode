// Run as the runner control user, after package maintenance has finished:
// docker compose exec -T runner node /app/tests/docker/runner-live.mjs
// Only this script's random session and test fixture are removed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeRead, removeTree } from "../../runner/common.js";

assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 0);
const secret = (
  await fs.readFile(
    process.env.STERRACODE_RUNNER_SECRET_FILE || "/run/secrets/runner_key",
    "utf8",
  )
).trim();
const base = "http://127.0.0.1:3001";
const sessionId = randomUUID();
const workspaceRoot = process.env.STERRACODE_WORKSPACE_DIR || "/workspaces";
const stateRoot = process.env.RUNNER_STATE_DIR || "/runner-state";
const workspace = path.join(workspaceRoot, sessionId);
const outsideName = `selftest-${randomUUID()}`;
const outside = path.join(stateRoot, outsideName);
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(route, method = "GET", body) {
  const response = await fetch(`${base}/v1${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "X-Runner-Protocol": "1",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(`${response.status}: ${value.error}`), {
      code: value.code,
    });
  return value;
}
function quote(s) {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
async function start(command, executionTimeout = 10000) {
  return api("/jobs", "POST", {
    id: randomUUID(),
    sessionId,
    command,
    actor: "user",
    type: "command",
    executionTimeout,
    compilationTimeout: 60000,
  });
}
async function wait(id, limit = 20000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const result = await api(`/jobs/${id}/output?sessionId=${sessionId}`);
    if (result.exited) return result;
    await sleep(50);
  }
  throw new Error(`Runner job did not finish: ${id}`);
}
async function readCgroup(name) {
  for (const file of [
    `/sys/fs/cgroup/${name}`,
    `/sys/fs/cgroup/pids/${name}`,
  ]) {
    try {
      return (await fs.readFile(file, "utf8")).trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`cgroup ${name} not readable`);
}

await fs.mkdir(workspace, { mode: 0o2770 });
await fs.chown(workspace, 10001, 10001);
await fs.chmod(workspace, 0o2770);
await fs.mkdir(outside, { mode: 0o700 });
await fs.writeFile(
  path.join(outside, "data.txt"),
  "outside-must-stay-private",
  { mode: 0o600 },
);
try {
  assert.equal(
    (await api("/status")).status,
    "ready",
    "Finish package operations before running native checks",
  );

  const timeoutJob = await start("trap '' TERM; sleep 30", 150);
  const timeoutResult = await wait(timeoutJob.processId);
  assert.equal(timeoutResult.state, "timed-out");
  results.push({
    test: "native-timeout-with-SIGTERM-resistant-child",
    state: "passed",
  });

  const outputSource = `const b=Buffer.from('ü🌍');for(let i=0;i<300000;i++)process.stdout.write(b)`;
  const outputJob = await start(`node -e ${quote(outputSource)}`);
  const outputResult = await wait(outputJob.processId);
  assert.equal(outputResult.exitCode, 0);
  assert.equal(outputResult.truncated, true);
  assert(Buffer.byteLength(outputResult.output) <= 1024 * 1024);
  assert(!outputResult.output.includes("�"));
  assert.equal(outputResult.nextOffset, Buffer.byteLength(outputResult.output));
  results.push({
    test: "UTF8-output-cap-keeps-draining-producer",
    state: "passed",
    bytes: outputResult.nextOffset,
  });

  const readyJob = await start(
    "printf 'before-input\\n'; read -r line; printf '%s' \"$line\"",
  );
  for (let i = 0; i < 100; i++) {
    const result = await api(
      `/jobs/${readyJob.processId}/output?sessionId=${sessionId}`,
    );
    if (result.output.includes("before-input")) break;
    await sleep(20);
  }
  const unicodeInput = "🌍".repeat(32768); // 65,536 JS code units, 131,072 UTF-8 bytes.
  await api(`/jobs/${readyJob.processId}/input`, "POST", {
    sessionId,
    input: unicodeInput,
  });
  assert((await wait(readyJob.processId)).output.endsWith(unicodeInput));
  results.push({ test: "maximum-Unicode-stdin", state: "passed" });

  const fifoJob = await start("mkfifo blocked.py");
  assert.equal((await wait(fifoJob.processId)).exitCode, 0);
  let fifoTimer;
  try {
    await assert.rejects(
      Promise.race([
        safeRead(workspace, "blocked.py"),
        new Promise((resolve, reject) => {
          fifoTimer = setTimeout(
            () => reject(new Error("FIFO open blocked the privileged reader")),
            1000,
          );
        }),
      ]),
      /Keine reguläre Datei/,
    );
  } finally {
    clearTimeout(fifoTimer);
  }
  results.push({
    test: "FIFO-source-refused-without-blocking",
    state: "passed",
  });

  const candidate = path.join(workspace, "racing");
  await fs.mkdir(candidate, { mode: 0o2770 });
  await fs.chown(candidate, 10002, 10001);
  await fs.writeFile(path.join(candidate, "data.txt"), "inside", {
    mode: 0o664,
  });
  const raceSource = `const fs=require('node:fs'),p=${JSON.stringify(candidate)},other=p+'-parked',outside=${JSON.stringify(outside)};for(;;){try{fs.renameSync(p,other)}catch{}try{fs.symlinkSync(outside,p)}catch{}try{if(fs.lstatSync(p).isSymbolicLink())fs.unlinkSync(p)}catch{}try{fs.renameSync(other,p)}catch{}}`;
  const raceJob = await start(`node -e ${quote(raceSource)}`, 5000);
  let reads = 0,
    refused = 0;
  for (let i = 0; i < 250; i++) {
    try {
      assert.equal(await safeRead(workspace, "racing/data.txt"), "inside");
      reads++;
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      assert.equal(error.code, "INVALID_PATH");
      refused++;
    }
  }
  // Race the privileged cleanup as well. Failure is safe and recoverable;
  // following a symlink and deleting the outside sentinel is never permitted.
  for (let i = 0; i < 30; i++) {
    try {
      await removeTree(workspace, "racing");
    } catch (error) {
      assert(
        ["ENOENT", "ENOTDIR", "ENOTEMPTY", "ELOOP", "EISDIR"].includes(
          error.code,
        ),
        error.message,
      );
    }
  }
  await api(`/jobs/${raceJob.processId}`, "DELETE", { sessionId });
  assert.equal(
    await fs.readFile(path.join(outside, "data.txt"), "utf8"),
    "outside-must-stay-private",
  );
  assert(reads + refused === 250);
  results.push({
    test: "concurrent-workspace-symlink-read-and-cleanup",
    state: "passed",
    reads,
    refused,
  });

  const max = Number(await readCgroup("pids.max"));
  assert(
    Number.isInteger(max) && max >= 32 && max <= 256,
    "Fork test requires the configured finite runner pids_limit <= 256",
  );
  const baseline = Number(await readCgroup("pids.current"));
  const forkJob = await start(
    `for ((i=0; i<${max + 32}; i++)); do sleep 20 & done; wait`,
    1500,
  );
  let peak = baseline;
  for (let i = 0; i < 50; i++) {
    peak = Math.max(peak, Number(await readCgroup("pids.current")));
    await sleep(30);
  }
  const forkResult = await wait(forkJob.processId);
  assert.equal(forkResult.state, "timed-out");
  assert(peak >= max - 12, `PID limit was not reached (${peak}/${max})`);
  assert((await api("/health")).ok);
  await sleep(100);
  const after = Number(await readCgroup("pids.current"));
  assert(
    after <= baseline + 12,
    `Child processes remained (${after}, baseline ${baseline})`,
  );
  results.push({
    test: "bounded-fork-storm-cgroup-and-runner-survival",
    state: "passed",
    max,
    baseline,
    peak,
    after,
  });
  console.log(
    JSON.stringify(
      { ok: true, at: new Date().toISOString(), results },
      null,
      2,
    ),
  );
} finally {
  await api(`/sessions/${sessionId}/block`, "POST", {}).catch(() => {});
  await removeTree(workspaceRoot, sessionId);
  await removeTree(stateRoot, outsideName);
}
