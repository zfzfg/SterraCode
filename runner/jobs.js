import { runTests } from "./grading/adapter.js";
import { validateTest } from "./grading/schema.js";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  RunnerError,
  UUID,
  atomicJSON,
  readJSON,
  sessionId,
  relativePath,
  safeOpen,
  freeSpace,
  removeTree,
} from "./common.js";
import { LANGUAGES, childEnvironment, runtimes, runFile } from "./runtime.js";
import { runTrace, validateTrace } from "./tracer/adapter.js";

export const MAX_OUTPUT = 1024 * 1024;
const FINAL = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed-out",
  "interrupted",
]);
const COMPILED = new Set(["go", "rust", "cpp", "csharp", "java"]);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function validatePayload(value) {
  if (!value || typeof value !== "object")
    throw new RunnerError("Auftragsdaten fehlen.", 400, "INVALID_REQUEST", {
      messageKey: "runner:job.missing",
      params: {},
    });
  sessionId(value.sessionId);
  const type = value.type || (value.file ? "file" : "command");
  if (!["file", "command", "trace", "test"].includes(type))
    throw new RunnerError("Unbekannte Auftragsart.", 400, "INVALID_REQUEST", {
      messageKey: "runner:job.type",
      params: {},
    });
  const result = {
    sessionId: value.sessionId,
    type,
    actor: value.actor || "user",
    executionTimeout: value.executionTimeout ?? 30000,
    compilationTimeout: value.compilationTimeout ?? 60000,
  };
  if (!["user", "ai"].includes(result.actor))
    throw new RunnerError("Ungültiger Akteur.", 400, "INVALID_REQUEST", {
      messageKey: "runner:job.actor",
      params: {},
    });
  for (const key of ["executionTimeout", "compilationTimeout"])
    if (
      !Number.isInteger(result[key]) ||
      result[key] < (key === "compilationTimeout" ? 1000 : 0) ||
      result[key] > 600000
    )
      throw new RunnerError(
        "Ungültiges Zeitlimit (höchstens 600.000 ms).",
        400,
        "INVALID_REQUEST",
        { messageKey: "runner:job.timeout", params: {} },
      );
  if (type === "test") {
    result.test = validateTest(value.test, (m, metadata) => {
      throw new RunnerError(m, 400, "INVALID_REQUEST", metadata);
    });
    result.language = "python";
    result.executionTimeout = 30000;
  } else if (type === "trace") {
    result.trace = validateTrace(value.trace, (message, metadata) => {
      throw new RunnerError(message, 400, "INVALID_REQUEST", metadata);
    });
    result.language = "python";
    result.executionTimeout = 10000;
  } else if (type === "file") {
    result.file = relativePath(value.file);
    if (!LANGUAGES.includes(value.language))
      throw new RunnerError(
        "Sprache nicht unterstützt.",
        400,
        "INVALID_REQUEST",
        { messageKey: "runner:job.language", params: {} },
      );
    result.language = value.language;
  } else {
    if (
      typeof value.command !== "string" ||
      !value.command.trim() ||
      value.command.length > 10000 ||
      value.command.includes("\0")
    )
      throw new RunnerError(
        "Ein gültiger Befehl ist erforderlich.",
        400,
        "INVALID_REQUEST",
        { messageKey: "runner:job.command", params: {} },
      );
    result.command = value.command;
  }
  return result;
}
export class JobManager {
  constructor(config) {
    this.config = config;
    this.jobs = new Map();
    this.blocked = new Set();
    this.state = "starting";
    this.queue = Promise.resolve();
    this.closed = false;
    this.maintenance = false;
  }
  serial(fn) {
    const result = this.queue.catch(() => {}).then(fn);
    this.queue = result;
    return result;
  }
  async initialize() {
    await fs.mkdir(path.join(this.config.stateDir, "jobs"), {
      recursive: true,
      mode: 0o700,
    });
    this.blocked = new Set(
      await readJSON(
        path.join(this.config.stateDir, "blocked-sessions.json"),
        [],
      ),
    );
    await fs.mkdir(this.config.tempDir, { recursive: true, mode: 0o770 });
    if (process.platform === "linux" && process.getuid() === 0) {
      const cache = await safeOpen(this.config.toolCacheDir, "", true);
      try {
        for (const name of [
          "home",
          "runtime",
          "go-build",
          "go",
          "go-mod",
          "cargo",
          "rustup",
          "dotnet",
          "nuget",
          "npm",
          "pip",
        ]) {
          const target = `/proc/self/fd/${cache.fd}/${name}`;
          try {
            await fs.mkdir(target, { mode: 0o2770 });
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
          const handle = await fs.open(
            target,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            await handle.chown(10002, 10001);
            await handle.chmod(name === "runtime" ? 0o700 : 0o2770);
          } finally {
            await handle.close();
          }
        }
      } finally {
        await cache.close();
      }
    }
    // This directory is a dedicated execution volume; never clean workspaces.
    for (const item of await fs.readdir(this.config.tempDir))
      await removeTree(this.config.tempDir, item);
    for (const file of await fs.readdir(
      path.join(this.config.stateDir, "jobs"),
    )) {
      if (!file.endsWith(".json")) continue;
      const job = await readJSON(path.join(this.config.stateDir, "jobs", file));
      if (!UUID.test(job.id) || !job.hash || !job.payload)
        throw Object.assign(new Error("Beschädigtes Runner-Auftragsjournal."), {
          messageKey: "runner:job.journalCorrupt",
          params: {},
        });
      if (!FINAL.has(job.state)) {
        job.state = "interrupted";
        job.reason = "runner_restarted";
        job.exitCode = -1;
        job.endedAt = Date.now();
        await this.persist(job);
      }
      this.jobs.set(job.id, job);
    }
    await this.expire();
    this.expiryTimer = setInterval(() => {
      void this.serial(() => this.expire()).catch(() => {
        this.state = "error";
        this.initializationError = {
          code: "JOURNAL_WRITE_FAILED",
          message:
            "Die Auftragsbereinigung konnte nicht dauerhaft protokolliert werden.",
          messageKey: "runner:job.cleanupJournal",
          params: {},
        };
      });
    }, 60000);
    this.expiryTimer.unref();
  }
  async persist(job) {
    const {
      child,
      done,
      decoder,
      stderrDecoder,
      outputBuffers,
      lastExitCode,
      stopping,
      ...record
    } = job;
    await atomicJSON(
      path.join(this.config.stateDir, "jobs", `${job.id}.json`),
      record,
    );
  }
  active() {
    return [...this.jobs.values()].filter((job) => !FINAL.has(job.state));
  }
  async expire() {
    for (const job of this.jobs.values())
      if (
        job.endedAt &&
        Date.now() - job.endedAt > 300000 &&
        !job.outputExpired
      ) {
        delete job.output;
        delete job.traceData;
        delete job.testResults;
        if (job.payload.type === "test") {
          job.payload.test.files = job.payload.test.files.map(({ path }) => ({
            path,
          }));
          job.payload.test.suite.cases = [];
        }
        if (job.payload.type === "trace")
          job.payload.trace.files = job.payload.trace.files.map(({ path }) => ({
            path,
          }));
        job.outputExpired = true;
        await this.persist(job);
      }
  }
  snapshot(job, offset = 0) {
    if (!Number.isInteger(offset) || offset < 0)
      throw new RunnerError(
        "Ungültige Ausgabeposition.",
        400,
        "INVALID_REQUEST",
        { messageKey: "runner:job.offset", params: {} },
      );
    const output = Buffer.from(job.output || "", "utf8");
    // Clients use byte offsets. If an arbitrary offset lands inside a codepoint,
    // skip continuation bytes instead of returning a replacement character.
    let start = Math.min(offset, output.length);
    while (start < output.length && (output[start] & 0xc0) === 0x80) start++;
    return {
      processId: job.id,
      sessionId: job.payload.sessionId,
      command:
        job.payload.command ||
        `${job.payload.language} ${job.payload.trace?.entry || job.payload.test?.suite.entry.path || job.payload.file}`,
      actor: job.payload.actor,
      output: output.subarray(start).toString("utf8"),
      systemMessages: (job.systemMessages || []).filter(
        (item) => item.outputOffset >= offset,
      ),
      offset: job.bytes || 0,
      nextOffset: job.bytes || 0,
      exited: FINAL.has(job.state),
      state: job.state,
      exitCode: job.exitCode ?? null,
      reason: job.reason || null,
      truncated: Boolean(job.truncated),
      outputExpired: Boolean(job.outputExpired),
      ...(job.testResults === undefined
        ? {}
        : { testResults: job.testResults }),
      ...(job.traceData === undefined ? {} : { traceData: job.traceData }),
    };
  }
  owned(id, session) {
    sessionId(session);
    const job = this.jobs.get(id);
    if (!job || job.payload.sessionId !== session)
      throw new RunnerError("Prozess nicht gefunden.", 404, "NOT_FOUND", {
        messageKey: "runner:job.notFound",
        params: {},
      });
    return job;
  }
  async start(id, value) {
    if (!UUID.test(id))
      throw new RunnerError(
        "Ungültige Idempotenz-ID.",
        400,
        "INVALID_REQUEST",
        { messageKey: "runner:job.idempotency", params: {} },
      );
    const payload = validatePayload(value),
      hash = createHash("sha256").update(canonical(payload)).digest("hex");
    return this.serial(async () => {
      const existing = this.jobs.get(id);
      if (existing) {
        if (existing.hash !== hash)
          throw new RunnerError(
            "Die Auftrags-ID wurde bereits mit anderen Daten verwendet.",
            409,
            "IDEMPOTENCY_CONFLICT",
            { messageKey: "runner:job.conflict", params: {} },
          );
        return this.snapshot(existing);
      }
      if (this.closed || this.state !== "ready" || this.maintenance)
        throw new RunnerError(
          "Der Runner ist in Wartung oder wird wiederhergestellt.",
          503,
          "RUNNER_NOT_READY",
          { messageKey: "runner:job.maintenance", params: {} },
        );
      if (this.blocked.has(payload.sessionId))
        throw new RunnerError(
          "Diese Session ist für Ausführungen gesperrt.",
          409,
          "SESSION_BLOCKED",
          { messageKey: "runner:job.blocked", params: {} },
        );
      const active = this.active();
      if (active.some((job) => job.payload.sessionId === payload.sessionId))
        throw new RunnerError(
          "In dieser Session läuft bereits ein Prozess.",
          409,
          "SESSION_BUSY",
          { messageKey: "runner:job.running", params: {} },
        );
      if (
        active.length >= 4 ||
        (COMPILED.has(payload.language) &&
          active.filter((job) => COMPILED.has(job.payload.language)).length >=
            2)
      )
        throw new RunnerError(
          "Der Runner ist ausgelastet. Bitte einen laufenden Auftrag beenden.",
          429,
          "RUNNER_BUSY",
          { messageKey: "runner:job.capacity", params: {} },
        );
      const root = path.join(this.config.workspaceDir, payload.sessionId),
        handle = await safeOpen(root, "", true);
      await handle.close();
      await freeSpace(this.config.tempDir, 16 * 1024 * 1024);
      let runtime;
      if (["file", "trace", "test"].includes(payload.type)) {
        runtime = (await runtimes()).find(
          (r) => r.language === payload.language,
        );
        if (!runtime?.available)
          throw new RunnerError(
            runtime?.reason || "Laufzeit fehlt.",
            400,
            "RUNTIME_MISSING",
            {
              messageKey: runtime?.reasonKey || "runner:runtime.missing",
              params: runtime?.reasonParams || {},
            },
          );
      }
      const job = {
        id,
        hash,
        payload,
        state: "accepted",
        acceptedAt: Date.now(),
        output: "",
        bytes: 0,
        decoder: new StringDecoder("utf8"),
        truncated: false,
      };
      // The durable acceptance and capacity reservation are one serialized action.
      // An fsync failure prevents any spawn.
      await this.persist(job);
      this.jobs.set(id, job);
      job.done = this.execute(job, root, runtime);
      return this.snapshot(job);
    });
  }
  append(job, chunk, stderr = false) {
    if (job.testOutputRemaining !== undefined) {
      const accepted = chunk.subarray(0, job.testOutputRemaining);
      job.testOutputRemaining -= accepted.length;
      if (chunk.length > accepted.length) job.testOutputTruncated = true;
      job.output += job.decoder.write(accepted);
      job.bytes = Buffer.byteLength(job.output);
      return;
    }

    const remaining = MAX_OUTPUT - (job.receivedBytes || 0);
    if (remaining <= 0) {
      job.truncated = true;
      return;
    }
    const accepted = chunk.subarray(0, remaining);
    job.receivedBytes = (job.receivedBytes || 0) + accepted.length;
    const decoder = stderr
      ? (job.stderrDecoder ||= new StringDecoder("utf8"))
      : job.decoder;
    const text = decoder.write(accepted);
    job.output += text;
    job.bytes = Buffer.byteLength(job.output, "utf8");
    if (chunk.length >= remaining) job.truncated = true;
    // Pipes remain drained after reaching the cap; no producer deadlock.
  }
  async execute(job, root, runtime) {
    try {
      if (job.stopping) return;
      job.state = "starting";
      await this.persist(job);
      job.exitCode =
        job.payload.type === "test"
          ? await runTests(
              job,
              job.payload.test,
              runtime,
              this.config.tempDir,
              (cmd, args, cwd, timeout) =>
                this.launch(job, cmd, args, cwd, timeout),
              true,
            )
          : job.payload.type === "trace"
            ? await runTrace(
                job,
                job.payload.trace,
                runtime,
                this.config.tempDir,
                (cmd, args, cwd, timeout) =>
                  this.launch(job, cmd, args, cwd, timeout),
                true,
              )
            : job.payload.type === "file"
              ? await runFile(this, job, root, runtime)
              : await this.launch(
                  job,
                  "bash",
                  ["--noprofile", "--norc", "-c", job.payload.command],
                  root,
                  job.payload.executionTimeout,
                );
      if (job.exitCode === 137 && !job.reason)
        job.reason = "resource_limit_or_sigkill";
      job.state =
        job.reason === "timeout"
          ? "timed-out"
          : job.stopping
            ? "cancelled"
            : job.exitCode === 0
              ? "succeeded"
              : "failed";
    } catch (error) {
      (job.systemMessages ||= []).push({
        message: error.message,
        ...(error.messageKey
          ? { messageKey: error.messageKey, params: error.params || {} }
          : {}),
        outputOffset: job.bytes || 0,
      });
      job.exitCode = -1;
      job.state = job.stopping ? "cancelled" : "failed";
    } finally {
      if (["trace", "test"].includes(job.payload.type))
        await removeTree(this.config.tempDir, job.id).catch(() => {});
      // Do not flush an incomplete final UTF-8 sequence at the cap.
      const tail = job.decoder.end() + (job.stderrDecoder?.end() || "");
      if (!job.truncated && Buffer.byteLength(job.output + tail) <= MAX_OUTPUT)
        job.output += tail;
      job.bytes = Buffer.byteLength(job.output);
      job.endedAt = Date.now();
      if (!FINAL.has(job.state))
        job.state = job.stopping ? "cancelled" : "failed";
      try {
        await this.persist(job);
      } catch (error) {
        this.state = "error";
        this.initializationError = {
          code: "JOURNAL_WRITE_FAILED",
          message:
            "Das Auftragsergebnis konnte nicht dauerhaft protokolliert werden.",
          messageKey: "runner:job.resultJournal",
          params: {},
        };
        console.error("Runner journal failure", {
          code: error.code || "JOURNAL_WRITE_FAILED",
        });
      }
    }
    return this.snapshot(job);
  }
  async launch(job, command, args, cwd, timeout) {
    if (job.stopping) return -1;
    // Persist 'running' before spawn. A crash in this window is deliberately
    // interrupted on restart, never implicitly replayed.
    job.state = "running";
    await this.persist(job);
    if (job.stopping) return -1;
    return new Promise((resolve) => {
      const child = spawn(this.config.launcher, [cwd, command, ...args], {
        env: childEnvironment(this.config, cwd),
        stdio: ["pipe", "pipe", "pipe"],
      });
      job.child = child;
      child.stdin.on("error", () => {});
      const timer =
        timeout > 0
          ? setTimeout(() => {
              job.reason = "timeout";
              job.stopping = true;
              child.kill("SIGTERM");
            }, timeout)
          : null;
      child.stdout.on("data", (d) => this.append(job, d));
      child.stderr.on("data", (d) => this.append(job, d, true));
      child.on("error", (error) => {
        (job.systemMessages ||= []).push({
          message: `Start fehlgeschlagen: ${error.message}`,
          messageKey: "runner:job.startFailed",
          params: { message: error.message },
          outputOffset: job.bytes || 0,
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        job.child = null;
        job.lastExitCode = code ?? -1;
        resolve(job.lastExitCode);
      });
    });
  }
  async read(id, session, offset) {
    const job = this.owned(id, session);
    if (job.endedAt && Date.now() - job.endedAt > 300000 && !job.outputExpired)
      await this.serial(() => this.expire());
    return this.snapshot(job, offset);
  }
  async input(id, session, input) {
    const job = this.owned(id, session);
    if (typeof input !== "string" || input.length > 65536)
      throw new RunnerError("Ungültige Eingabe.", 400, "INVALID_REQUEST", {
        messageKey: "runner:job.input",
        params: {},
      });
    if (FINAL.has(job.state) || !job.child?.stdin?.writable)
      throw new RunnerError(
        "Der Prozess erwartet keine Eingabe.",
        400,
        "INVALID_REQUEST",
        { messageKey: "runner:job.noInput", params: {} },
      );
    await new Promise((resolve, reject) =>
      job.child.stdin.write(`${input}\n`, (error) =>
        error
          ? reject(
              new RunnerError(
                "Die Prozesseingabe wurde geschlossen.",
                409,
                "INPUT_CLOSED",
                { messageKey: "runner:job.inputClosed", params: {} },
              ),
            )
          : resolve(),
      ),
    );
    return this.snapshot(job);
  }
  async stop(id, session) {
    const job = this.owned(id, session);
    if (FINAL.has(job.state)) return this.snapshot(job);
    job.stopping = true;
    if (job.reason !== "timeout") job.reason = "stopped";
    job.child?.kill("SIGTERM");
    // The subreaper sends TERM, waits 1.5 s, then KILL to all descendants.
    // Do not KILL the monitor, which would orphan those descendants.
    let timer;
    try {
      await Promise.race([
        job.done,
        new Promise((resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new RunnerError(
                  "Prozessende noch nicht bestätigt.",
                  503,
                  "STOP_PENDING",
                  { messageKey: "runner:job.notStopped", params: {} },
                ),
              ),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return this.snapshot(job);
  }
  async block(session) {
    sessionId(session);
    await this.serial(async () => {
      this.blocked.add(session);
      await atomicJSON(
        path.join(this.config.stateDir, "blocked-sessions.json"),
        [...this.blocked],
      );
    });
    await this.stopSession(session);
    return { blocked: true, sessionId: session };
  }
  async unblock(session) {
    sessionId(session);
    return this.serial(async () => {
      const next = new Set(this.blocked);
      next.delete(session);
      await atomicJSON(
        path.join(this.config.stateDir, "blocked-sessions.json"),
        [...next],
      );
      this.blocked = next;
      return { blocked: false, sessionId: session };
    });
  }
  async stopSession(session) {
    sessionId(session);
    await Promise.all(
      this.active()
        .filter((job) => job.payload.sessionId === session)
        .map((job) => this.stop(job.id, session)),
    );
    return { stopped: true };
  }
  async stopAll() {
    await Promise.all(
      this.active().map((job) => this.stop(job.id, job.payload.sessionId)),
    );
    return { stopped: true };
  }
  async close() {
    this.closed = true;
    clearInterval(this.expiryTimer);
    await this.stopAll();
  }
}
