// Run only against a retained, isolated Docker smoke project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const base = process.env.STERRACODE_LIVE_APP_URL;
const project = process.env.STERRACODE_LIVE_PROJECT;
assert.ok(/^sterra-smoke-[a-f0-9]+$/.test(project || ""));
assert.equal(new URL(base).hostname, "127.0.0.1");
let cookie = "",
  session;
async function api(route, method = "GET", body) {
  const r = await fetch(base + "/api" + route, {
    method,
    headers: {
      Origin: base,
      Cookie: cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const value = await r.json();
  assert.ok(r.ok, JSON.stringify(value));
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  return value;
}
function compose(args) {
  const r = spawnSync(
    "docker",
    ["compose", "-f", "compose.yaml", "-f", "compose.lan.yaml", ...args],
    {
      env: { ...process.env, COMPOSE_PROJECT_NAME: project },
      stdio: "inherit",
      timeout: 180000,
    },
  );
  assert.equal(r.status, 0);
}
async function wait(fn) {
  let error;
  for (let i = 0; i < 60; i++) {
    try {
      return await fn();
    } catch (e) {
      error = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw error;
}
try {
  await api("/login", "POST", { password: "smoke-password-safe" });
  session = await api("/sessions", "POST", {
    title: "Runner-Crashvertrag",
    language: "javascript",
  });
  const id = randomUUID(),
    command =
      'printf "one\\n" >> runner-restart-counter; printf crash-ready; sleep 1000';
  const payload = { sessionId: session.id, idempotencyId: id, command };
  const job = await api("/terminal", "POST", payload);
  const read = () =>
    api(`/terminal/${job.processId}/output?sessionId=${session.id}`);
  await wait(async () => {
    const out = await read();
    assert.match(out.output, /crash-ready/);
  });
  compose(["kill", "-s", "KILL", "runner"]);
  compose([
    "up",
    "-d",
    "--no-deps",
    "--wait",
    "--wait-timeout",
    "120",
    "runner",
  ]);
  const interrupted = await wait(async () => {
    const out = await read();
    assert.equal(out.state, "interrupted");
    return out;
  });
  const repeat = await api("/terminal", "POST", payload);
  assert.equal(repeat.processId, id);
  assert.equal(repeat.state, "interrupted");
  const check = await api("/execute", "POST", {
    sessionId: session.id,
    command:
      'test "$(wc -l < runner-restart-counter)" = 1 && printf exactly-once-after-restart',
  });
  assert.equal(check.exitCode, 0);
  assert.match(check.output, /exactly-once-after-restart/);
  console.log(
    JSON.stringify({
      test: "real-runner-SIGKILL-recovery",
      previousIdStillValid: true,
      state: interrupted.state,
      duplicateNotReexecuted: true,
    }),
  );
} finally {
  if (session) await api(`/sessions/${session.id}`, "DELETE", {});
}
