import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], {
  encoding: "utf8",
  windowsHide: true,
});
if (info.status !== 0 || info.stdout.trim() !== "linux") {
  const required =
    process.env.CI || process.env.STERRACODE_DOCKER_REQUIRED === "1";
  console.log(
    `${required ? "FEHLER" : "ÜBERSPRUNGEN"}: Docker-Smoke benötigt einen erreichbaren Linux-Docker-Daemon.`,
  );
  process.exit(required ? 1 : 0);
}
const project = `sterra-smoke-${randomUUID().slice(0, 8)}`;
const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-backup-"));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const p = server.address().port;
    server.close(() => resolve(p));
  });
});
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  STERRACODE_BIND_IP: "127.0.0.1",
  STERRACODE_PORT: String(port),
  STERRACODE_PUBLIC_URL: base,
  STERRACODE_PROXY_MODE: "off",
  STERRACODE_INITIAL_PROGRAMS: "",
};
let restoreProject;
let importProject;
let importDir;
function docker(args, capture = false, override = {}) {
  const result = spawnSync("docker", args, {
    cwd: root,
    env: { ...env, ...override },
    encoding: "utf8",
    windowsHide: true,
    stdio: capture ? "pipe" : "inherit",
    timeout: 30 * 60000,
    maxBuffer: 16 * 1024 ** 2,
  });
  if (result.status !== 0)
    throw new Error(
      `Docker-Befehl fehlgeschlagen: ${args.slice(0, 4).join(" ")}\n${result.stderr || result.error?.message || ""}`,
    );
  return result.stdout?.trim();
}
function compose(args, capture = false, override = {}) {
  return docker(
    ["compose", "-f", "compose.yaml", "-f", "compose.lan.yaml", ...args],
    capture,
    override,
  );
}
let cookie = "";
async function api(endpoint, method = "GET", body, expected = 200) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: {
      Origin: base,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(22 * 60000),
  });
  const value = await response.json();
  assert.equal(
    response.status,
    expected,
    `${method} ${endpoint}: ${JSON.stringify(value)}`,
  );
  if (response.headers.get("set-cookie"))
    cookie = response.headers.get("set-cookie").split(";")[0];
  return value;
}
async function eventually(callback, milliseconds = 120000) {
  const end = Date.now() + milliseconds;
  let error;
  do {
    try {
      return await callback();
    } catch (e) {
      error = e;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } while (Date.now() < end);
  throw error;
}
const runtimeSources = {
  python: ["main.py", 'print("sterra-ä-python")'],
  java: [
    "Main.java",
    'public class Main { public static void main(String[] args) { System.out.println("sterra-ä-java"); } }',
  ],
  go: [
    "main.go",
    'package main\nimport "fmt"\nfunc main(){fmt.Println("sterra-ä-go")}',
  ],
  rust: ["main.rs", 'fn main(){println!("sterra-ä-rust");}'],
  cpp: [
    "main.cpp",
    '#include <iostream>\nint main(){std::cout<<"sterra-ä-cpp"<<std::endl;}',
  ],
  csharp: ["main.cs", 'System.Console.WriteLine("sterra-ä-csharp");'],
  lua: ["main.lua", 'print("sterra-ä-lua")'],
};
async function programAction(id, action) {
  if (["disable", "enable"].includes(action)) {
    const settings = await api("/api/chat/settings");
    const allowed = new Set(settings.allowedLanguages);
    if (action === "enable") allowed.add(id);
    else allowed.delete(id);
    await api("/api/chat/settings", "PATCH", {
      allowedLanguages: [...allowed],
    });
  } else {
    const started = await api(
      `/api/programs/${id}/actions`,
      "POST",
      { action, stopRunning: true },
      202,
    );
    const jobId = started.job?.id || started.id;
    assert.ok(jobId, "Paketaktion hat keine Auftrags-ID");
    const deadline = Date.now() + 15 * 60000;
    for (;;) {
      const job = await api(`/api/programs/jobs/${jobId}`);
      if (job.state === "succeeded") break;
      if (["failed", "cancelled", "interrupted"].includes(job.state))
        throw new Error(
          `${id} ${action} fehlgeschlagen: ${job.error || job.state}`,
        );
      if (Date.now() > deadline)
        throw new Error(`${id} ${action}: Paketzeitlimit überschritten`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await eventually(async () => {
    const result = await api("/api/runtimes");
    const runtime = (Array.isArray(result) ? result : result.runtimes).find(
      (r) => r.language === id,
    );
    assert.ok(runtime, `Laufzeit ${id} fehlt`);
    if (action === "install" || action === "enable")
      assert.ok(
        runtime.installed && runtime.enabled && runtime.available,
        `${id} noch nicht ausführbar: ${JSON.stringify(runtime)}`,
      );
    if (action === "remove")
      assert.equal(runtime.installed, false, `${id} noch installiert`);
    if (action === "disable") assert.equal(runtime.enabled, false);
  }, 15 * 60000);
}
async function languageSmoke(language, filename, content) {
  const s = await api(
    "/api/sessions",
    "POST",
    { title: `Smoke ${language}`, language },
    201,
  );
  await api(
    `/api/workspaces/${s.id}/files`,
    "POST",
    { path: filename, content },
    201,
  ).catch(async (e) => {
    const current = await api(
      `/api/workspaces/${s.id}/files/content?path=${encodeURIComponent(filename)}`,
    );
    return api(`/api/workspaces/${s.id}/files/content`, "PUT", {
      path: filename,
      content,
      expectedVersion: current.version,
    });
  });
  const result = await api("/api/execute", "POST", {
    sessionId: s.id,
    type: "file",
    file: filename,
    language,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.output, /sterra-ä-/);
  return s;
}
async function waitJob(job, sessionId) {
  return eventually(async () => {
    const out = await api(
      `/api/terminal/${job.processId}/output?sessionId=${sessionId}&offset=0`,
    );
    assert.ok(out.exited, "Auftrag läuft noch");
    return out;
  });
}
async function executionContracts(session) {
  const run = async (command, extra = {}) =>
    api("/api/terminal", "POST", { sessionId: session.id, command, ...extra });
  const isolation = await waitJob(
    await run(
      'test "$(id -u)" = 10002 && test "$(id -G)" = 10001 && ! test -r /run/secrets/runner_key && ! test -r /runner-state/programs.json && ! test -e /data/auth.json && ! env | grep -Eq "STERRACODE_|TOKEN|SECRET|DEBIAN_FRONTEND" && printf isolation-ok',
    ),
    session.id,
  );
  assert.equal(isolation.exitCode, 0, isolation.output);
  assert.match(isolation.output, /isolation-ok/);
  const stdin = await run(
    'printf "input-ready\\n"; read -r line; printf "stdin:%s\\n" "$line"',
  );
  await eventually(async () =>
    assert.match(
      (
        await api(
          `/api/terminal/${stdin.processId}/output?sessionId=${session.id}`,
        )
      ).output,
      /input-ready/,
    ),
  );
  await api(`/api/terminal/${stdin.processId}/input`, "POST", {
    sessionId: session.id,
    input: "Grüße",
  });
  assert.match((await waitJob(stdin, session.id)).output, /stdin:Grüße/);
  const tree = await run(
    'setsid bash --noprofile --norc -c \'trap "" TERM; sleep 1000 & wait\' & printf "tree-ready\\n"; wait',
  );
  await eventually(async () =>
    assert.match(
      (
        await api(
          `/api/terminal/${tree.processId}/output?sessionId=${session.id}`,
        )
      ).output,
      /tree-ready/,
    ),
  );
  const stopped = await api(`/api/terminal/${tree.processId}`, "DELETE", {
    sessionId: session.id,
  });
  assert.ok(stopped.exited);
  assert.equal(stopped.state, "cancelled");
  const remaining = compose(
    [
      "exec",
      "-T",
      "runner",
      "node",
      "-e",
      "const fs=require('node:fs');let n=0;for(const p of fs.readdirSync('/proc')){if(!/^\\d+$/.test(p))continue;try{if(/^Uid:\\s+10002\\s/m.test(fs.readFileSync('/proc/'+p+'/status','utf8')))n++}catch{}}if(n)process.exit(1);console.log('no-descendants')",
    ],
    true,
  );
  assert.match(remaining, /no-descendants/);
  const id = randomUUID(),
    command =
      'printf "one\\n" >> idempotency-counter.txt; printf idempotency-ok';
  const original = await run(command, { idempotencyId: id });
  await waitJob(original, session.id);
  const repeated = await run(command, { idempotencyId: id });
  assert.equal(repeated.processId, original.processId);
  await api(
    "/api/terminal",
    "POST",
    { sessionId: session.id, idempotencyId: id, command: command + "; true" },
    409,
  );
  const counted = await waitJob(
    await run(
      'test "$(wc -l < idempotency-counter.txt)" = 1 && printf counted-once',
    ),
    session.id,
  );
  assert.equal(counted.exitCode, 0);
  assert.match(counted.output, /counted-once/);
  const survives = await run(
    'printf "survive-start\\n"; sleep 5; printf survive-done',
  );
  compose(["kill", "-s", "KILL", "app"]);
  compose(["up", "-d", "--no-deps", "--wait", "--wait-timeout", "90", "app"]);
  const resumed = await waitJob(survives, session.id);
  assert.match(resumed.output, /survive-done/);
  console.log(
    "Runner-Verträge: UID/Gruppen, Secretschutz, stdin/UTF-8, Enkelgruppen-Stop, Idempotenz/Konflikt und App-Ausfall geprüft.",
  );
}
try {
  console.log(`Docker-Smoke: isoliertes Projekt ${project}, Port ${port}.`);
  compose(["config", "--quiet"]);
  compose(["build"]);
  docker([
    "run",
    "--rm",
    "--read-only",
    "--tmpfs",
    "/data:size=1m,mode=0700,uid=10001,gid=10001",
    "-v",
    `${path.join(root, "tests/docker/disk-full-live.mjs")}:/probe.mjs:ro`,
    `${project}-app:1.1.0`,
    "node",
    "/probe.mjs",
  ]);
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
  assert.match(setupKey, /^[A-Za-z0-9_-]{40,}$/);
  compose(["up", "-d", "--remove-orphans", "--wait", "--wait-timeout", "180"]);
  assert.deepEqual(await api("/api/health"), { ok: true });
  await api("/api/runtimes", "GET", undefined, 401);
  await api(
    "/api/setup",
    "POST",
    { setupKey: "untrusted", password: "smoke-password-safe" },
    403,
  ).catch(async () =>
    api(
      "/api/setup",
      "POST",
      { setupKey: "untrusted", password: "smoke-password-safe" },
      401,
    ),
  );
  await api("/api/setup", "POST", {
    setupKey,
    password: "smoke-password-safe",
  });
  assert.ok(cookie.startsWith("sterracode.session="));
  await eventually(async () => {
    const r = await api("/api/runtimes");
    assert.ok(
      (Array.isArray(r) ? r : r.runtimes).find(
        (x) => x.language === "javascript",
      )?.available,
    );
  });
  const session = await languageSmoke(
    "javascript",
    "smoke.js",
    'console.log("sterra-ä-javascript");',
  );
  await executionContracts(session);
  const runnerContainer = compose(["ps", "--quiet", "runner"], true);
  compose(["exec", "-T", "runner", "mkdir", "-p", "/app/tests/docker"]);
  docker([
    "cp",
    path.join(root, "tests/docker/runner-live.mjs"),
    `${runnerContainer}:/app/tests/docker/runner-live.mjs`,
  ]);
  compose([
    "exec",
    "-T",
    "runner",
    "node",
    "/app/tests/docker/runner-live.mjs",
  ]);
  assert.deepEqual(
    await api("/api/health"),
    { ok: true },
    "App-Health nach Runner-Ressourcenlimit",
  );
  const terminal = await api("/api/terminal", "POST", {
    sessionId: session.id,
    type: "command",
    command: '[[ -n "$BASH_VERSION" ]] && printf "bash-ä-ok\\n"',
  });
  const output = await eventually(async () => {
    const out = await api(
      `/api/terminal/${terminal.processId}/output?sessionId=${session.id}&offset=0`,
    );
    assert.match(out.output, /bash-ä-ok/);
    return out;
  });
  assert.ok(Number.isInteger(output.nextOffset));
  const settings = await api("/api/chat/settings");
  assert.ok(!JSON.stringify(settings).includes(setupKey));
  const initialized = compose(
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
  );
  assert.match(initialized, /bereits eingerichtet/);
  compose(["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "180"]);
  await eventually(async () =>
    assert.equal((await api(`/api/sessions/${session.id}`)).id, session.id),
  );
  if (process.env.STERRACODE_DOCKER_FULL === "1") {
    const selected = process.env.STERRACODE_DOCKER_LANGUAGES?.split(",").map(
      (s) => s.trim(),
    );
    for (const [language, [filename, content]] of Object.entries(
      runtimeSources,
    )) {
      if (selected && !selected.includes(language)) continue;
      console.log(
        `Katalog: ${language} installieren, ausführen, deaktivieren, aktivieren und entfernen.`,
      );
      await programAction(language, "install");
      await languageSmoke(language, filename, content);
      await programAction(language, "disable");
      await programAction(language, "enable");
      await programAction(language, "remove");
    }
  }
  // Keep a real optional runtime desired across recreation and the backup.
  await programAction("python", "install");
  await languageSmoke(
    "python",
    "persistent.py",
    'print("sterra-ä-persistent")',
  );
  compose([
    "exec",
    "-T",
    "runner",
    "sh",
    "-c",
    "touch /tool-cache/persistence-sentinel /runs/stale-before-recreate",
  ]);
  compose([
    "up",
    "-d",
    "--no-deps",
    "--force-recreate",
    "--wait",
    "--wait-timeout",
    "180",
    "runner",
  ]);
  await eventually(
    async () =>
      assert.ok(
        (await api("/api/runtimes")).find((r) => r.language === "python")
          ?.available,
      ),
    180000,
  );
  compose([
    "exec",
    "-T",
    "runner",
    "sh",
    "-c",
    "test -f /tool-cache/persistence-sentinel && ! test -e /runs/stale-before-recreate",
  ]);
  await languageSmoke("python", "recreated.py", 'print("sterra-ä-recreated")');
  const stoppedRunner = compose(["ps", "--quiet", "runner"], true);
  compose(["stop", "runner"]);
  const offline =
    "import assert from 'node:assert/strict';import {createRunner} from './runner/index.js';import {runtimes} from './runner/runtime.js';const r=await createRunner();await r.initialize();assert.equal(r.jobs.state,'ready',JSON.stringify(r.jobs.initializationError));assert.ok((await runtimes()).find(x=>x.language==='python')?.installed);await r.jobs.close();console.log('offline-python-cache-restored');";
  docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--init",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--volumes-from",
    stoppedRunner,
    `${project}-runner:1.1.0`,
    "node",
    "--input-type=module",
    "-e",
    offline,
  ]);
  compose([
    "up",
    "-d",
    "--no-deps",
    "--wait",
    "--wait-timeout",
    "180",
    "runner",
  ]);
  const historyId = compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "app",
      "node",
      "--input-type=module",
      "-e",
      "import {writeFile} from './server/services/workspace.js';console.log((await writeFile(process.argv[1],'undo-fixture.txt','AI-Wiederherstellung',null,{actor:'ai',reason:'Backup-Smoke'})).changeId);",
      session.id,
    ],
    true,
  )
    .split(/\r?\n/)
    .at(-1);
  compose(["stop"]);
  const images = compose(["images", "--format", "json"], true);
  compose([
    "run",
    "--rm",
    "--no-deps",
    "-e",
    `STERRACODE_BACKUP_IMAGES=${images}`,
    "-e",
    `STERRACODE_BACKUP_UID=${process.getuid?.() || 0}`,
    "-e",
    `STERRACODE_BACKUP_GID=${process.getgid?.() || 0}`,
    "-v",
    `${backupDir}:/backup`,
    "admin",
    "backup",
    "--offline",
  ]);
  const manifest = JSON.parse(
    await fs.readFile(path.join(backupDir, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.format, 1);
  restoreProject = `${project}-restore`;
  // Reuse the tested immutable local image IDs, with separate target volume names.
  docker(["tag", `${project}-app:1.1.0`, `${restoreProject}-app:1.1.0`]);
  docker(["tag", `${project}-runner:1.1.0`, `${restoreProject}-runner:1.1.0`]);
  const restoreEnv = { COMPOSE_PROJECT_NAME: restoreProject };
  compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "-v",
      `${backupDir}:/backup:ro`,
      "admin",
      "restore",
    ],
    false,
    restoreEnv,
  );
  compose(["up", "-d", "--wait", "--wait-timeout", "180"], false, restoreEnv);
  await eventually(async () =>
    assert.equal((await api(`/api/sessions/${session.id}`)).id, session.id),
  );
  await languageSmoke(
    "javascript",
    "restored.js",
    'console.log("sterra-ä-restored");',
  );
  await languageSmoke(
    "python",
    "restored.py",
    'print("sterra-ä-restored-python")',
  );
  const changes = await api(`/api/workspaces/${session.id}/changes`);
  assert.ok(
    Array.isArray(changes) &&
      changes.some(
        (change) =>
          change.changeId === historyId && change.status === "applied",
      ),
    "Änderungshistorie nach Restore fehlt",
  );
  await api(
    `/api/workspaces/${session.id}/changes/${historyId}/undo`,
    "POST",
    {},
  );
  await api(
    `/api/workspaces/${session.id}/files/content?path=undo-fixture.txt`,
    "GET",
    undefined,
    404,
  );
  compose(["stop"], false, restoreEnv);
  importProject = `${project}-import`;
  const importEnv = { COMPOSE_PROJECT_NAME: importProject };
  docker(["tag", `${project}-app:1.1.0`, `${importProject}-app:1.1.0`]);
  docker(["tag", `${project}-runner:1.1.0`, `${importProject}-runner:1.1.0`]);
  importDir = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-legacy-"));
  const legacyId = randomUUID(),
    now = new Date().toISOString();
  await fs.mkdir(path.join(importDir, "sessions"));
  await fs.mkdir(path.join(importDir, "workspaces", "Alter Titel"), {
    recursive: true,
  });
  const legacy = JSON.stringify({
    id: legacyId,
    title: "Alter Titel",
    language: "javascript",
    schemaVersion: 1,
    editorSnapshot: 'console.log("sterra-ä-imported");',
    messages: [],
    createdAt: now,
    updatedAt: now,
  });
  await fs.writeFile(
    path.join(importDir, "sessions", `${legacyId}.json`),
    legacy,
  );
  await fs.writeFile(
    path.join(importDir, "workspaces", "Alter Titel", "main.js"),
    "// Originaldatei bleibt erhalten\n",
  );
  compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "-v",
      `${importDir}:/import:ro`,
      "admin",
      "import",
    ],
    false,
    importEnv,
  );
  const importKey = compose(
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
    importEnv,
  )
    .split(/\r?\n/)
    .at(-1);
  compose(["up", "-d", "--wait", "--wait-timeout", "180"], false, importEnv);
  cookie = "";
  await eventually(async () => api("/api/setup/status"));
  await api("/api/setup", "POST", {
    setupKey: importKey,
    password: "smoke-password-import",
  });
  const imported = await api(`/api/sessions/${legacyId}`);
  assert.equal(imported.schemaVersion, 2);
  const importedRun = await api("/api/execute", "POST", {
    sessionId: legacyId,
    file: imported.activeFile,
    language: "javascript",
  });
  assert.equal(importedRun.exitCode, 0);
  assert.match(importedRun.output, /sterra-ä-imported/);
  assert.equal(
    await fs.readFile(
      path.join(importDir, "sessions", `${legacyId}.json`),
      "utf8",
    ),
    legacy,
    "Import hat die Originalquelle verändert",
  );
  console.log(
    "Docker-Smoke erfolgreich: Health, Anmeldung, Ausführung, Bash/UTF-8, Persistenz, echte Wiederherstellung und Altdatenimport.",
  );
} catch (error) {
  console.error(error.stack);
  try {
    compose(["ps"]);
  } catch {}
  // No container logs: those could include package URLs or future application secrets.
  process.exitCode = 1;
} finally {
  if (process.env.STERRACODE_DOCKER_KEEP === "1") {
    console.log(
      JSON.stringify({
        retainedProjects: [project, restoreProject, importProject].filter(
          Boolean,
        ),
        backupDir,
        importDir,
      }),
    );
  } else {
    for (const name of [project, restoreProject, importProject].filter(
      Boolean,
    )) {
      try {
        compose(["down", "--volumes", "--remove-orphans"], false, {
          COMPOSE_PROJECT_NAME: name,
        });
      } catch {
        process.exitCode = 1;
      }
    }
    await fs.rm(backupDir, { recursive: true, force: true });
    if (importDir) await fs.rm(importDir, { recursive: true, force: true });
  }
}
