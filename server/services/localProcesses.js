import { runTests } from "../../runner/grading/adapter.js";
import { validateTest } from "../../runner/grading/schema.js";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DATA_DIR,
  AppError,
  LANGUAGES,
  getSettings,
  getWorkspacePath,
  validateSessionId,
  assertSessionWritable,
} from "./storage.js";
import { readFile, resolvePath } from "./workspace.js";
import { runTrace, validateTrace } from "../../runner/tracer/adapter.js";

export const MAX_OUTPUT = 1024 * 1024;
const jobs = new Map();
const specs = {
  python: [
    ["python", ["--version"]],
    ["python3", ["--version"]],
    ["py", ["-3", "--version"]],
  ],
  javascript: [["node", ["--version"]]],
  bash: [["bash", ["--version"]]],
  go: [["go", ["version"]]],
  rust: [["rustc", ["--version"]]],
  cpp: [["g++", ["--version"]]],
  csharp: [["dotnet", ["--version"]]],
  lua: [
    ["lua", ["-v"]],
    ["lua54", ["-v"]],
    ["lua5.4", ["-v"]],
  ],
  java: [["javac", ["-version"]]],
};
export async function probe(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available, output: output.slice(0, 1000) });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 2500);
    const append = (d) => {
      output += d.toString();
      if (output.length > 8192) {
        child.kill();
        finish(false);
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}
export async function getRuntimes(probeFn = probe) {
  const settings = await getSettings();
  return Promise.all(
    LANGUAGES.map(async (language) => {
      for (const [command, args] of specs[language]) {
        const result = await probeFn(command, args);
        if (result.available) {
          if (
            language === "java" &&
            !(await probeFn("java", ["-version"])).available
          )
            continue;
          const enabled = settings.allowedLanguages.includes(language);
          return {
            language,
            modes: language === "python" ? ["file", "trace", "test"] : ["file"],
            testAdapterVersion: language === "python" ? 1 : null,
            traceAdapterVersion: language === "python" ? 1 : null,
            installed: true,
            enabled,
            available: enabled,
            command,
            version: result.output?.trim() || "",
            prefix: command === "py" ? ["-3"] : [],
            sdkMajor:
              language === "csharp"
                ? Number(result.output.match(/\d+/)?.[0])
                : null,
            reason: enabled
              ? ""
              : "Diese Sprache ist in den Einstellungen deaktiviert.",
          };
        }
      }
      return {
        language,
        installed: false,
        enabled: settings.allowedLanguages.includes(language),
        available: false,
        reason: `Laufzeit fehlt: ${language === "csharp" ? ".NET SDK" : language === "java" ? "JDK mit java und javac" : specs[language].map((s) => s[0]).join(" / ")} installieren und Anwendung neu prüfen.`,
      };
    }),
  );
}
export async function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32")
    await new Promise((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true },
      );
      killer.on("error", resolve);
      killer.on("close", resolve);
    });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
function append(job, chunk) {
  if (job.testOutputRemaining !== undefined) {
    const accepted = chunk.subarray(0, job.testOutputRemaining);
    job.testOutputRemaining -= accepted.length;
    if (chunk.length > accepted.length) job.testOutputTruncated = true;
    job.output += job.decoder.write(accepted);
    job.bytes = Buffer.byteLength(job.output);
    return;
  }

  const remaining = MAX_OUTPUT - job.bytes;
  if (remaining <= 0) return;
  const data = chunk.subarray(0, remaining);
  job.bytes += data.length;
  job.output += job.decoder.write(data);
  if (chunk.length >= remaining) {
    job.reason = "output_limit";
    void killTree(job.child);
  }
}
async function launch(
  job,
  command,
  args,
  { cwd, shell = false, timeout = 0 } = {},
) {
  if (job.stopping) return -1;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    job.child = child;
    const timer =
      timeout > 0
        ? setTimeout(() => {
            job.reason = "timeout";
            void killTree(child);
          }, timeout)
        : null;
    child.stdout.on("data", (d) => append(job, d));
    child.stderr.on("data", (d) => append(job, d));
    child.on("error", (error) => {
      append(job, Buffer.from(`\nStart fehlgeschlagen: ${error.message}\n`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      job.child = null;
      resolve(code ?? -1);
    });
  });
}
async function sourceFiles(root, extension, depth = 0) {
  if (depth > 20) throw new AppError("Projektstruktur ist zu tief.");
  const result = [];
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    if (
      e.isSymbolicLink() ||
      ["node_modules", ".git", "bin", "obj", "target"].includes(e.name)
    )
      continue;
    if (e.isDirectory())
      result.push(
        ...(await sourceFiles(path.join(root, e.name), extension, depth + 1)),
      );
    else if (e.name.endsWith(extension)) result.push(path.join(root, e.name));
    if (result.length > 1000) throw new AppError("Zu viele Quelldateien.");
  }
  return result;
}
const xml = (value) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
async function runCode(job, root, file, language, runtime, settings) {
  const { full } = await resolvePath(root, file);
  await readFile(job.sessionId, file);
  const build = path.join(DATA_DIR, "runs", job.id);
  await fs.mkdir(build, { recursive: true });
  const compile = (cmd, args) =>
    launch(job, cmd, args, { cwd: root, timeout: settings.compilationTimeout });
  const run = (cmd, args) =>
    launch(job, cmd, args, { cwd: root, timeout: settings.executionTimeout });
  try {
    let args = [...(runtime.prefix || []), full];
    if (language === "go")
      args = [
        "run",
        ...(await fs.readdir(path.dirname(full)))
          .filter((n) => n.endsWith(".go") && !n.endsWith("_test.go"))
          .map((n) => path.join(path.dirname(full), n)),
      ];
    if (language === "rust" || language === "cpp") {
      const binary = path.join(
        build,
        process.platform === "win32" ? "program.exe" : "program",
      );
      const sources =
        language === "cpp" ? await sourceFiles(root, ".cpp") : [full];
      const code = await compile(runtime.command, [
        ...(language === "cpp" ? ["-std=c++17"] : []),
        ...sources,
        "-o",
        binary,
      ]);
      if (code !== 0) return code;
      return await run(binary, []);
    }
    if (language === "java") {
      const code = await compile("javac", [
        "-encoding",
        "UTF-8",
        "-d",
        build,
        ...(await sourceFiles(root, ".java")),
      ]);
      if (code !== 0) return code;
      const content = await fs.readFile(full, "utf8");
      const pkg = content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
      return await run("java", [
        "-cp",
        build,
        `${pkg ? pkg + "." : ""}${path.basename(file, ".java")}`,
      ]);
    }
    if (language === "csharp") {
      if (!runtime.sdkMajor || runtime.sdkMajor < 6)
        throw new AppError("Ein .NET SDK ab Version 6 wird benötigt.");
      const projects = await sourceFiles(root, ".csproj");
      let project = projects[0];
      if (!project) {
        project = path.join(build, "SterraCodeRun.csproj");
        const sources = await sourceFiles(root, ".cs");
        await fs.writeFile(
          project,
          `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net${runtime.sdkMajor}.0</TargetFramework><EnableDefaultCompileItems>false</EnableDefaultCompileItems><AssemblyName>SterraCodeRun</AssemblyName></PropertyGroup><ItemGroup>${sources.map((f) => `<Compile Include="${xml(f)}" />`).join("")}</ItemGroup></Project>`,
        );
      }
      const code = await compile(runtime.command, [
        "build",
        project,
        "--nologo",
        "-o",
        build,
      ]);
      if (code !== 0) return code;
      const runtimeConfig = (await fs.readdir(build)).find((n) =>
        n.endsWith(".runtimeconfig.json"),
      );
      if (!runtimeConfig)
        throw new AppError("Keine ausführbare .NET-Anwendung erzeugt.");
      return await run(runtime.command, [
        path.join(build, runtimeConfig.replace(".runtimeconfig.json", ".dll")),
      ]);
    }
    return await run(runtime.command, args);
  } finally {
    await fs.rm(build, { recursive: true, force: true }).catch(() => {});
  }
}
export async function startProcess({
  sessionId,
  command,
  file,
  language,
  actor = "user",
  test,
  trace,
  idempotencyId,
}) {
  const root = await getWorkspacePath(sessionId);
  const settings = await getSettings();
  if (test) {
    test = validateTest(test, (m) => {
      throw new AppError(m);
    });
    file = test.suite.entry.path;
    language = "python";
  }
  if (trace) {
    trace = validateTrace(trace, (message) => {
      throw new AppError(message);
    });
    file = trace.entry;
    language = "python";
  }
  if (idempotencyId) validateSessionId(idempotencyId);
  const request = JSON.stringify({
    sessionId,
    command,
    file,
    language,
    actor,
    test,
    trace,
  });
  if (idempotencyId && jobs.has(idempotencyId)) {
    const previous = jobs.get(idempotencyId);
    if (previous.request !== request)
      throw new AppError(
        "Die Auftrags-ID wurde bereits mit anderen Daten verwendet.",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    return snapshot(previous);
  }
  if (actor === "ai" && !settings.allowAITerminalCommands)
    throw new AppError(
      "KI-Terminalbefehle sind deaktiviert.",
      403,
      "TERMINAL_DISABLED",
    );
  if ([...jobs.values()].some((j) => j.sessionId === sessionId && !j.exited))
    throw new AppError(
      "In dieser Session läuft bereits ein Prozess. Bitte zuerst stoppen.",
      409,
    );
  let runtime;
  if (file) {
    runtime = (await getRuntimes()).find((r) => r.language === language);
    if (!runtime?.available)
      throw new AppError(
        runtime?.reason || "Sprache nicht unterstützt.",
        400,
        "RUNTIME_MISSING",
      );
  } else if (
    typeof command !== "string" ||
    !command.trim() ||
    command.length > 10000
  )
    throw new AppError("Ein gültiger Befehl ist erforderlich.");
  await assertSessionWritable(sessionId);
  if (
    (trace || test) &&
    [...jobs.values()].filter((j) => !j.exited).length >= 4
  )
    throw new AppError(
      "Die lokale Ausführung ist ausgelastet.",
      429,
      "RUNNER_BUSY",
    );
  if ([...jobs.values()].some((j) => j.sessionId === sessionId && !j.exited))
    throw new AppError("In dieser Session läuft bereits ein Prozess.", 409);
  const job = {
    id: idempotencyId || randomUUID(),
    request,
    sessionId,
    actor,
    command: command || `${language} ${file}`,
    output: "",
    bytes: 0,
    decoder: new StringDecoder("utf8"),
    exited: false,
    exitCode: null,
    reason: null,
    child: null,
    stopping: false,
  };
  jobs.set(job.id, job);
  job.done = (async () => {
    try {
      job.exitCode = test
        ? await runTests(
            job,
            test,
            runtime,
            path.join(DATA_DIR, "trace-processes"),
            (cmd, args, cwd, timeout) =>
              launch(job, cmd, args, { cwd, timeout }),
          )
        : trace
          ? await runTrace(
              job,
              trace,
              runtime,
              path.join(DATA_DIR, "trace-processes"),
              (cmd, args, cwd, timeout) =>
                launch(job, cmd, args, { cwd, timeout }),
            )
          : file
            ? await runCode(job, root, file, language, runtime, settings)
            : await launch(job, command, [], {
                cwd: root,
                shell: true,
                timeout: settings.executionTimeout,
              });
    } catch (error) {
      append(job, Buffer.from(`\n${error.message}\n`));
      job.exitCode = -1;
    } finally {
      if (trace || test)
        await fs
          .rm(path.join(DATA_DIR, "trace-processes", job.id), {
            recursive: true,
            force: true,
          })
          .catch(() => {});
      job.output += job.decoder.end();
      job.exited = true;
      job.endedAt = Date.now();
    }
    return snapshot(job);
  })();
  return snapshot(job);
}
function owned(id, sessionId) {
  const job = jobs.get(id);
  if (!job || job.sessionId !== sessionId)
    throw new AppError("Prozess nicht gefunden.", 404);
  return job;
}
function snapshot(job, offset = 0) {
  return {
    processId: job.id,
    sessionId: job.sessionId,
    command: job.command,
    actor: job.actor,
    output: job.output.slice(offset),
    offset: job.output.length,
    exited: job.exited,
    exitCode: job.exitCode,
    reason: job.reason,
    ...(job.testResults === undefined ? {} : { testResults: job.testResults }),
    ...(job.traceData === undefined ? {} : { traceData: job.traceData }),
  };
}
export function readProcess(id, sessionId, offset = 0) {
  if (!Number.isInteger(offset) || offset < 0)
    throw new AppError("Ungültige Ausgabeposition.");
  return snapshot(owned(id, sessionId), offset);
}
export function inputProcess(id, sessionId, input) {
  const job = owned(id, sessionId);
  if (job.exited || !job.child?.stdin?.writable)
    throw new AppError("Der Prozess erwartet keine Eingabe.");
  if (typeof input !== "string" || input.length > 65536)
    throw new AppError("Ungültige Eingabe.");
  job.child.stdin.write(input + "\n");
  return snapshot(job);
}
export async function stopProcess(id, sessionId) {
  const job = owned(id, sessionId);
  job.stopping = true;
  job.reason = "stopped";
  await killTree(job.child);
  await job.done;
  return snapshot(job);
}
export async function waitProcess(id, sessionId) {
  return owned(id, sessionId).done;
}
export async function stopAllProcesses() {
  await Promise.all(
    [...jobs.values()]
      .filter((j) => !j.exited)
      .map((j) => stopProcess(j.id, j.sessionId)),
  );
}
export async function stopSessionProcesses(sessionId) {
  await Promise.all(
    [...jobs.values()]
      .filter((j) => j.sessionId === sessionId && !j.exited)
      .map((j) => stopProcess(j.id, sessionId)),
  );
}
setInterval(() => {
  for (const [id, j] of jobs)
    if (j.exited && Date.now() - j.endedAt > 300000) jobs.delete(id);
}, 60000).unref();
