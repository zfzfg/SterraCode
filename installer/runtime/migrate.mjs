import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Controller } from "./controller.mjs";
import { atomic, readJSON, docker, compose } from "./io.mjs";
import { deployment, volumeKeys } from "./deployment.mjs";

export async function waitForRunner(directory, config, run = docker) {
  const code =
    "(async()=>{const fs=require('node:fs');const key=fs.readFileSync('/run/secrets/runner_key','utf8').trim();const end=Date.now()+600000;while(Date.now()<end){const r=await fetch('http://127.0.0.1:3001/v1/status',{headers:{authorization:'Bearer '+key,'X-Runner-Protocol':'1'},signal:AbortSignal.timeout(10000)});const s=await r.json();if(s.error)throw new Error('Runner restoration failed');if(s.status==='ready'&&s.protocolVersion===1)return;await new Promise(r=>setTimeout(r,3000));}throw new Error('Runner restoration timed out');})().catch(e=>{console.error(e.message);process.exit(1)})";
  await compose(
    directory,
    config.project,
    ["exec", "-T", "runner", "node", "-e", code],
    run,
  );
}

export async function migrate(
  directory,
  launchUpdater,
  verifyBackup,
  recoverOnly = false,
  run = docker,
) {
  let config = await readJSON(path.join(directory, "installation.json"));
  const controller = new Controller(directory, { run });
  controller.config = config;
  await controller.owned();
  const file = path.join(directory, "migration.json");
  let journal = await readJSON(file, null);
  if (
    !recoverOnly &&
    journal &&
    !["succeeded", "failed"].includes(journal.phase)
  )
    throw new Error("An interrupted import requires: manage migrate-recover");
  if (
    recoverOnly &&
    (!journal || ["succeeded", "failed"].includes(journal.phase))
  )
    throw new Error("No interrupted import to recover.");
  const updaterName = `${config.project}-updater`;
  let updater;
  try {
    [updater] = JSON.parse(await run(["inspect", updaterName]));
  } catch {
    /* An interrupted controller replacement can leave no container. */
  }
  if (
    updater &&
    updater.Config.Labels?.["online.sterra.installation"] !== config.id
  )
    throw new Error("Updater identity mismatch.");
  const assertIdle = async () => {
    const state = await readJSON(path.join(directory, "updates.json"), {});
    if (
      state.operation &&
      !["succeeded", "failed", "deferred", "rolled-back"].includes(
        state.operation.phase,
      )
    )
      throw new Error("Resolve the active update/recovery before migrating.");
  };
  await assertIdle();
  if (updater) await run(["stop", updaterName]);
  try {
    await assertIdle();
  } catch (error) {
    if (updater) await run(["start", updaterName]);
    throw error;
  }
  const restoreOriginal = async () => {
    await compose(directory, config.project, ["stop", "app", "runner"], run);
    config = journal.before;
    await atomic(
      path.join(directory, "compose.json"),
      deployment(config, config.release, config.volumes),
    );
    await atomic(path.join(directory, "installation.json"), config);
    await compose(
      directory,
      config.project,
      [
        "up",
        "-d",
        "--no-build",
        "--wait",
        "--wait-timeout",
        "600",
        "app",
        "runner",
      ],
      run,
    );
    await waitForRunner(directory, config, run);
    journal.phase = "failed";
    await atomic(file, journal);
    await launchUpdater(config);
  };
  if (recoverOnly) {
    await restoreOriginal();
    console.log(
      "Original managed volumes restored. Imported/partial volumes were retained.",
    );
    return;
  }
  journal = null;
  try {
    await verifyBackup();
    const [self] = JSON.parse(await run(["inspect", process.env.HOSTNAME]));
    const backup = self.Mounts.find((m) => m.Destination === "/backup");
    if (!backup || backup.RW || !["volume", "bind"].includes(backup.Type))
      throw new Error("Mount the offline backup read-only at /backup.");
    const id = randomUUID();
    journal = {
      id,
      phase: "preparing",
      before: structuredClone(config),
      volumes: Object.fromEntries(
        volumeKeys.map((k) => [k, `${config.project}_import_${id}_${k}`]),
      ),
    };
    await atomic(file, journal);
    for (const name of Object.values(journal.volumes))
      await controller.createVolume(name);
    const imported = { ...config, volumes: journal.volumes };
    await atomic(
      path.join(directory, "import.compose.json"),
      deployment(imported, imported.release, imported.volumes),
    );
    await compose(directory, config.project, ["stop", "app", "runner"], run);
    journal.phase = "restoring";
    await atomic(file, journal);
    await compose(
      directory,
      config.project,
      [
        "run",
        "--rm",
        "--no-deps",
        "-v",
        `${backup.Type === "volume" ? backup.Name : backup.Source}:/backup:ro`,
        "admin",
        "restore",
      ],
      run,
      "import.compose.json",
    );
    await atomic(
      path.join(directory, "compose.json"),
      deployment(imported, imported.release, imported.volumes),
    );
    await compose(
      directory,
      config.project,
      [
        "up",
        "-d",
        "--no-build",
        "--wait",
        "--wait-timeout",
        "600",
        "app",
        "runner",
      ],
      run,
    );
    await waitForRunner(directory, imported, run);
    await atomic(path.join(directory, "installation.json"), imported);
    journal.phase = "succeeded";
    await atomic(file, journal);
    await launchUpdater(imported);
    console.log(
      "Offline backup imported. Original source and previous managed volumes were retained. Open an old session and verify a real program run.",
    );
  } catch (error) {
    if (journal?.before) await restoreOriginal();
    else if (updater) await run(["start", updaterName]);
    else await launchUpdater(config);
    throw error;
  }
}
