import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream, createWriteStream, constants } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RunnerError, atomicJSON, readJSON, freeSpace } from "./common.js";
import { PROGRAMS, LOCK } from "./catalog.js";
import { runtimes, probe, TOOL_PATH } from "./runtime.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const MAX_DOWNLOAD = 1024 * 1024 * 1024;
export async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function diskUsage(root) {
  let count = 0;
  const walk = async (directory, depth = 0) => {
    if (depth > 128 || ++count > 100000)
      throw new RunnerError(
        "Zu viele Cache-/Dateieinträge für die Speicherdiagnose. Nicht mehr benötigte Daten gezielt bereinigen.",
        507,
        "STORAGE_INDEX_LIMIT",
        { messageKey: "runner:storage.indexLimit", params: {} },
      );
    let handle;
    try {
      handle = await fs.open(
        directory,
        constants.O_RDONLY |
          (constants.O_DIRECTORY || 0) |
          (constants.O_NOFOLLOW || 0),
      );
      const pinned =
        process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : directory;
      let bytes = 0;
      for (const entry of await fs.readdir(pinned, { withFileTypes: true })) {
        if (++count > 100000)
          throw new RunnerError(
            "Zu viele Cache-/Dateieinträge.",
            507,
            "STORAGE_INDEX_LIMIT",
            { messageKey: "runner:storage.entries", params: {} },
          );
        const name = path.join(pinned, entry.name);
        if (entry.isDirectory()) bytes += await walk(name, depth + 1);
        else if (entry.isFile()) {
          try {
            const stat = await fs.lstat(name);
            if (stat.isFile()) bytes += stat.size;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
      }
      return bytes;
    } catch (error) {
      if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error.code)) return 0;
      throw error;
    } finally {
      await handle?.close();
    }
  };
  return walk(root);
}

export class ProgramManager {
  constructor(config, jobs) {
    this.config = config;
    this.jobs = jobs;
    this.operations = new Map();
    this.activeJob = null;
    this.manifestPath = path.join(config.stateDir, "programs.json");
  }
  identity() {
    return {
      architecture: process.arch === "x64" ? "amd64" : process.arch,
      suite: LOCK.suite,
      catalogVersion: LOCK.version,
      runnerImageDigest: this.config.imageDigest || LOCK.image,
    };
  }
  async initialize() {
    for (const dir of [
      this.config.cacheDir,
      path.join(this.config.cacheDir, "apt"),
      path.join(this.config.cacheDir, "downloads"),
      path.join(this.config.stateDir, "program-jobs"),
    ])
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    this.jobs.state = "reconciling";
    const first = {
      schema: 1,
      ...this.identity(),
      desired: {},
      installed: {},
      basePackages: [],
      initialProgramsApplied: false,
    };
    this.manifest = await readJSON(this.manifestPath, first);
    if (
      this.manifest.schema !== 1 ||
      ["architecture", "suite"].some(
        (key) => this.manifest[key] !== this.identity()[key],
      )
    )
      throw new RunnerError(
        "Programmmanifest benötigt eine explizite Migration für Architektur oder Debian-Suite.",
        503,
        "MANIFEST_MIGRATION_REQUIRED",
        { messageKey: "runner:programs.manifestMigration", params: {} },
      );
    if (!LOCK.approvedArchitectures.includes(this.identity().architecture))
      throw new RunnerError(
        "Diese Runner-Architektur ist noch nicht freigegeben.",
        503,
        "ARCHITECTURE_NOT_APPROVED",
        { messageKey: "runner:programs.architecture", params: {} },
      );
    if (!this.manifest.basePackages.length) {
      this.manifest.basePackages = [...(await this.installedPackages()).keys()];
      await this.save();
    }
    if (this.manifest.initialProgramsApplied === false) {
      const selected = (process.env.STERRACODE_INITIAL_PROGRAMS || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (selected.some((id) => !PROGRAMS.some((program) => program.id === id)))
        throw new RunnerError(
          "Unbekanntes initiales Programm im Serverprofil.",
          503,
          "INVALID_INITIAL_PROGRAMS",
          { messageKey: "runner:programs.initialUnknown", params: {} },
        );
      this.manifest.initialPending = [
        ...new Set(
          selected.filter(
            (id) => !PROGRAMS.find((program) => program.id === id).base,
          ),
        ),
      ];
      this.manifest.initialProgramsApplied = true;
      await this.save();
    }
    for (const file of await fs.readdir(
      path.join(this.config.stateDir, "program-jobs"),
    )) {
      if (!file.endsWith(".json")) continue;
      const job = await readJSON(
        path.join(this.config.stateDir, "program-jobs", file),
      );
      if (!TERMINAL.has(job.state)) {
        job.state = "interrupted";
        job.error =
          "Runner während Paketaktion beendet. Paketdatenbank wird geprüft; Aktion kann wiederholt werden.";
        job.errorKey = "runner:programs.interrupted";
        job.errorParams = {};
        await this.persist(job);
      }
      this.operations.set(job.id, job);
    }
    // Readdir order is unrelated to operation time; recovery and retry must use
    // the latest operation, also after restarting the controller.
    this.operations = new Map(
      [...this.operations.values()]
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((job) => [job.id, job]),
    );
    const audit = await this.run("dpkg", ["--audit"]);
    if (audit.trim())
      throw new RunnerError(
        `Paketdatenbank benötigt Reparatur: ${audit.slice(0, 2000)}`,
        503,
        "PACKAGE_REPAIR_REQUIRED",
        {
          messageKey: "runner:programs.databaseDetails",
          params: { details: audit.slice(0, 2000) },
        },
      );
    // A removed desired entry is never inferred from allowedLanguages or old jobs.
    for (const [id, wanted] of Object.entries(this.manifest.desired)) {
      if (!wanted) {
        if (this.manifest.installed[id]) {
          const program = PROGRAMS.find((p) => p.id === id);
          if (!program || program.base)
            throw new RunnerError(
              "Ungültiger Entfernungseintrag im Manifest.",
              503,
              "MANIFEST_MIGRATION_REQUIRED",
              { messageKey: "runner:programs.removalInvalid", params: {} },
            );
          const repair = {
            id: randomUUID(),
            programId: id,
            action: "remove",
            state: "removing",
            progress: "Unterbrochene Entfernung wird abgeschlossen.",
            progressMessage: {
              key: "runner:programs.finishRemoval",
              params: {},
            },
            startedAt: Date.now(),
          };
          this.operations.set(repair.id, repair);
          this.activeJob = repair;
          await this.persist(repair);
          try {
            await this.remove(program, repair);
            repair.state = "succeeded";
          } catch (error) {
            repair.state = "failed";
            repair.error = error.message;
            repair.errorKey = error.messageKey;
            repair.errorParams = error.params || {};
            await this.persist(repair);
            throw error;
          }
          await this.persist(repair);
          this.activeJob = null;
        }
        continue;
      }
      const record = this.manifest.installed[id],
        program = PROGRAMS.find((p) => p.id === id);
      if (!record || !program)
        throw new RunnerError(
          "Unvollständiges Sollmanifest. Programmverwaltung reparieren.",
          503,
          "PACKAGE_REPAIR_REQUIRED",
          { messageKey: "runner:programs.manifestIncomplete", params: {} },
        );
      if (!(await this.healthy(program, record))) {
        const repair = {
          id: randomUUID(),
          programId: id,
          action: "restore",
          state: "installing",
          progress: "Programm wird aus dem Sollmanifest wiederhergestellt.",
          progressMessage: { key: "runner:programs.restore", params: {} },
          startedAt: Date.now(),
        };
        this.operations.set(repair.id, repair);
        this.activeJob = repair;
        await this.persist(repair);
        try {
          await this.install(program, record, repair);
          repair.state = "succeeded";
        } catch (error) {
          repair.state = "failed";
          repair.error = error.message;
          repair.errorKey = error.messageKey;
          repair.errorParams = error.params || {};
          await this.persist(repair);
          throw error;
        }
        await this.persist(repair);
        this.activeJob = null;
      }
    }
    for (const id of [...(this.manifest.initialPending || [])]) {
      const program = PROGRAMS.find((entry) => entry.id === id);
      const job = {
        id: randomUUID(),
        programId: id,
        action: "install",
        state: "installing",
        progress: "Initiale Programmauswahl wird eingerichtet.",
        progressMessage: { key: "runner:programs.initial", params: {} },
        startedAt: Date.now(),
      };
      this.operations.set(job.id, job);
      this.activeJob = job;
      await this.persist(job);
      try {
        const record = await this.install(
          program,
          this.manifest.installed[id] || null,
          job,
        );
        this.manifest.desired[id] = true;
        this.manifest.installed[id] = record;
        this.manifest.initialPending = this.manifest.initialPending.filter(
          (entry) => entry !== id,
        );
        await this.save();
        job.state = "succeeded";
      } catch (error) {
        job.state = "failed";
        job.error = error.message;
        job.errorKey = error.messageKey;
        job.errorParams = error.params || {};
        await this.persist(job);
        throw error;
      }
      await this.persist(job);
      this.activeJob = null;
    }
    this.manifest.catalogVersion = LOCK.version;
    this.manifest.runnerImageDigest = this.identity().runnerImageDigest;
    await this.save();
    const latest = new Map(
      [...this.operations.values()].map((job) => [job.programId, job]),
    );
    if ([...latest.values()].some((job) => job.state === "interrupted"))
      throw new RunnerError(
        "Eine Paketaktion wurde unterbrochen. Bitte beim betroffenen Programm erneut versuchen oder die Paketdatenbank reparieren.",
        503,
        "PACKAGE_REPAIR_REQUIRED",
        { messageKey: "runner:programs.retry", params: {} },
      );
    this.jobs.initializationError = null;
    this.jobs.state = "ready";
  }
  async save() {
    await atomicJSON(this.manifestPath, this.manifest);
  }
  async persist(job) {
    const { child, ...record } = job;
    await atomicJSON(
      path.join(this.config.stateDir, "program-jobs", `${job.id}.json`),
      record,
    );
  }
  async phase(job, current, label, descriptor = job?.progressMessage) {
    if (!job) return;
    job.stage = { current, total: 6 };
    job.progress = label;
    if (descriptor) job.progressMessage = descriptor;
    else delete job.progressMessage;
    await this.persist(job);
  }
  async run(command, args, job, timeout = 15 * 60 * 1000) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: {
          PATH: TOOL_PATH,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          DEBIAN_FRONTEND: "noninteractive",
          HOME: "/root",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (job) job.child = child;
      let output = "",
        exceeded = false;
      const append = (chunk) => {
        output = (output + chunk.toString()).slice(-65536);
        if (job) job.log = output.slice(-16000);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const timer = setTimeout(() => {
        exceeded = true;
        child.kill("SIGTERM");
      }, timeout);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (job) job.child = null;
        if (code === 0) resolve(output);
        else
          reject(
            new RunnerError(
              `${command} fehlgeschlagen${exceeded ? " (Zeitlimit)" : ""}: ${output.slice(-4000)}${/valid-until|not valid yet|signature|EXPKEYSIG/i.test(output) ? " Prüfen Sie Container-/WSL-Uhr und signierte Paketquellen; DEBIAN_FRONTEND=noninteractive ist gesetzt." : ""}`,
              503,
              "PACKAGE_COMMAND_FAILED",
              {
                messageKey: exceeded
                  ? /valid-until|not valid yet|signature|EXPKEYSIG/i.test(
                      output,
                    )
                    ? "runner:programs.commandFailedTimeoutClock"
                    : "runner:programs.commandFailedTimeout"
                  : /valid-until|not valid yet|signature|EXPKEYSIG/i.test(
                        output,
                      )
                    ? "runner:programs.commandFailedClock"
                    : "runner:programs.commandFailed",
                params: { command, details: output.slice(-4000) },
              },
            ),
          );
      });
    });
  }
  apt(args, job) {
    return this.run(
      "apt-get",
      [
        "-o",
        `Dir::Cache::archives=${path.join(this.config.cacheDir, "apt")}`,
        "-o",
        "APT::Sandbox::User=root",
        "-o",
        "Dpkg::Use-Pty=0",
        "-y",
        "--no-install-recommends",
        ...args,
      ],
      job,
    );
  }
  async downloadBudget(packages, job) {
    const plan = await this.apt(
      [
        "--print-uris",
        "--download-only",
        "--reinstall",
        "install",
        ...packages,
      ],
      job,
    );
    let required = 0;
    for (const match of plan.matchAll(/^'[^']+'\s+\S+\s+(\d+)\s+/gm))
      required += Number(match[1]);
    await freeSpace(this.config.cacheDir, required + 64 * 1024 ** 2);
    if (
      (await diskUsage(this.config.cacheDir)) + required >
      (this.config.maxCacheBytes || 8 * 1024 ** 3)
    )
      throw new RunnerError(
        "Die aufgelösten Pakete überschreiten die Größenbegrenzung des Paketcaches. Nicht mehr benötigte Downloads bereinigen.",
        507,
        "CACHE_LIMIT",
        { messageKey: "runner:programs.cacheSize", params: {} },
      );
  }
  async installedPackages() {
    const output = await this.run("dpkg-query", [
      "-W",
      "-f=${binary:Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n",
    ]);
    return new Map(
      output
        .trim()
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((entry) => entry[3] === "installed")
        .map(([name, version, architecture]) => [
          name.replace(/:amd64$/, ""),
          { name: name.replace(/:amd64$/, ""), version, architecture },
        ]),
    );
  }
  async healthy(program, record) {
    if (
      record.architecture !== this.identity().architecture ||
      record.suite !== LOCK.suite
    )
      return false;
    const installed = await this.installedPackages();
    if (
      (record.packages || []).some(
        (p) => installed.get(p.name)?.version !== p.version,
      )
    )
      return false;
    const runtime = (await runtimes()).find((r) => r.language === program.id);
    if (!runtime?.installed) return false;
    if (program.upstream && !runtime.version.includes(record.version))
      return false;
    return true;
  }
  async status() {
    const all = await runtimes();
    const programs = PROGRAMS.map((program) => {
      const runtime = all.find((r) => r.language === program.id),
        stored = this.manifest?.installed?.[program.id];
      const installed =
        program.id === "git" ? true : Boolean(runtime?.installed);
      const action =
        this.activeJob?.programId === program.id ? this.activeJob : null;
      const latest = [...this.operations.values()]
        .reverse()
        .find((job) => job.programId === program.id);
      const last = ["failed", "interrupted"].includes(latest?.state)
        ? latest
        : null;
      return {
        ...program,
        packages: undefined,
        installed,
        desired: Boolean(program.base || this.manifest?.desired?.[program.id]),
        state:
          action && !TERMINAL.has(action.state)
            ? action.state
            : last
              ? "error"
              : installed
                ? "installed"
                : "not-installed",
        version: runtime?.version || stored?.version || null,
        updateAvailable:
          program.id === "java" &&
          installed &&
          !/^javac 25(?:[.\s]|$)/.test(
            runtime?.version || stored?.version || "",
          ),
        error: action?.error || last?.error || null,
        errorKey: action?.error ? action.errorKey : last?.errorKey,
        errorParams: action?.error
          ? action.errorParams || {}
          : last?.errorParams || {},
      };
    });
    return {
      programs,
      status: this.jobs.state,
      activeJob:
        this.activeJob && !TERMINAL.has(this.activeJob.state)
          ? this.publicJob(this.activeJob)
          : null,
      latestJob: this.publicJob([...this.operations.values()].at(-1)),
      catalogVersion: LOCK.version,
      ...this.identity(),
      cache: await this.cacheStatus(),
    };
  }
  publicJob(job) {
    if (!job) return null;
    const { child, ...record } = job;
    return {
      ...record,
      blockingJobs:
        job.state === "queued"
          ? this.jobs.active().map((j) => this.jobs.snapshot(j))
          : [],
    };
  }
  getJob(id) {
    const job = this.operations.get(id);
    if (!job)
      throw new RunnerError("Paketauftrag nicht gefunden.", 404, "NOT_FOUND", {
        messageKey: "runner:programs.jobNotFound",
        params: {},
      });
    return this.publicJob(job);
  }
  async action(id, options) {
    if (
      !this.manifest ||
      this.manifest.schema !== 1 ||
      ["architecture", "suite"].some(
        (key) => this.manifest[key] !== this.identity()[key],
      ) ||
      !LOCK.approvedArchitectures.includes(this.identity().architecture)
    )
      throw new RunnerError(
        "Dieses Programmmanifest benötigt vor Paketaktionen eine unterstützte Migration.",
        503,
        "MANIFEST_MIGRATION_REQUIRED",
        { messageKey: "runner:programs.actionMigration", params: {} },
      );
    const program = PROGRAMS.find((entry) => entry.id === id);
    if (!program)
      throw new RunnerError("Unbekanntes Programm.", 400, "INVALID_REQUEST", {
        messageKey: "runner:programs.unknown",
        params: {},
      });
    if (options?.action === "retry") {
      const previous = [...this.operations.values()]
        .reverse()
        .find((job) => job.programId === id);
      options = {
        ...options,
        action:
          previous?.action === "remove"
            ? "remove"
            : previous?.action === "restore"
              ? "install"
              : previous?.action || "install",
      };
    }
    if (!options || !["install", "remove", "repair"].includes(options.action))
      throw new RunnerError(
        "Ungültige Programmaktion.",
        400,
        "INVALID_REQUEST",
        { messageKey: "runner:programs.actionInvalid", params: {} },
      );
    if (program.base)
      throw new RunnerError(
        "Grundkomponenten können nicht entfernt oder ersetzt werden.",
        409,
        "BASE_PROGRAM",
        { messageKey: "runner:programs.base", params: {} },
      );
    return this.jobs.serial(async () => {
      if (this.activeJob && !TERMINAL.has(this.activeJob.state)) {
        if (
          this.activeJob.state === "queued" &&
          this.activeJob.programId === id &&
          options.stopRunning === true
        ) {
          this.activeJob.stopRunning = true;
          await this.persist(this.activeJob);
          await this.jobs.stopAll();
          return { job: this.publicJob(this.activeJob) };
        }
        throw new RunnerError(
          "Eine andere Paketaktion läuft bereits.",
          409,
          "PACKAGE_BUSY",
          { messageKey: "runner:programs.otherAction", params: {} },
        );
      }
      if (this.jobs.maintenance)
        throw new RunnerError(
          "Der Runner befindet sich in Wartung.",
          409,
          "MAINTENANCE",
          { messageKey: "runner:programs.maintenance", params: {} },
        );
      this.jobs.maintenance = true;
      this.jobs.state = "maintenance";
      if (this.manifest.initialPending?.includes(id)) {
        this.manifest.initialPending = this.manifest.initialPending.filter(
          (entry) => entry !== id,
        );
        await this.save();
      }
      const job = {
        id: randomUUID(),
        programId: id,
        action: options.action,
        stopRunning: options.stopRunning === true,
        clearCache: options.clearCache === true,
        state: "queued",
        progress:
          "Wartet auf laufende Ausführungen. Abbrechen oder laufende Prozesse ausdrücklich stoppen.",
        progressMessage: { key: "runner:programs.waiting", params: {} },
        startedAt: Date.now(),
      };
      this.operations.set(job.id, job);
      this.activeJob = job;
      await this.persist(job);
      if (job.stopRunning) await this.jobs.stopAll();
      void this.process(job, program);
      return { job: this.publicJob(job) };
    });
  }
  async cancel(id) {
    const job = this.operations.get(id);
    if (!job)
      throw new RunnerError(
        "Paketauftrag nicht gefunden.",
        404,
        "INVALID_REQUEST",
        { messageKey: "runner:programs.jobNotFound", params: {} },
      );
    if (job.state !== "queued")
      throw new RunnerError(
        "Eine begonnene Paketänderung kann nicht sicher abgebrochen werden.",
        409,
        "PACKAGE_ALREADY_STARTED",
        { messageKey: "runner:programs.cannotCancel", params: {} },
      );
    job.state = "cancelled";
    await this.persist(job);
    this.jobs.maintenance = false;
    this.jobs.state = "ready";
    return this.publicJob(job);
  }
  async process(job, program) {
    try {
      while (this.jobs.active().length) {
        if (job.state === "cancelled") return;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (job.state === "cancelled") return;
      job.state = job.action === "remove" ? "removing" : "installing";
      Object.assign(job, {
        progress: "Paketdatenbank und Speicher werden geprüft.",
        progressMessage: { key: "runner:programs.checkDatabase", params: {} },
      }).progress;
      await this.phase(job, 1, job.progress);
      const audit = await this.run("dpkg", ["--audit"]);
      if (audit.trim() && job.action !== "repair")
        throw new RunnerError(
          "Paketdatenbank benötigt Reparatur. Reparieren wählen.",
          503,
          "PACKAGE_REPAIR_REQUIRED",
          { messageKey: "runner:programs.databaseRepair", params: {} },
        );
      if (job.action === "repair") {
        await this.run("dpkg", ["--configure", "-a"], job);
        await this.apt(["--fix-broken", "install"], job);
      }
      const removing =
        job.action === "remove" ||
        (job.action === "repair" &&
          this.manifest.desired[program.id] === false);
      if (removing) await this.remove(program, job);
      else {
        let existing = this.manifest.desired[program.id]
          ? this.manifest.installed[program.id]
          : null;
        // Explicit installation upgrades the old Java recipe; ordinary restart
        // recovery still restores the exact previously recorded package closure.
        if (
          program.id === "java" &&
          existing?.packages.some((p) => p.name === "openjdk-17-jdk-headless")
        ) {
          await this.remove(program, job);
          existing = null;
        }
        if (job.action === "repair" && existing?.packages.length)
          await this.installApt(program, existing, job);
        const record = await this.install(program, existing, job);
        this.manifest.desired[program.id] = true;
        this.manifest.installed[program.id] = record;
        await this.save();
      }
      job.state = "succeeded";
      if (removing && job.clearCache) await this.cleanCache();
      Object.assign(job, {
        progress: "Fertig.",
        progressMessage: { key: "runner:programs.done", params: {} },
      }).progress;
      job.stage = { current: 6, total: 6 };
      this.jobs.initializationError = null;
      this.jobs.state = "ready";
    } catch (error) {
      job.state = "failed";
      job.error = error.message;
      job.errorKey = error.messageKey;
      job.errorParams = error.params || {};
      Object.assign(job, {
        progress: "Aktion fehlgeschlagen; Details prüfen und wiederholen.",
        progressMessage: { key: "runner:programs.failed", params: {} },
      }).progress;
      this.jobs.initializationError = {
        code: error.code || "PACKAGE_ACTION_FAILED",
        message: error.message,
        ...(error.messageKey
          ? { messageKey: error.messageKey, params: error.params || {} }
          : {}),
      };
      this.jobs.state = "error";
    } finally {
      job.endedAt = Date.now();
      try {
        await this.persist(job);
      } catch {
        this.jobs.state = "error";
        this.jobs.initializationError = {
          code: "PACKAGE_JOURNAL_FAILED",
          message:
            "Das Ergebnis der Paketaktion konnte nicht dauerhaft protokolliert werden.",
          messageKey: "runner:programs.resultJournal",
          params: {},
        };
      }
      this.jobs.maintenance = false;
    }
  }
  async download(url, checksum, name, job) {
    const file = path.join(this.config.cacheDir, "downloads", name);
    try {
      if ((await sha256(file)) === checksum) return file;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temp = `${file}.${randomUUID()}.part`;
    if (
      (await diskUsage(this.config.cacheDir)) >
      (this.config.maxCacheBytes || 8 * 1024 ** 3) - MAX_DOWNLOAD
    )
      throw new RunnerError(
        "Der Paketcache hat seine Größenbegrenzung erreicht. Nicht mehr benötigte Downloads bereinigen.",
        507,
        "CACHE_LIMIT",
        { messageKey: "runner:programs.cacheFull", params: {} },
      );
    await freeSpace(this.config.cacheDir, MAX_DOWNLOAD + 32 * 1024 * 1024);
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body)
      throw new RunnerError(
        `Herstellerdownload fehlgeschlagen (${response.status}).`,
        503,
        "DOWNLOAD_FAILED",
        {
          messageKey: "runner:programs.downloadStatus",
          params: { status: response.status },
        },
      );
    let bytes = 0;
    if (job)
      job.download = {
        name,
        bytes: 0,
        total: Number(response.headers.get("content-length")) || null,
      };
    const stream = Readable.fromWeb(response.body);
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (job) job.download.bytes = bytes;
      if (bytes > MAX_DOWNLOAD)
        stream.destroy(
          new RunnerError(
            "Download überschreitet die Größenbegrenzung.",
            400,
            "INVALID_REQUEST",
            { messageKey: "runner:programs.downloadLimit", params: {} },
          ),
        );
    });
    try {
      await pipeline(
        stream,
        createWriteStream(temp, { flags: "wx", mode: 0o600 }),
      );
      const handle = await fs.open(temp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await sha256(temp)) !== checksum)
        throw new RunnerError(
          "Prüfsumme des Herstellerdownloads stimmt nicht.",
          503,
          "CHECKSUM_MISMATCH",
          { messageKey: "runner:programs.downloadChecksum", params: {} },
        );
      await fs.rename(temp, file);
      return file;
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
  async microsoft(job) {
    const key = path.join(this.config.stateDir, "microsoft.gpg");
    await this.run(
      "gpg",
      [
        "--batch",
        "--yes",
        "--dearmor",
        "--output",
        key,
        new URL("./catalog/microsoft-key", import.meta.url).pathname.replace(
          /^\/(\w:)/,
          "$1",
        ),
      ],
      job,
    );
    await fs.writeFile(
      "/etc/apt/sources.list.d/sterracode-microsoft.list",
      `deb [arch=amd64 signed-by=${key}] https://packages.microsoft.com/debian/12/prod bookworm main\n`,
      { mode: 0o644 },
    );
    // apt's sandbox must be able to read this public key, never the state dir.
    await fs.copyFile(key, "/usr/share/keyrings/sterracode-microsoft.gpg");
    await fs.writeFile(
      "/etc/apt/sources.list.d/sterracode-microsoft.list",
      "deb [arch=amd64 signed-by=/usr/share/keyrings/sterracode-microsoft.gpg] https://packages.microsoft.com/debian/12/prod bookworm main\n",
    );
  }
  async install(program, restoring, job) {
    await freeSpace(
      this.config.tempDir,
      program.sizeMB * 1024 * 1024 + 64 * 1024 * 1024,
    );
    const record = restoring || {
      ...this.identity(),
      packages: [],
      cache: [],
      version: program.upstream ? LOCK[program.id].version : null,
    };
    if (restoring) {
      let missingCache = false;
      for (const cached of record.cache || []) {
        const location = path.join(
          this.config.cacheDir,
          "apt",
          path.basename(cached.file),
        );
        let checksum;
        try {
          checksum = await sha256(location);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          missingCache = true;
          continue;
        }
        if (checksum !== cached.sha256)
          throw new RunnerError(
            "Paketcache beschädigt. Exakte Paketversionen neu herunterladen.",
            503,
            "CACHE_CORRUPTED",
            { messageKey: "runner:programs.cacheCorrupt", params: {} },
          );
      }
      if (missingCache) await this.installApt(program, record, job);
      else if (record.cache?.length)
        await this.apt(
          [
            "--no-download",
            "--allow-downgrades",
            "install",
            ...record.cache.map((entry) =>
              path.join(this.config.cacheDir, "apt", path.basename(entry.file)),
            ),
          ],
          job,
        );
      else if (record.packages.length)
        await this.installApt(program, record, job);
    } else if (program.packages.length)
      await this.installApt(program, record, job);
    if (program.upstream) await this.installUpstream(program, record, job);
    await this.phase(
      job,
      6,
      "Installierte Laufzeit und Version werden geprüft.",
      { key: "runner:programs.verify", params: {} },
    );
    const runtime = (await runtimes()).find((r) => r.language === program.id);
    if (!runtime?.installed)
      throw new RunnerError(
        "Versions-/Funktionsprüfung der installierten Laufzeit fehlgeschlagen.",
        503,
        "RUNTIME_SMOKE_FAILED",
        { messageKey: "runner:programs.smoke", params: {} },
      );
    record.version = program.upstream
      ? LOCK[program.id].version
      : runtime.version;
    if (program.upstream && !runtime.version.includes(record.version))
      throw new RunnerError(
        "Installierte Herstellerversion stimmt nicht mit dem Katalog überein.",
        503,
        "VERSION_MISMATCH",
        { messageKey: "runner:programs.version", params: {} },
      );
    return record;
  }
  async installApt(program, record, job) {
    if (program.microsoft) await this.microsoft(job);
    await this.phase(
      job,
      2,
      "Signierte Paketlisten und festgeschriebene Versionen werden geladen.",
      { key: "runner:programs.packageLists", params: {} },
    );
    await this.apt(["update"], job);
    const packages = record.packages.length
      ? record.packages.map((p) => `${p.name}=${p.version}`)
      : program.packages.map((p) =>
          LOCK.apt[p] ? `${p}=${LOCK.apt[p].version}` : p,
        );
    await this.downloadBudget(packages, job);
    await this.phase(job, 3, "Programmpakete werden heruntergeladen.", {
      key: "runner:programs.downloadPackages",
      params: {},
    });
    await this.apt(
      ["--download-only", "--reinstall", "install", ...packages],
      job,
    );
    await this.phase(job, 4, "Pakete werden entpackt und eingerichtet.", {
      key: "runner:programs.unpackPackages",
      params: {},
    });
    await this.apt(["--no-download", "install", ...packages], job);
    const installed = await this.installedPackages();
    // Recovery can reference an older recipe, such as Java 17.
    const roots = record.packages.length
      ? record.packages.map((entry) => entry.name)
      : program.packages;
    const closure = await this.run(
      "apt-cache",
      [
        "depends",
        "--recurse",
        "--no-recommends",
        "--no-suggests",
        "--no-conflicts",
        "--no-breaks",
        "--no-replaces",
        "--no-enhances",
        ...roots,
      ],
      job,
    );
    const names = [
      ...new Set([
        ...roots,
        ...closure
          .split("\n")
          .filter((line) => /^[a-z0-9][a-z0-9+.-]*(?::amd64)?$/.test(line))
          .map((line) => line.replace(/:amd64$/, "")),
      ]),
    ].filter((name) => installed.has(name));
    record.packages = names.map((name) => installed.get(name));
    await this.phase(
      job,
      5,
      "Abhängigkeiten und Prüfsummen werden für die Wiederherstellung gesichert.",
      { key: "runner:programs.saveDependencies", params: {} },
    );
    job.resolvedPackages = record.packages;
    await this.persist(job);
    await this.downloadBudget(
      record.packages.map((p) => `${p.name}=${p.version}`),
      job,
    );
    // Re-download the entire resolved closure, including dependencies currently
    // installed by another optional program, for container recreation offline.
    await this.apt(
      [
        "--download-only",
        "--reinstall",
        "install",
        ...record.packages.map((p) => `${p.name}=${p.version}`),
      ],
      job,
    );
    record.cache = [];
    for (const file of await fs.readdir(
      path.join(this.config.cacheDir, "apt"),
    )) {
      if (!file.endsWith(".deb")) continue;
      const full = path.join(this.config.cacheDir, "apt", file);
      const fields = (
        await this.run("dpkg-deb", [
          "-f",
          full,
          "Package",
          "Version",
          "Architecture",
        ])
      )
        .trim()
        .split("\n")
        .map((line) => line.replace(/^\w+: /, ""));
      const [name, version, architecture] = fields;
      if (
        record.packages.some((p) => p.name === name && p.version === version)
      ) {
        const checksum = await sha256(full);
        if (
          LOCK.apt[name]?.version === version &&
          LOCK.apt[name].sha256 !== checksum
        )
          throw new RunnerError(
            "Katalog-Prüfsumme des Debian-Pakets stimmt nicht.",
            503,
            "CHECKSUM_MISMATCH",
            { messageKey: "runner:programs.catalogChecksum", params: {} },
          );
        record.cache.push({
          file,
          name,
          version,
          architecture,
          sha256: checksum,
        });
      }
    }
    if (
      record.packages.some(
        (p) =>
          !record.cache.some(
            (c) => c.name === p.name && c.version === p.version,
          ),
      )
    )
      throw new RunnerError(
        "Der Paketcache enthält nicht alle aufgelösten Abhängigkeiten.",
        503,
        "INCOMPLETE_CACHE",
        { messageKey: "runner:programs.dependenciesMissing", params: {} },
      );
  }
  async installUpstream(program, record, job) {
    await this.phase(job, 3, "Herstellerdownload wird geladen und geprüft.", {
      key: "runner:programs.vendorDownload",
      params: {},
    });
    const root = "/opt/sterracode";
    await fs.mkdir(root, { recursive: true, mode: 0o755 });
    if (program.id === "go") {
      const spec = LOCK.go,
        file = await this.download(
          spec.url,
          spec.sha256,
          `go-${spec.version}-amd64.tar.gz`,
          job,
        );
      const metadata = await fetch(spec.provenance, {
        signal: AbortSignal.timeout(20000),
      })
        .then((r) => {
          if (!r.ok)
            throw Object.assign(
              new Error("Herstellermetadaten nicht erreichbar."),
              { messageKey: "runner:programs.vendorMetadata", params: {} },
            );
          return r.json();
        })
        .catch((error) => {
          if (record.upstreamVerified) return null;
          throw error;
        });
      if (
        metadata &&
        !metadata
          .find((entry) => entry.version === `go${spec.version}`)
          ?.files.some(
            (entry) =>
              entry.os === "linux" &&
              entry.arch === "amd64" &&
              entry.sha256 === spec.sha256,
          )
      )
        throw new RunnerError(
          "Go-Herstellerprüfsumme stimmt nicht mit Katalog überein.",
          503,
          "PROVENANCE_MISMATCH",
          { messageKey: "runner:programs.goChecksum", params: {} },
        );
      await this.phase(job, 4, "Programm wird entpackt und eingerichtet.", {
        key: "runner:programs.unpackVendor",
        params: {},
      });
      await this.run("tar", ["-xzf", file, "--no-same-owner", "-C", root], job);
      record.upstreamVerified = true;
    } else {
      const spec = LOCK.rust,
        manifest = await this.download(
          spec.manifestURL,
          spec.manifestSHA256,
          `rust-${spec.version}-manifest.toml`,
          job,
        );
      const signatureFile = path.join(
        this.config.cacheDir,
        "downloads",
        `rust-${spec.version}-manifest.asc`,
      );
      try {
        await fs.access(signatureFile);
      } catch {
        const response = await fetch(`${spec.manifestURL}.asc`, {
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok)
          throw Object.assign(new Error("Rust-Signatur nicht erreichbar."), {
            messageKey: "runner:programs.rustSignature",
            params: {},
          });
        await fs.writeFile(signatureFile, await response.text(), {
          mode: 0o600,
        });
      }
      const keyring = path.join(this.config.stateDir, "rust-keyring.gpg");
      await this.run(
        "gpg",
        [
          "--batch",
          "--yes",
          "--dearmor",
          "--output",
          keyring,
          new URL("./catalog/rust-key", import.meta.url).pathname.replace(
            /^\/(\w:)/,
            "$1",
          ),
        ],
        job,
      );
      await this.run(
        "gpgv",
        ["--keyring", keyring, signatureFile, manifest],
        job,
      );
      const signedManifest = await fs.readFile(manifest, "utf8");
      if (
        spec.artifacts.some(
          (artifact) =>
            !signedManifest.includes(artifact.url) ||
            !signedManifest.includes(artifact.sha256),
        )
      )
        throw new RunnerError(
          "Rust-Komponenten sind nicht durch das signierte Herstellermanifest belegt.",
          503,
          "PROVENANCE_MISMATCH",
          { messageKey: "runner:programs.rustManifest", params: {} },
        );
      const unpack = path.join(this.config.stateDir, "rust-unpack");
      await fs.mkdir(unpack, { recursive: true, mode: 0o700 });
      try {
        for (const artifact of spec.artifacts) {
          const file = await this.download(
            artifact.url,
            artifact.sha256,
            path.basename(artifact.url),
            job,
          );
          await this.run(
            "tar",
            ["-xJf", file, "--no-same-owner", "-C", unpack],
            job,
          );
          const folder = path.basename(artifact.url, ".tar.xz");
          await this.run(
            "bash",
            [
              path.join(unpack, folder, "install.sh"),
              `--prefix=${root}/rust`,
              "--disable-ldconfig",
            ],
            job,
          );
        }
      } finally {
        await fs.rm(unpack, { recursive: true, force: true });
      }
      record.upstreamVerified = true;
    }
  }
  async remove(program, job) {
    // Desired removal is committed first. A crash can leave packages to remove,
    // but a previously removed runtime will never be restored from an old job.
    this.manifest.desired[program.id] = false;
    await this.save();
    let record = this.manifest.installed[program.id];
    if (!record && program.packages.length) {
      // An interrupted first install may already have changed dpkg before its
      // resolved manifest could be committed. Resolve only fixed recipe roots,
      // intersect with dpkg and protect base/shared packages below.
      const installed = await this.installedPackages();
      const closure = await this.run(
        "apt-cache",
        [
          "depends",
          "--recurse",
          "--no-recommends",
          "--no-suggests",
          "--no-conflicts",
          "--no-breaks",
          "--no-replaces",
          "--no-enhances",
          ...program.packages,
        ],
        job,
      );
      const names = new Set([
        ...program.packages,
        ...closure
          .split("\n")
          .filter((line) => /^[a-z0-9][a-z0-9+.-]*(?::amd64)?$/.test(line))
          .map((line) => line.replace(/:amd64$/, "")),
      ]);
      record = {
        packages: [...names]
          .filter((name) => installed.has(name))
          .map((name) => installed.get(name)),
      };
    }
    const keep = new Set(this.manifest.basePackages);
    for (const [id, value] of Object.entries(this.manifest.installed))
      if (id !== program.id && this.manifest.desired[id])
        for (const p of value.packages || []) keep.add(p.name);
    const names = (record?.packages || [])
      .map((p) => p.name)
      .filter((name) => !keep.has(name));
    if (names.length) await this.apt(["remove", ...names], job);
    if (program.upstream)
      await fs.rm(`/opt/sterracode/${program.id}`, {
        recursive: true,
        force: true,
      });
    delete this.manifest.installed[program.id];
    await this.save();
    if ((await runtimes()).find((r) => r.language === program.id)?.installed)
      throw new RunnerError(
        "Die Laufzeit ist weiterhin vorhanden; gemeinsam benötigte Pakete wurden geschützt.",
        409,
        "RUNTIME_STILL_INSTALLED",
        { messageKey: "runner:programs.stillInstalled", params: {} },
      );
  }
  async cacheStatus() {
    return {
      packageBytes: await diskUsage(this.config.cacheDir),
      toolBytes: await diskUsage(this.config.toolCacheDir),
      tempBytes: await diskUsage(this.config.tempDir),
      freeBytes: await freeSpace(this.config.cacheDir, 0),
      maxPackageBytes: Number(this.config.maxCacheBytes) || 8 * 1024 ** 3,
      journalBytes: await diskUsage(this.config.stateDir),
      workspaceBytes: this.config.workspaceDir
        ? await diskUsage(this.config.workspaceDir)
        : null,
    };
  }
  async cleanCache() {
    return this.jobs.serial(async () => {
      const previous = this.jobs.maintenance;
      this.jobs.maintenance = true;
      try {
        return await this.cleanUnusedPackages();
      } finally {
        this.jobs.maintenance = previous;
      }
    });
  }
  async cleanUnusedPackages() {
    if (
      this.jobs.active().length ||
      (this.activeJob && !TERMINAL.has(this.activeJob.state))
    )
      throw new RunnerError(
        "Cachebereinigung ist während Downloads oder Ausführungen gesperrt.",
        409,
        "CACHE_BUSY",
        { messageKey: "runner:programs.cacheBusy", params: {} },
      );
    // Keep the verified package closure of every desired program for offline restore.
    const keep = new Set(
      Object.entries(this.manifest.installed)
        .filter(([id]) => this.manifest.desired[id])
        .flatMap(([, value]) => (value.cache || []).map((entry) => entry.file)),
    );
    for (const name of await fs.readdir(path.join(this.config.cacheDir, "apt")))
      if (name.endsWith(".deb") && !keep.has(name))
        await fs.rm(path.join(this.config.cacheDir, "apt", name));
    for (const name of await fs.readdir(
      path.join(this.config.cacheDir, "downloads"),
    )) {
      const preserve =
        (this.manifest.desired.go && name.startsWith("go-")) ||
        (this.manifest.desired.rust && /^(rust|cargo)/.test(name));
      if (!preserve)
        await fs.rm(path.join(this.config.cacheDir, "downloads", name), {
          force: true,
        });
    }
    return this.cacheStatus();
  }
}
