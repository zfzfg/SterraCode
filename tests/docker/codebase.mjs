import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

// This acceptance owns only randomly named Compose projects and new volumes.
// It never contacts a model or modifies an existing deployment.
const root = fileURLToPath(new URL("../../", import.meta.url));
const version = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
).version;
const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], {
  encoding: "utf8",
  windowsHide: true,
});
if (info.status !== 0 || info.stdout.trim() !== "linux") {
  const required =
    process.env.CI || process.env.STERRACODE_DOCKER_REQUIRED === "1";
  console.log(
    `${required ? "ERROR" : "SKIPPED"}: Codebase acceptance requires a Linux Docker daemon.`,
  );
  process.exit(required ? 1 : 0);
}
const project = `sterra-codebase-${randomUUID().slice(0, 8)}`;
const restored = `${project}-restore`;
const backup = await fs.mkdtemp(
  path.join(os.tmpdir(), "sterra-codebase-backup-"),
);
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  STERRACODE_VERSION: version,
  STERRACODE_BUILD_VERSION: version,
  STERRACODE_PUBLIC_URL: base,
  STERRACODE_PORT: String(port),
  STERRACODE_BIND_IP: "127.0.0.1",
  STERRACODE_PROXY_MODE: "off",
  STERRACODE_INITIAL_PROGRAMS: "",
};
function docker(args, { capture = false, projectName = project } = {}) {
  const result = spawnSync("docker", args, {
    cwd: root,
    env: { ...environment, COMPOSE_PROJECT_NAME: projectName },
    encoding: "utf8",
    windowsHide: true,
    stdio: capture ? "pipe" : "inherit",
    timeout: 30 * 60000,
    maxBuffer: 16 * 1024 ** 2,
  });
  if (result.status !== 0)
    throw new Error(
      `Docker operation failed: ${args.slice(0, 4).join(" ")} ${result.stderr || result.error?.message || ""}`,
    );
  return result.stdout?.trim();
}
function compose(args, options) {
  return docker(
    ["compose", "-f", "compose.yaml", "-f", "compose.lan.yaml", ...args],
    options,
  );
}
let cookie = "";
async function api(
  endpoint,
  { method = "GET", body, expected = 200, raw = false } = {},
) {
  const response = await fetch(base + endpoint, {
    method,
    headers: {
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined
        ? {}
        : { "Content-Type": raw ? "application/zip" : "application/json" }),
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
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
async function eventually(operation, timeout = 120000) {
  let error;
  const deadline = Date.now() + timeout;
  do {
    try {
      return await operation();
    } catch (e) {
      error = e;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  throw error;
}
function archive(files) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const [relative, content] of Object.entries(files)) {
    const name = Buffer.from(relative),
      data = Buffer.from(content),
      crc = crc32(data),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
async function prepare(files) {
  const job = await api("/api/codebase/imports", {
    method: "POST",
    body: {
      operationId: randomUUID(),
      source: { kind: "zip" },
      title: "Container codebase fixture",
      tutorLocale: "en",
    },
    expected: 202,
  });
  return api(`/api/codebase/imports/${job.id}/upload`, {
    method: "PUT",
    body: archive(files),
    raw: true,
    expected: 202,
  });
}
const seed = ({ sessionId, analysisId, version }) => `
import {writeJSON,DATA_DIR} from './server/services/storage.js';
import path from 'node:path';
const id=${JSON.stringify(sessionId)},analysisId=${JSON.stringify(analysisId)};
const ref={id:'source_1',sessionId:id,path:'README.md',startLine:1,endLine:2,fileVersion:${JSON.stringify(version)}};
const result={schemaVersion:1,sessionId:id,analysisId,purpose:{text:'Acceptance fixture',inferred:false,references:['source_1']},references:[ref],modules:[],entryPoints:[],flows:[],tour:[{id:'readme',title:'Read the source',goal:'Inspect the README',prerequisites:'',question:'What does it do?',references:['source_1']}],uncertainties:[],coverage:{examinedFiles:['README.md'],totalFiles:2,partial:true},manifestDigest:'acceptance-fixture'};
const root=path.join(DATA_DIR,'codebases',id);
await writeJSON(path.join(root,'analyses',analysisId+'.json'),{analysisId,sessionId:id,status:'completed',phase:'completed',sequence:1,result});
await writeJSON(path.join(root,'state.json'),{currentAnalysisId:analysisId,runningAnalysisId:null});
console.log('fixture-persisted');`;

try {
  console.log(`Codebase container acceptance: ${project}.`);
  compose(["config", "--quiet"]);
  if (
    process.env.STERRACODE_TEST_APP_IMAGE &&
    process.env.STERRACODE_TEST_RUNNER_IMAGE
  ) {
    docker([
      "tag",
      process.env.STERRACODE_TEST_APP_IMAGE,
      `${project}-app:${version}`,
    ]);
    docker([
      "tag",
      process.env.STERRACODE_TEST_RUNNER_IMAGE,
      `${project}-runner:${version}`,
    ]);
  } else compose(["build"]);
  compose(["run", "--rm", "--no-deps", "init"]);
  const key = compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "app",
      "node",
      "docker/admin.mjs",
      "setup-key",
    ],
    { capture: true },
  )
    .split(/\r?\n/)
    .at(-1);
  assert.match(key, /^[A-Za-z0-9_-]{40,}$/);
  compose(["up", "-d", "--wait", "--wait-timeout", "180"]);
  await api("/api/codebase/imports", { expected: 401 });
  await api("/api/setup", {
    method: "POST",
    body: { setupKey: key, password: "container-codebase-fixture-password" },
  });
  let job = await prepare({
    "project/README.md": "# UTF-8 codebase\nGrüße from the container.\n",
    "project/lib.xyz": "export const hello = 'hello';\n",
    "project/node_modules/dependency.js": "excluded",
    "project/.env": "SYNTHETIC_MUST_NOT_PUBLISH",
  });
  assert.equal(job.summary.selectedFiles, 2);
  const preview = await api(
    `/api/codebase/imports/${job.id}/preview?path=project%2FREADME.md`,
  );
  assert.match(preview.content, /Grüße/);
  job = await api(`/api/codebase/imports/${job.id}/selection`, {
    method: "PATCH",
    body: {
      manifestVersion: job.manifestVersion,
      selectionVersion: job.selectionVersion,
      rootMapping: "project",
    },
  });
  const request = {
    manifestVersion: job.manifestVersion,
    selectionVersion: job.selectionVersion,
    selectionDigest: job.selectionDigest,
  };
  await api(`/api/codebase/imports/${job.id}/commit`, {
    method: "POST",
    body: request,
    expected: 202,
  });
  job = await eventually(async () => {
    const state = await api(`/api/codebase/imports/${job.id}`);
    assert.equal(state.state, "completed", JSON.stringify(state.error));
    return state;
  });
  const sessionId = job.sessionId;
  const duplicate = await api(`/api/codebase/imports/${job.id}/commit`, {
    method: "POST",
    body: request,
    expected: 202,
  });
  assert.equal(duplicate.sessionId, sessionId);
  assert.equal(
    (await api("/api/sessions")).filter((session) => session.id === sessionId)
      .length,
    1,
  );
  const session = await api(`/api/sessions/${sessionId}`);
  assert.equal(session.mode, "codebase");
  assert.equal(session.language, null);
  assert.deepEqual(session.messages, []);
  const current = await api(
    `/api/codebase/sessions/${sessionId}/analyses/current`,
  );
  assert.equal(current.analysis, null);
  assert.equal(current.job, null);
  const tree = await api(`/api/codebase/sessions/${sessionId}/tree?limit=1`);
  assert.equal(tree.entries.length, 1);
  assert.ok(tree.nextCursor);
  await api(`/api/workspaces/${sessionId}/files/content?path=.env`, {
    expected: 404,
  });
  const file = await api(
    `/api/workspaces/${sessionId}/files/content?path=README.md`,
  );
  assert.match(file.content, /Grüße/);
  const reference = new URLSearchParams({
    sessionId,
    path: "README.md",
    startLine: "1",
    endLine: "2",
    fileVersion: file.version,
  });
  assert.equal(
    (
      await api(
        `/api/codebase/sessions/${sessionId}/references/resolve?${reference}`,
      )
    ).current,
    true,
  );
  const analysisId = randomUUID();
  compose([
    "exec",
    "-T",
    "app",
    "node",
    "--input-type=module",
    "-e",
    seed({ sessionId, analysisId, version: file.version }),
  ]);
  const published = await api(
    `/api/codebase/sessions/${sessionId}/analyses/current`,
  );
  assert.equal(published.analysis.analysisId, analysisId);
  const tour = await api(`/api/codebase/sessions/${sessionId}/tour`, {
    method: "PATCH",
    body: {
      analysisId,
      stepId: "readme",
      action: "visit",
      expectedVersion: published.tour.version,
    },
  });
  assert.deepEqual(tour.visitedStepIds, ["readme"]);
  const waiting = await prepare({
    "readme.txt": "Quarantine excluded from backups",
  });
  compose(["stop"]);
  const images = compose(["images", "--format", "json"], { capture: true });
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
    `${backup}:/backup`,
    "admin",
    "backup",
    "--offline",
  ]);
  const manifest = JSON.parse(
    await fs.readFile(path.join(backup, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.format, 1);
  docker(["tag", `${project}-app:${version}`, `${restored}-app:${version}`]);
  docker([
    "tag",
    `${project}-runner:${version}`,
    `${restored}-runner:${version}`,
  ]);
  compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "-v",
      `${backup}:/backup:ro`,
      "admin",
      "restore",
    ],
    { projectName: restored },
  );
  compose(["up", "-d", "--wait", "--wait-timeout", "180"], {
    projectName: restored,
  });
  const restoredAnalysis = await eventually(async () =>
    api(`/api/codebase/sessions/${sessionId}/analyses/current`),
  );
  assert.equal(restoredAnalysis.analysis.analysisId, analysisId);
  assert.deepEqual(restoredAnalysis.tour.visitedStepIds, ["readme"]);
  assert.equal(
    (await api(`/api/workspaces/${sessionId}/files/content?path=README.md`))
      .version,
    file.version,
  );
  assert.equal(
    (await api(`/api/codebase/imports/${waiting.id}`)).state,
    "expired",
  );
  await api(`/api/sessions/${sessionId}`, { method: "DELETE", body: {} });
  await api(`/api/sessions/${sessionId}`, { expected: 404 });
  console.log(
    "Codebase acceptance passed: authenticated ZIP, selection, UTF-8, no automatic model call, references, idempotency, persisted fixture/tour, offline backup/restore, quarantine expiry and deletion. Analysis fixture was seeded; provider generation is covered by mock-provider tests.",
  );
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
  try {
    compose(["ps"]);
  } catch {}
} finally {
  for (const name of [project, restored])
    try {
      compose(["down", "--volumes", "--remove-orphans"], { projectName: name });
    } catch {
      process.exitCode = 1;
    }
  if (path.resolve(backup).startsWith(path.resolve(os.tmpdir()) + path.sep))
    await fs.rm(backup, { recursive: true, force: true });
}
