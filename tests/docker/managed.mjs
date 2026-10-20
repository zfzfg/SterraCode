// Native Linux acceptance against the exact provisional registry digests. No live data.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { Controller } from "../../installer/runtime/controller.mjs";
import { docker, readJSON } from "../../installer/runtime/io.mjs";
import { validateRelease } from "../../shared/releases.js";

const project = `sterra-managed-${randomUUID().slice(0, 8)}`;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-managed-"));
const images = JSON.parse(
  await fs.readFile(process.env.STERRACODE_MANAGED_IMAGES, "utf8"),
);
const version = JSON.parse(
  await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"),
).version;
const arch = process.arch === "x64" ? "amd64" : process.arch;
const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const archive = Buffer.from(
  "Managed installation acceptance fixture; no executable package content.",
);
const release = (v) =>
  validateRelease({
    schema: 1,
    version: v,
    minUpdaterVersion: "1.0.0",
    protocol: 1,
    architectures: [arch],
    upgradeFrom: ["0.0.0", version],
    images,
    packageSHA256: createHash("sha256").update(archive).digest("hex"),
    packageURL: `https://github.com/zfzfg/SterraCode/releases/download/v${v}/installer.zip`,
  });
let config;
try {
  await fs.mkdir(path.join(directory, ".download"));
  await fs.writeFile(
    path.join(directory, ".download/release.json"),
    JSON.stringify(release("0.0.0")),
  );
  await fs.writeFile(path.join(directory, ".download/installer.zip"), archive);
  await docker([
    "run",
    "--rm",
    "--init",
    "--mount",
    `type=bind,source=${directory},target=/installation`,
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-e",
    `STERRA_INSTALL_OPTIONS=${JSON.stringify({ project, bindIP: "127.0.0.1", port, timeZone: "Europe/Berlin" })}`,
    images.updater,
    "setup",
  ]);
  config = await readJSON(path.join(directory, "installation.json"));
  await docker(["stop", `${project}-updater`]);
  const controller = new Controller(directory, {
    fetchRelease: async () => release(version),
  });
  await controller.initialize();
  // Execute service requests inside the private network; keys never leave their volumes.
  const request = async (service, route, action) => {
    const updater = service === "app";
    const code = `const fs=await import('node:fs/promises');const key=(await fs.readFile('/key/${updater ? "key" : "runner_key"}','utf8')).trim();const response=await fetch(${JSON.stringify(`http://${service}:${updater ? 3000 : 3001}/${route}`)},{method:${JSON.stringify(action ? "POST" : "GET")},headers:{authorization:'Bearer '+key,'Content-Type':'application/json','X-Runner-Protocol':'1'},${action ? `body:${JSON.stringify(JSON.stringify(updater ? { action } : {}))},` : ""}signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Service request failed: '+response.status);console.log(JSON.stringify(await response.json()));`;
    return JSON.parse(
      await docker([
        "run",
        "--rm",
        "--network",
        `${project}_backend`,
        "-v",
        `${updater ? `${project}_updater-key` : config.volumes["runner-key"]}:/key:ro`,
        "--entrypoint",
        "node",
        images.updater,
        "--input-type=module",
        "-e",
        code,
      ]),
    );
  };
  controller.internal = (action) => request("app", "internal/updates", action);
  controller.runner = async (route, method = "GET") => {
    if (method === "DELETE") {
      // Old runner maintenance is cleared by container replacement on success/rollback.
      return { status: "ready" };
    }
    return request(
      "runner",
      `v1/${route}`,
      method === "POST" ? "maintenance" : undefined,
    );
  };
  await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${config.volumes["app-data"]}:/data`,
    "--entrypoint",
    "node",
    images.updater,
    "-e",
    "require('node:fs').writeFileSync('/data/managed-update-marker','preserve-me')",
  ]);
  await controller.check(true);
  await controller.install();
  await controller.task;
  assert.equal(controller.status().operation.phase, "succeeded");
  assert.equal(controller.config.release.version, version);
  // Install the same binaries under a deliberately wrong version to force post-migration rollback.
  const [major, minor, patch] = version.split(".").map(Number);
  controller.state.release = release(`${major}.${minor}.${patch + 1}`);
  await controller.install();
  await controller.task;
  assert.equal(controller.status().operation.phase, "rolled-back");
  assert.notEqual(
    controller.config.volumes["app-data"],
    config.volumes["app-data"],
  );
  assert.equal(
    await docker([
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${controller.config.volumes["app-data"]}:/data:ro`,
      "--entrypoint",
      "node",
      images.updater,
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('/data/managed-update-marker'))",
    ]),
    "preserve-me",
  );
  await docker([
    "run",
    "--rm",
    "--init",
    "--mount",
    `type=bind,source=${directory},target=/installation`,
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-v",
    `${controller.state.operation.backup}:/backup:ro`,
    images.updater,
    "migrate",
  ]);
  const imported = await readJSON(path.join(directory, "installation.json"));
  assert.ok(imported.volumes["app-data"].includes("_import_"));
  assert.equal(
    await docker([
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${imported.volumes["app-data"]}:/data:ro`,
      "--entrypoint",
      "node",
      images.updater,
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('/data/managed-update-marker'))",
    ]),
    "preserve-me",
  );
  console.log(
    `Managed native ${arch} install, update, offline backup, rollback and explicit import passed.`,
  );
} finally {
  config ||= await readJSON(path.join(directory, "installation.json"), null);
  // Only delete resources belonging to this randomly named acceptance project/identity.
  const containers = (
    await docker([
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ])
  )
    .split(/\s+/)
    .filter(Boolean);
  if (config?.id)
    containers.push(
      ...(
        await docker([
          "ps",
          "-aq",
          "--filter",
          `label=online.sterra.installation=${config.id}`,
        ])
      )
        .split(/\s+/)
        .filter(Boolean),
    );
  for (const id of new Set(containers)) await docker(["rm", "-f", id]);
  if (config?.id)
    for (const name of (
      await docker([
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=online.sterra.installation=${config.id}`,
      ])
    )
      .split(/\s+/)
      .filter(Boolean)) {
      assert.ok(name.startsWith(project + "_"));
      await docker(["volume", "rm", name]);
    }
  await docker(["network", "rm", `${project}_backend`]).catch(() => {});
  await fs.rm(directory, { recursive: true, force: true });
}
