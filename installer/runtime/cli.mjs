import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { isIP } from "node:net";
import {
  validateRelease,
  updaterVersion,
  compareVersions,
} from "../../shared/releases.js";
import {
  atomic,
  readJSON,
  docker,
  compose,
  missingDockerObject,
} from "./io.mjs";
import { deployment, volumeKeys } from "./deployment.mjs";
import { migrate, waitForRunner } from "./migrate.mjs";
import { Controller } from "./controller.mjs";

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function verifyBackup() {
  const manifest = await readJSON("/backup/manifest.json");
  const seen = new Set();
  if (
    manifest.format !== 1 ||
    !manifest.offlinePackages ||
    !Array.isArray(manifest.archives)
  )
    throw new Error("Invalid offline backup.");
  for (const item of manifest.archives) {
    if (
      ![
        "app-data",
        "workspaces",
        "runner-state",
        "package-cache",
        "app-key",
        "runner-key",
      ].includes(item.volume) ||
      seen.has(item.volume) ||
      item.file !== `${item.volume}.tar` ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new Error("Invalid backup archive.");
    seen.add(item.volume);
    if (
      (await fs.stat(`/backup/${item.file}`)).size !== item.bytes ||
      (await digest(`/backup/${item.file}`)) !== item.sha256
    )
      throw new Error("Backup checksum mismatch.");
  }
  if (seen.size !== 6) throw new Error("Incomplete offline backup.");
  console.log("Backup checksums verified.");
}
async function space() {
  let bytes = 0;
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name),
        stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new Error("Unsupported file in backup source.");
      if (entry.isDirectory()) await walk(file);
      else bytes += stat.size;
    }
  }
  for (const dir of ["/data", "/workspaces", "/package-cache"]) await walk(dir);
  const stat = await fs.statfs("/data");
  if (stat.bavail * stat.bsize < bytes * 2.2 + 8 * 1024 ** 3)
    throw new Error(
      "Not enough Docker disk space for backup, recovery and images. Existing backups were retained.",
    );
}
async function volume(name, id, allowExisting = false) {
  let existing;
  try {
    [existing] = JSON.parse(await docker(["volume", "inspect", name]));
  } catch (error) {
    if (!missingDockerObject(error)) throw error;
  }
  if (existing) {
    if (
      !allowExisting ||
      existing.Labels?.["online.sterra.installation"] !== id
    )
      throw new Error(`Refusing an existing or foreign volume: ${name}`);
  } else
    await docker([
      "volume",
      "create",
      "--label",
      `online.sterra.installation=${id}`,
      name,
    ]);
}
async function launchUpdater(config, directory = "/installation") {
  const updaterName = `${config.project}-updater`;
  let old;
  try {
    [old] = JSON.parse(await docker(["inspect", updaterName]));
  } catch {
    /* New controller. */
  }
  if (old) {
    if (old.Config.Labels?.["online.sterra.installation"] !== config.id)
      throw new Error("Foreign updater container found.");
    await docker(["rm", "-f", updaterName]);
  }
  await atomic(`${directory}/installation.json`, config);
  await docker([
    "run",
    "-d",
    "--name",
    updaterName,
    "--restart",
    "unless-stopped",
    "--init",
    "--security-opt",
    "no-new-privileges:true",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "DAC_OVERRIDE",
    "--label",
    `online.sterra.installation=${config.id}`,
    "--network",
    `${config.project}_backend`,
    "--network-alias",
    "updater",
    "--mount",
    `type=bind,source=${config.hostDirectory},target=/installation`,
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-v",
    `${config.project}_updater-key:/run/updater:ro`,
    "-v",
    `${config.volumes["runner-key"]}:/run/runner:ro`,
    config.updaterImage,
    "serve",
  ]);
}
async function setup() {
  const directory = "/installation";
  const release = validateRelease(
    await readJSON(`${directory}/.download/release.json`),
  );
  if (
    (await digest(`${directory}/.download/installer.zip`)) !==
    release.packageSHA256
  )
    throw new Error("Installation package checksum mismatch.");
  if (compareVersions(updaterVersion, release.minUpdaterVersion) < 0)
    throw new Error("Bootstrap updater is too old.");
  const options = JSON.parse(process.env.STERRA_INSTALL_OPTIONS || "{}");
  const architecture = process.arch === "x64" ? "amd64" : process.arch;
  if (!release.architectures.includes(architecture))
    throw new Error(
      "This release is not approved for your Docker architecture.",
    );
  const stat = await fs.statfs(directory);
  if (stat.bavail * stat.bsize < 8 * 1024 ** 3)
    throw new Error(
      "At least 8 GiB of free installation disk space is required.",
    );
  let config = await readJSON(`${directory}/installation.json`, null);
  const migration = await readJSON(`${directory}/migration.json`, null);
  if (migration && !["succeeded", "failed"].includes(migration.phase))
    throw new Error("An interrupted import requires: manage migrate-recover");
  const fresh = !config;
  if (fresh) {
    const entries = await fs.readdir(directory);
    if (entries.some((name) => name !== ".download"))
      throw new Error(
        "Installation directory is not empty. Existing installations require the documented explicit migration procedure.",
      );
    const project = options.project || "sterracode";
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(project))
      throw new Error("Invalid Compose project name.");
    if (
      isIP(options.bindIP) !== 4 ||
      options.bindIP === "0.0.0.0" ||
      !Number.isInteger(options.port) ||
      options.port < 1 ||
      options.port > 65535
    )
      throw new Error("A concrete IPv4 address and valid port are required.");
    const existing = await docker([
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ]);
    if (existing)
      throw new Error(
        "An existing Compose project uses this name. Choose another project; no existing stack was changed.",
      );
    const id = randomUUID();
    const [self] = JSON.parse(await docker(["inspect", process.env.HOSTNAME]));
    const source = self.Mounts.find((m) => m.Destination === directory)?.Source;
    if (!source)
      throw new Error("Cannot resolve the Docker installation bind mount.");
    const windowsZones = await readJSON("/app/installer/windows-zones.json");
    const timeZone =
      windowsZones[options.timeZone] || options.timeZone || "UTC";
    new Intl.DateTimeFormat("en", { timeZone }).format();
    config = {
      schema: 1,
      id,
      project,
      architecture,
      hostDirectory: source,
      bindIP: options.bindIP,
      port: options.port,
      publicURL: `http://${options.bindIP}:${options.port}`,
      timeZone,
      release,
      updaterImage: release.images.updater,
      volumes: Object.fromEntries(
        volumeKeys.map((k) => [k, `${project}_${k}`]),
      ),
    };
    // Detect old source volumes before reserving an identity, so --project can be retried.
    for (const name of [
      ...Object.values(config.volumes),
      `${project}_updater-key`,
    ]) {
      let found = false;
      try {
        await docker(["volume", "inspect", name]);
        found = true;
      } catch (error) {
        if (!missingDockerObject(error)) throw error;
      }
      if (found)
        throw new Error(
          "An existing volume uses this project name. Choose another --project/-Project; no existing volumes were changed.",
        );
    }
    // Reserve identity before creating volumes, allowing a failed first install to resume.
    await atomic(`${directory}/installation.json`, config);
  } else {
    if (config.schema !== 1 || config.architecture !== architecture)
      throw new Error("Installation architecture/schema mismatch.");
    const updateState = await readJSON(`${directory}/updates.json`, {});
    if (
      updateState.operation &&
      !["succeeded", "failed", "deferred", "rolled-back"].includes(
        updateState.operation.phase,
      )
    )
      throw new Error(
        "An update/recovery is active. Resolve it before rerunning the installer.",
      );
    // Rerunning bootstraps only updates the independent updater, never application data.
    if (compareVersions(updaterVersion, config.release.minUpdaterVersion) < 0)
      throw new Error(
        "Updater is incompatible with the installed application.",
      );
    config.updaterImage = release.images.updater;
  }
  if (!fresh) {
    let old;
    try {
      [old] = JSON.parse(
        await docker(["inspect", `${config.project}-updater`]),
      );
    } catch (error) {
      if (!missingDockerObject(error)) throw error;
    }
    if (old) {
      if (old.Config.Labels?.["online.sterra.installation"] !== config.id)
        throw new Error("Foreign updater container found.");
      await docker(["stop", `${config.project}-updater`]);
      const state = await readJSON(`${directory}/updates.json`, {});
      if (
        state.operation &&
        !["succeeded", "failed", "deferred", "rolled-back"].includes(
          state.operation.phase,
        )
      ) {
        await docker(["start", `${config.project}-updater`]);
        throw new Error(
          "An update started during setup. Wait for it to finish before replacing the updater.",
        );
      }
      config = await readJSON(`${directory}/installation.json`);
      if (compareVersions(updaterVersion, config.release.minUpdaterVersion) < 0)
        throw new Error(
          "Updater is incompatible with the installed application.",
        );
      config.updaterImage = release.images.updater;
    }
  }
  for (const name of Object.values(config.volumes))
    await volume(name, config.id, !fresh);
  await volume(`${config.project}_updater-key`, config.id, !fresh);
  await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${config.project}_updater-key:/run/updater`,
    "--entrypoint",
    "node",
    config.updaterImage,
    "/app/installer/runtime/cli.mjs",
    "make-key",
  ]);
  for (const kind of ["app", "runner"])
    await docker(["pull", config.release.images[kind]]);
  await atomic(
    `${directory}/compose.json`,
    deployment(config, config.release, config.volumes),
  );
  await compose(directory, config.project, ["config", "--quiet"]);
  await compose(directory, config.project, [
    "run",
    "--rm",
    "--no-deps",
    "init",
  ]);
  // Setup-key is a credential; it is displayed only here, never written to updater logs.
  const key = await compose(directory, config.project, [
    "run",
    "--rm",
    "--no-deps",
    "-e",
    "STERRACODE_ADMIN_ENGLISH=1",
    "--user",
    "10001:10001",
    "--entrypoint",
    "node",
    "app",
    "docker/admin.mjs",
    "setup-key",
  ]);
  if (/^[A-Za-z0-9_-]{43}$/.test(key.trim()))
    console.log(
      `Setup key (valid for 30 minutes; keep private): ${key.trim()}`,
    );
  else if (fresh)
    console.log("Open the application to complete administrator setup.");
  await compose(directory, config.project, [
    "up",
    "-d",
    "--no-build",
    "--wait",
    "--wait-timeout",
    "600",
    "app",
    "runner",
  ]);
  await waitForRunner(directory, config);
  await launchUpdater(config);
  for (const file of ["manage.sh", "manage.ps1"])
    await fs.copyFile(`/app/installer/${file}`, `${directory}/${file}`);
  const owner = await fs.stat(directory);
  for (const file of ["manage.sh", "manage.ps1"])
    await fs.chown(`${directory}/${file}`, owner.uid, owner.gid);
  await fs.chmod(`${directory}/manage.sh`, 0o700);
  await fs.rename(
    `${directory}/.download/installer.zip`,
    `${directory}/installer-${release.version}.zip`,
  );
  console.log(
    `SterraCode is ready: ${config.publicURL}\nManage this installation with manage.sh or manage.ps1.\nThe updater has Docker daemon access; app and runner do not. Automatic updates are opt-in; existing settings are preserved.`,
  );
}
const action = process.argv[2];
try {
  if (action === "serve") await (await import("./server.mjs")).startUpdater();
  else if (action === "setup") await setup();
  else if (action === "recover") {
    const directory = "/installation";
    const config = await readJSON(`${directory}/installation.json`);
    const state = await readJSON(`${directory}/updates.json`);
    if (state.operation?.phase !== "recovery-failed")
      throw new Error("The installation is not waiting for manual recovery.");
    let old;
    try {
      [old] = JSON.parse(
        await docker(["inspect", `${config.project}-updater`]),
      );
    } catch (error) {
      if (!missingDockerObject(error)) throw error;
    }
    if (old && old.Config.Labels?.["online.sterra.installation"] !== config.id)
      throw new Error("Foreign updater container found.");
    if (old) await docker(["stop", `${config.project}-updater`]);
    try {
      const controller = new Controller(directory);
      await controller.initialize();
      await controller.owned();
      await controller.retryRecovery();
      await launchUpdater(controller.config);
      console.log(
        "Recovery completed. Automatic updates are paused; verify your workspace before enabling them again.",
      );
    } catch (error) {
      if (old)
        await docker(["start", `${config.project}-updater`]).catch(() => {});
      throw error;
    }
  } else if (["migrate", "migrate-recover"].includes(action))
    await migrate(
      "/installation",
      launchUpdater,
      verifyBackup,
      action === "migrate-recover",
    );
  else if (action === "verify-backup") await verifyBackup();
  else if (action === "space") await space();
  else if (action === "make-key") {
    await fs.mkdir("/run/updater", { recursive: true });
    try {
      await fs.writeFile("/run/updater/key", randomBytes(32).toString("hex"), {
        flag: "wx",
        mode: 0o400,
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await fs.chown("/run/updater/key", 10001, 10001);
    await fs.chmod("/run/updater", 0o755);
  } else if (["status", "check", "install"].includes(action)) {
    const key = (await fs.readFile("/run/updater/key", "utf8")).trim();
    const response = await fetch(`http://127.0.0.1:3002/${action}`, {
      method: action === "status" ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(45000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    console.log(JSON.stringify(result, null, 2));
  } else
    throw new Error(
      "Supported actions: serve, setup, status, check, install, recover, migrate, migrate-recover, verify-backup.",
    );
} catch (error) {
  console.error(`SterraCode: ${error.message}`);
  process.exitCode = 1;
}
