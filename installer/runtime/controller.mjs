import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  latestRelease,
  updateAllowed,
  validateRelease,
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

export function validateSettings(value) {
  if (
    !value ||
    typeof value.enabled !== "boolean" ||
    !Number.isInteger(value.hour) ||
    value.hour < 0 ||
    value.hour > 23 ||
    typeof value.timeZone !== "string" ||
    Object.keys(value).some((k) => !["enabled", "hour", "timeZone"].includes(k))
  )
    throw new Error("Invalid automatic update settings.");
  new Intl.DateTimeFormat("en", { timeZone: value.timeZone }).format();
  return { enabled: value.enabled, hour: value.hour, timeZone: value.timeZone };
}
export function inWindow(settings, date = new Date()) {
  return (
    Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: settings.timeZone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(date),
    ) === settings.hour
  );
}
const terminal = new Set([
  "succeeded",
  "failed",
  "deferred",
  "rolled-back",
  "recovery-failed",
]);
export class Controller {
  constructor(
    directory,
    {
      run = docker,
      fetchRelease = latestRelease,
      sleep = delay,
      now = () => Date.now(),
      request = fetch,
    } = {},
  ) {
    this.directory = directory;
    this.run = run;
    this.fetchRelease = fetchRelease;
    this.sleep = sleep;
    this.now = now;
    this.request = request;
    this.leases = new Map();
    this.automaticEligibleAt = this.now() + 90000;
    this.checkPromise = null;
    this.persistQueue = Promise.resolve();
    this.task = null;
  }
  async initialize() {
    const migration = await readJSON(
      path.join(this.directory, "migration.json"),
      null,
    );
    if (migration && !["succeeded", "failed"].includes(migration.phase))
      throw new Error("An interrupted import requires: manage migrate-recover");
    this.config = await readJSON(
      path.join(this.directory, "installation.json"),
    );
    this.state = await readJSON(path.join(this.directory, "updates.json"), {
      checkedAt: 0,
      release: null,
      operation: null,
      settings: { enabled: false, hour: 4, timeZone: this.config.timeZone },
    });
    validateSettings(this.state.settings);
    if (this.state.release) validateRelease(this.state.release);
    if (this.state.operation && !terminal.has(this.state.operation.phase)) {
      this.task = this.recover().finally(() => {
        this.task = null;
      });
      await this.task;
    }
  }
  persist() {
    const snapshot = structuredClone(this.state);
    const write = this.persistQueue.then(() =>
      atomic(path.join(this.directory, "updates.json"), snapshot),
    );
    this.persistQueue = write.catch(() => {});
    return write;
  }
  compose(args, file) {
    return compose(this.directory, this.config.project, args, this.run, file);
  }
  async owned() {
    for (const name of Object.values(this.config.volumes)) {
      const [volume] = JSON.parse(await this.run(["volume", "inspect", name]));
      if (volume.Labels?.["online.sterra.installation"] !== this.config.id)
        throw new Error("Volume ownership mismatch. Installation stopped.");
    }
  }
  status() {
    const release = this.state.release;
    return {
      installed: this.config.release.version,
      managed: true,
      available: Boolean(
        release &&
        compareVersions(release.version, this.config.release.version) > 0,
      ),
      installable: Boolean(
        release &&
        updateAllowed(
          this.config.release.version,
          release,
          this.config.architecture,
        ),
      ),
      latest: release?.version || null,
      notesURL: release?.notesURL || null,
      checkedAt: this.state.checkedAt,
      error: this.state.error || null,
      settings: this.state.settings,
      operation: this.state.operation
        ? {
            id: this.state.operation.id,
            phase: this.state.operation.phase,
            error: this.state.operation.error || null,
            recoveryCommand:
              this.state.operation.phase === "recovery-failed"
                ? ["bash manage.sh recover", ".\\manage.ps1 recover"]
                : null,
          }
        : null,
    };
  }
  async check(force = false) {
    if (this.checkPromise) return this.checkPromise;
    if (
      !force &&
      this.now() - this.state.checkedAt <
        (this.state.error ? 15 * 60000 : 6 * 60 * 60000)
    )
      return this.status();
    this.checkPromise = (async () => {
      try {
        this.state.release = await this.fetchRelease();
        this.state.error = null;
      } catch {
        this.state.error =
          "Release check unavailable. Your installation continues to work.";
      }
      this.state.checkedAt = this.now();
      await this.persist();
      return this.status();
    })().finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }
  async settings(value) {
    this.state.settings = validateSettings(value);
    await this.persist();
    return this.status();
  }
  activity(value) {
    if (
      !value ||
      !/^[a-f0-9-]{36}$/.test(value.id) ||
      typeof value.busy !== "boolean" ||
      typeof value.dirty !== "boolean"
    )
      throw new Error("Invalid browser activity.");
    for (const [key, lease] of this.leases)
      if (lease.until < this.now()) this.leases.delete(key);
    if (!this.leases.has(value.id) && this.leases.size >= 1000)
      throw new Error("Too many browser leases.");
    this.leases.set(value.id, {
      busy: value.busy,
      dirty: value.dirty,
      until: this.now() + 90000,
    });
    return { ok: true };
  }
  browserBusy(automatic) {
    return [...this.leases.values()].some(
      (v) => v.until > this.now() && (v.dirty || (automatic && v.busy)),
    );
  }
  async tick() {
    if (!this.task && this.state.operation?.phase !== "recovery-failed") {
      await this.internal("resume").catch(() => {});
    }
    await this.check();
    if (
      !this.state.settings.enabled ||
      this.state.operation?.phase === "recovery-failed" ||
      this.now() < this.automaticEligibleAt ||
      !inWindow(this.state.settings) ||
      this.task ||
      !this.status().installable ||
      this.browserBusy(true)
    )
      return;
    // One automatic attempt per release and local calendar day, including DST repeats.
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.state.settings.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const attempt = `${this.state.release.version}:${day}`;
    if (this.state.automaticAttempt === attempt) return;
    this.state.automaticAttempt = attempt;
    await this.persist();
    await this.install(true);
  }
  async install(automatic = false) {
    if (this.task) return this.status();
    if (this.state.operation?.phase === "recovery-failed")
      throw new Error("Manual recovery is required before another update.");
    if (!this.status().installable)
      throw new Error(
        "No compatible update. Run the local installer to upgrade the updater if required.",
      );
    // Reserve synchronously before the first await so concurrent requests coalesce.
    const operation = {
      id: randomUUID(),
      phase: "preflight",
      automatic,
      target: structuredClone(this.state.release),
      before: structuredClone(this.config),
      startedAt: this.now(),
    };
    this.state.operation = operation;
    this.task = this.perform(operation).finally(() => {
      this.task = null;
    });
    // HTTP callers receive an operation ID before application containers stop.
    this.task.catch(() => {});
    return this.status();
  }
  async phase(value) {
    this.state.operation.phase = value;
    await this.persist();
  }
  async internal(action) {
    const key = (await fs.readFile("/run/updater/key", "utf8")).trim();
    const response = await this.request("http://app:3000/internal/updates", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error("Application maintenance endpoint unavailable.");
    return response.json();
  }
  async runner(route, method = "GET") {
    const key = (await fs.readFile("/run/runner/runner_key", "utf8")).trim();
    const response = await this.request(`http://runner:3001/v1/${route}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        "X-Runner-Protocol": "1",
        "Content-Type": "application/json",
      },
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || response.headers.get("x-runner-protocol") !== "1")
      throw new Error("Runner maintenance endpoint unavailable.");
    return response.json();
  }
  async unlock() {
    await this.internal("resume");
    const programs = await this.runner("programs");
    if (!programs.activeJob) await this.runner("maintenance", "DELETE");
  }
  async drain(operation) {
    const deadline = this.now() + 30 * 60000;
    while (this.now() < deadline) {
      const app = await this.internal("drain");
      await this.runner("maintenance", "POST");
      const runner = await this.runner("status");
      const programs = await this.runner("programs");
      if (
        !app.busy &&
        !runner.activeJobs.length &&
        !programs.activeJob &&
        !this.browserBusy(operation.automatic)
      )
        return true;
      await this.sleep(3000);
    }
    return false;
  }
  async createVolume(name) {
    try {
      await this.run(["volume", "inspect", name]);
      throw new Error("Recovery/backup volume already exists.");
    } catch (error) {
      if (!missingDockerObject(error)) throw error;
    }
    await this.run([
      "volume",
      "create",
      "--label",
      `online.sterra.installation=${this.config.id}`,
      name,
    ]);
  }
  async ready() {
    await this.compose([
      "up",
      "-d",
      "--no-build",
      "--wait",
      "--wait-timeout",
      "600",
      "app",
      "runner",
    ]);
    const deadline = this.now() + 10 * 60000;
    let status = await this.runner("status");
    while (
      status.status !== "ready" &&
      !status.error &&
      this.now() < deadline
    ) {
      await this.sleep(3000);
      status = await this.runner("status");
    }
    if (
      status.status !== "ready" ||
      status.protocolVersion !== 1 ||
      status.error
    )
      throw new Error("Runner restore or protocol check failed.");
    const result = await this.internal("status");
    if (result.version !== this.config.release.version)
      throw new Error("Application version mismatch.");
  }
  async perform(operation) {
    try {
      await this.persist();
      await this.owned();
      for (const image of [
        operation.target.images.app,
        operation.target.images.runner,
      ])
        await this.run(["pull", image]);
      await this.run([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "node",
        "-v",
        `${this.config.volumes["app-data"]}:/data:ro`,
        "-v",
        `${this.config.volumes.workspaces}:/workspaces:ro`,
        "-v",
        `${this.config.volumes["package-cache"]}:/package-cache:ro`,
        this.config.updaterImage,
        "/app/installer/runtime/cli.mjs",
        "space",
      ]);
      await this.phase("draining");
      if (!(await this.drain(operation))) {
        await this.unlock();
        await this.phase("deferred");
        return;
      }
      await this.phase("stopping");
      await this.compose(["stop", "app", "runner"]);
      operation.backup = `${this.config.project}_backup_${operation.id}`;
      await this.phase("backing-up");
      await this.createVolume(operation.backup);
      await this.compose([
        "run",
        "--rm",
        "--no-deps",
        "-v",
        `${operation.backup}:/backup`,
        "admin",
        "backup",
        "--offline",
      ]);
      await this.run([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "node",
        "-v",
        `${operation.backup}:/backup:ro`,
        this.config.updaterImage,
        "/app/installer/runtime/cli.mjs",
        "verify-backup",
      ]);
      await this.phase("applying");
      this.config.release = operation.target;
      await atomic(
        path.join(this.directory, "compose.json"),
        deployment(this.config, this.config.release, this.config.volumes),
      );
      await this.ready();
      await atomic(path.join(this.directory, "installation.json"), this.config);
      await this.phase("succeeded");
      await this.internal("resume");
      // Keep backups; never delete an operator's only recovery point automatically.
    } catch (error) {
      operation.error = "Update failed. Recovering the previous installation.";
      console.error("Update operation failed:", error.message);
      await this.recover();
    }
  }
  async recover() {
    const op = this.state.operation;
    try {
      if (op.phase === "preflight") {
        await this.phase("failed");
        return;
      }
      if (op.phase === "draining") {
        await this.unlock();
        await this.phase("failed");
        return;
      }
      if (
        ["succeeded", "rolled-back", "failed", "deferred"].includes(op.phase)
      ) {
        await this.ready();
        await this.unlock();
        return;
      }
      if (["applying", "restoring"].includes(op.phase)) {
        await this.compose(["stop", "app", "runner"]);
        this.config = structuredClone(op.before);
        op.recoveryGeneration = (op.recoveryGeneration || 0) + 1;
        if (op.recoveryGeneration > (op.allowedRecoveryGenerations || 3))
          throw new Error(
            "Repeated recovery interruption. Manual recovery required.",
          );
        {
          op.recoveryVolumes = Object.fromEntries(
            volumeKeys.map((k) => [
              k,
              `${this.config.project}_recovery_${op.id}_${op.recoveryGeneration}_${k}`,
            ]),
          );
          await this.persist();
          for (const name of Object.values(op.recoveryVolumes))
            await this.createVolume(name);
        }
        this.config.volumes = op.recoveryVolumes;
        await this.phase("restoring");
        await atomic(
          path.join(this.directory, "recovery.compose.json"),
          deployment(this.config, this.config.release, this.config.volumes),
        );
        // Interrupted restores get a fresh generation of empty target volumes.
        await this.compose(
          [
            "run",
            "--rm",
            "--no-deps",
            "-v",
            `${op.backup}:/backup:ro`,
            "admin",
            "restore",
          ],
          "recovery.compose.json",
        );
        await atomic(
          path.join(this.directory, "compose.json"),
          deployment(this.config, this.config.release, this.config.volumes),
        );
      } else {
        this.config = structuredClone(op.before);
        await atomic(
          path.join(this.directory, "compose.json"),
          deployment(this.config, this.config.release, this.config.volumes),
        );
      }
      await this.ready();
      // The updater's runner-secret mount belongs to the pre-rollback volume. Backups
      // preserve its exact key, so authentication remains valid after a volume switch.
      await atomic(path.join(this.directory, "installation.json"), this.config);
      await this.phase(op.phase === "restoring" ? "rolled-back" : "failed");
      await this.unlock();
    } catch (error) {
      console.error("Recovery failed:", error.message);
      op.failedPhase = op.phase;
      op.error = `Recovery stopped. From the installation directory run: bash manage.sh recover (PowerShell: .\\manage.ps1 recover). Verify the backup with: docker run --rm --network none -v ${op.backup || "BACKUP_VOLUME"}:/backup:ro ${op.before.updaterImage} verify-backup.`;
      await this.phase("recovery-failed");
    }
  }
  // Local Docker administration only: deliberately absent from the HTTP API.
  async retryRecovery() {
    const op = this.state.operation;
    if (
      this.task ||
      op?.phase !== "recovery-failed" ||
      ![
        "preflight",
        "draining",
        "stopping",
        "backing-up",
        "applying",
        "restoring",
        "succeeded",
        "rolled-back",
        "failed",
        "deferred",
      ].includes(op.failedPhase)
    )
      throw new Error(
        "No failed recovery with a known checkpoint is available.",
      );
    this.state.settings.enabled = false;
    op.allowedRecoveryGenerations = (op.recoveryGeneration || 0) + 1;
    op.phase = op.failedPhase;
    await this.persist();
    await this.recover();
    if (op.phase === "recovery-failed")
      throw new Error(
        "Recovery failed again. All original, backup and partial volumes were retained.",
      );
    return this.status();
  }
}
