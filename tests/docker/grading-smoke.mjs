// Uses a fresh Compose project, loopback port and disposable volumes.

import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";

import { randomUUID } from "node:crypto";

import net from "node:net";

import { fileURLToPath } from "node:url";

const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], {
  encoding: "utf8",
  windowsHide: true,
});

if (info.status !== 0 || info.stdout.trim() !== "linux") {
  console.log(
    "ÜBERSPRUNGEN: Grading-Smoke benötigt einen erreichbaren Linux-Docker-Daemon.",
  );

  process.exit(
    process.env.CI || process.env.STERRACODE_DOCKER_REQUIRED === "1" ? 1 : 0,
  );
}

const cwd = fileURLToPath(new URL("../../", import.meta.url));

const project = `sterra-grading-${randomUUID().slice(0, 8)}`;

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
    const r = await api(`${root}/test-runs/${id}`);

    if (!["starting", "running"].includes(r.status)) return r;

    await delay(100);
  }

  throw new Error("Trace did not finish");
}

try {
  console.log(`Grading-Smoke ${project} · ${base}`);

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
      assert.ok(python.modes.includes("test"));

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

  const taskArgs = {
    title: "Strings umkehren",
    description: "Gib den umgekehrten String zurück.",
    difficulty: "beginner",
    testSuite: {
      schemaVersion: 1,
      version: 1,
      language: "python",
      entry: { path: session.activeFile, function: "reverse_string" },
      comparison: { kind: "strict-json" },
      cases: [
        {
          id: "word",
          name: "Wort",
          args: ["hello"],
          expected: "olleh",
          visibility: "public",
          required: true,
        },
        {
          id: "empty",
          name: "Leer",
          args: [""],
          expected: "",
          visibility: "public",
          required: true,
        },
      ],
    },
  };

  const fixture = `import {executeTool} from './server/services/toolExecutor.js'; const r=await executeTool('create_task', ${JSON.stringify(taskArgs)}, {sessionId:${JSON.stringify(session.id)}}); if(r.type==='tool_error')throw Error(r.error);console.log(JSON.stringify(r.task));`;

  const task = JSON.parse(
    compose(
      ["exec", "-T", "app", "node", "--input-type=module", "-e", fixture],
      true,
    ),
  );

  async function start(code) {
    const old = await api(`${root}/files/content?path=${session.activeFile}`);

    const saved = await api(`${root}/files/content`, "PUT", {
      path: session.activeFile,
      expectedVersion: old.version,
      content: code,
    });

    const body = {
      operationId: randomUUID(),
      taskVersion: 1,
      expectedVersions: { [session.activeFile]: saved.version },
    };

    const route = `${root}/tasks/${task.id}/test-runs`;

    const run = await api(route, "POST", body, 202);

    assert.equal(
      (await api(route, "POST", body, 202)).testRunId,
      run.testRunId,
    );

    return run;
  }

  let run = await start("def reverse_string(s):\n    return s\n");

  assert.equal((await wait(root, run.testRunId)).assessment, "failed");

  run = await start(
    "def reverse_string(s):\n    print('x'*100000)\n    return s[::-1]\n",
  );

  let result = await wait(root, run.testRunId);

  assert.equal(result.assessment, "passed", JSON.stringify(result));

  assert.equal(result.cases[0].outputTruncated, true);

  const complete = { taskVersion: 1, testRunId: run.testRunId };

  const first = await api(
    `${root}/tasks/${task.id}/complete`,
    "POST",
    complete,
  );

  const second = await api(
    `${root}/tasks/${task.id}/complete`,
    "POST",
    complete,
  );

  assert.deepEqual(first.currentTask.completion, second.currentTask.completion);

  run = await start("def reverse_string(s):\n    while True: pass\n");

  result = await wait(root, run.testRunId);

  assert.deepEqual(
    result.cases.map((c) => c.kind),
    ["timeout", "not_run"],
  );

  run = await start(
    "import time\ndef reverse_string(s):\n    time.sleep(60)\n",
  );

  await delay(300);

  result = await api(`${root}/test-runs/${run.testRunId}/cancel`, "POST", {});

  assert.equal(result.status, "cancelled");

  run = await start(
    "import time\ndef reverse_string(s):\n    time.sleep(60)\n",
  );

  await delay(300);

  compose(["kill", "-s", "SIGKILL", "runner"]);

  compose(["up", "-d", "--no-deps", "runner"]);

  assert.equal((await wait(root, run.testRunId)).status, "interrupted");

  assert.equal((await api(`${root}/tasks/${task.id}/test-runs`)).length, 5);

  await api(`/api/sessions/${session.id}`, "DELETE", {});

  console.log(
    "PASS: Python function tests, bounded output, failed/passed cases, idempotency, completion, timeout, cancellation, restart and deletion.",
  );
} finally {
  compose(["down", "--volumes", "--remove-orphans"]);
}
