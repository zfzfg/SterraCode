// Uses a fresh Compose project, loopback port and disposable volumes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../../", import.meta.url));
const project = `sterra-trace-${randomUUID().slice(0, 8)}`;
const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  STERRACODE_BIND_IP: "127.0.0.1",
  STERRACODE_PORT: String(port),
  STERRACODE_PUBLIC_URL: base,
  STERRACODE_INITIAL_PROGRAMS: "python",
};
function compose(args, capture = false) {
  const r = spawnSync(
    "docker",
    ["compose", "-f", "compose.yaml", "-f", "compose.lan.yaml", ...args],
    {
      cwd,
      env,
      stdio: capture ? "pipe" : "inherit",
      encoding: "utf8",
      timeout: 20 * 60000,
    },
  );
  if (r.status !== 0)
    throw new Error(
      `Compose ${args.slice(0, 2).join(" ")} failed: ${r.stderr || r.error || r.status}`,
    );
  return r.stdout?.trim();
}
let cookie = "";
async function api(route, method = "GET", body, expected = 200) {
  const res = await fetch(base + route, {
    method,
    headers: {
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const value = await res.json();
  assert.equal(res.status, expected, `${route}: ${JSON.stringify(value)}`);
  if (res.headers.get("set-cookie"))
    cookie = res.headers.get("set-cookie").split(";")[0];
  return value;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(root, id) {
  for (let i = 0; i < 300; i++) {
    const r = await api(`${root}/traces/${id}`);
    if (!["starting", "running"].includes(r.status)) return r;
    await delay(100);
  }
  throw new Error("Trace did not finish");
}
try {
  console.log(`Trace-Smoke ${project} · ${base}`);
  compose(["build"]);
  compose(["run", "--rm", "--no-deps", "init"]);
  const setupKey = compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "app",
      "node",
      "docker/admin.mjs",
      "setup-key",
    ],
    true,
  )
    .split(/\r?\n/)
    .at(-1);
  compose(["up", "-d", "--wait", "--wait-timeout", "300"]);
  await api("/api/setup", "POST", {
    setupKey,
    password: "trace-smoke-temporary-password",
  });
  let ready = false;
  for (let n = 0; n < 600; n++) {
    const python = (await api("/api/runtimes")).find(
      (r) => r.language === "python",
    );
    if (python?.available) {
      assert.ok(python.modes.includes("trace"));
      ready = true;
      break;
    }
    await delay(1000);
  }
  assert.ok(ready, "Python runtime unavailable");
  const session = await api(
    "/api/sessions",
    "POST",
    { title: "Trace smoke", language: "python" },
    201,
  );
  const root = `/api/workspaces/${session.id}`;
  let file = await api(`${root}/files/content?path=${session.activeFile}`);
  async function start(code) {
    file = await api(`${root}/files/content`, "PUT", {
      path: session.activeFile,
      expectedVersion: file.version,
      content: code,
    });
    const request = {
      operationId: randomUUID(),
      entry: session.activeFile,
      expectedVersions: { [session.activeFile]: file.version },
      stdin: "",
    };
    const run = await api(`${root}/traces`, "POST", request, 202);
    assert.equal(
      (await api(`${root}/traces`, "POST", request, 202)).traceRunId,
      run.traceRunId,
    );
    return run;
  }
  let run = await start(
    'a = []\nb = a\na.append(a)\ndef f(n):\n    if n == 0:\n        return 1\n    return f(n-1) + n\nresult = f(3)\nprint("TRACE_DOCKER_OK")\n',
  );
  let result = await wait(root, run.traceRunId);
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.reason, "completed");
  assert.match(result.output, /TRACE_DOCKER_OK/);
  const page = await api(`${root}/traces/${run.traceRunId}/events?limit=50`);
  assert.ok(
    page.events.some(
      (e) => e.stack.filter((f) => f.function === "f").length === 4,
    ),
  );
  const alias = page.events.find((e) => e.locals.a && e.locals.b);
  assert.equal(alias.locals.a.ref, alias.locals.b.ref);
  run = await start("import time\nx = 1\ntime.sleep(60)\n");
  await delay(500);
  result = await api(`${root}/traces/${run.traceRunId}/cancel`, "POST", {});
  assert.equal(result.reason, "stopped");
  assert.equal(result.complete, false);
  assert.ok(result.eventCount > 0);
  run = await start("import sys, time\nsys.settrace(None)\ntime.sleep(60)\n");
  result = await wait(root, run.traceRunId);
  assert.equal(result.reason, "timeout");
  assert.equal(result.complete, false);
  run = await start("import time\nx = 1\ntime.sleep(60)\n");
  await delay(750);
  compose(["kill", "-s", "SIGKILL", "runner"]);
  compose(["up", "-d", "--no-deps", "runner"]);
  result = await wait(root, run.traceRunId);
  assert.equal(result.status, "interrupted");
  assert.equal(result.complete, false);
  assert.ok(result.eventCount > 0);
  compose(["restart", "app"]);
  for (let n = 0; n < 100; n++) {
    try {
      await api("/api/health");
      break;
    } catch {
      await delay(100);
    }
  }
  assert.equal(
    (await api(`${root}/traces/${run.traceRunId}`)).status,
    "interrupted",
  );
  assert.equal((await api(`${root}/traces`)).length, 4);
  await api(`/api/sessions/${session.id}`, "DELETE", {});
  console.log(
    "PASS: Python trace, aliasing/recursion, durable idempotency, partial cancellation, external watchdog, runner/app restart and session deletion.",
  );
} finally {
  compose(["down", "--volumes", "--remove-orphans"]);
}
