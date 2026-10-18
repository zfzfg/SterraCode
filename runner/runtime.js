import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  RunnerError,
  safeRead,
  sources,
  safeOpen,
  removeTree,
} from "./common.js";

export const LANGUAGES = [
  "python",
  "javascript",
  "bash",
  "go",
  "rust",
  "cpp",
  "csharp",
  "lua",
  "java",
];
export const SPECS = {
  python: [
    ["python", ["--version"]],
    ["python3", ["--version"]],
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
export const TOOL_PATH =
  "/opt/sterracode/go/bin:/opt/sterracode/rust/bin:/usr/local/bin:/usr/bin:/bin";
export function childEnvironment(config, workspace) {
  const cache = config.toolCacheDir;
  return {
    PATH: TOOL_PATH,
    HOME: `${cache}/home`,
    XDG_RUNTIME_DIR: `${cache}/runtime`,
    TMPDIR: config.tempDir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    BASH_ENV: "",
    GOCACHE: `${cache}/go-build`,
    GOPATH: `${cache}/go`,
    GOMODCACHE: `${cache}/go-mod`,
    CARGO_HOME: `${cache}/cargo`,
    RUSTUP_HOME: `${cache}/rustup`,
    DOTNET_CLI_HOME: `${cache}/dotnet`,
    NUGET_PACKAGES: `${cache}/nuget`,
    npm_config_cache: `${cache}/npm`,
    PIP_CACHE_DIR: `${cache}/pip`,
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: workspace,
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}
export async function probe(command, args) {
  return new Promise((resolve) => {
    const config = {
      toolCacheDir: process.env.RUNNER_TOOL_CACHE_DIR || "/tool-cache",
      tempDir: process.env.RUNNER_TEMP_DIR || "/runs",
      launcher: process.env.RUNNER_LAUNCHER || "/usr/local/bin/sterra-launch",
    };
    const privileged = process.platform === "linux" && process.getuid() === 0;
    let output = "",
      settled = false;
    const child = spawn(
      privileged ? config.launcher : command,
      privileged ? [config.toolCacheDir, command, ...args] : args,
      {
        env: childEnvironment(config, config.toolCacheDir),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available, output: output.slice(0, 1000) });
    };
    const timer = setTimeout(() => {
      child.kill(privileged ? "SIGTERM" : "SIGKILL");
      finish(false);
    }, 2500);
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > 8192) {
        child.kill(privileged ? "SIGTERM" : "SIGKILL");
        finish(false);
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}
export async function runtimes(probeFn = probe) {
  return Promise.all(
    LANGUAGES.map(async (language) => {
      for (const [command, args] of SPECS[language]) {
        const result = await probeFn(command, args);
        if (
          !result.available ||
          (language === "java" &&
            !(await probeFn("java", ["-version"])).available)
        )
          continue;
        return {
          language,
          installed: true,
          enabled: true,
          available: true,
          command,
          prefix: [],
          version: result.output.trim(),
          sdkMajor:
            language === "csharp"
              ? Number(result.output.match(/\d+/)?.[0])
              : null,
          reason: "",
        };
      }
      return {
        language,
        installed: false,
        enabled: true,
        available: false,
        reason: `Laufzeit fehlt: ${language === "java" ? "JDK mit java und javac" : language === "csharp" ? ".NET SDK" : SPECS[language].map(([cmd]) => cmd).join(" / ")} installieren.`,
      };
    }),
  );
}
const xml = (s) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
export async function runFile(manager, job, root, runtime) {
  const { file, language, compilationTimeout, executionTimeout } = job.payload;
  await safeRead(root, file);
  const full = path.join(root, file);
  const build = path.join(manager.config.tempDir, job.id);
  await fs.mkdir(build, { mode: 0o770 });
  if (process.platform === "linux") {
    const directory = await safeOpen(build, "", true);
    try {
      await directory.chown(10002, 10001);
    } finally {
      await directory.close();
    }
  }
  const compile = (command, args) =>
    manager.launch(job, command, args, root, compilationTimeout);
  const run = (command, args) =>
    manager.launch(job, command, args, root, executionTimeout);
  try {
    if (language === "go") {
      const parent = path.posix.dirname(file);
      const candidates = (await sources(root, ".go")).filter(
        (s) => path.posix.dirname(s) === parent && !s.endsWith("_test.go"),
      );
      const binary = path.join(build, "program");
      if (
        await compile(runtime.command, [
          "build",
          "-o",
          binary,
          ...candidates.map((f) => path.join(root, f)),
        ])
      )
        return job.lastExitCode;
      return await run(binary, []);
    }
    if (language === "rust" || language === "cpp") {
      const binary = path.join(build, "program");
      const files =
        language === "cpp"
          ? (await sources(root, ".cpp")).map((f) => path.join(root, f))
          : [full];
      if (
        await compile(runtime.command, [
          ...(language === "cpp" ? ["-std=c++17"] : []),
          ...files,
          "-o",
          binary,
        ])
      )
        return job.lastExitCode;
      return await run(binary, []);
    }
    if (language === "java") {
      const content = await safeRead(root, file),
        pkg = content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
      if (
        await compile("javac", [
          "-encoding",
          "UTF-8",
          "-d",
          build,
          ...(await sources(root, ".java")).map((f) => path.join(root, f)),
        ])
      )
        return job.lastExitCode;
      return await run("java", [
        "-cp",
        build,
        `${pkg ? `${pkg}.` : ""}${path.basename(file, ".java")}`,
      ]);
    }
    if (language === "csharp") {
      if (!runtime.sdkMajor || runtime.sdkMajor < 6)
        throw new RunnerError("Ein .NET SDK ab Version 6 wird benötigt.");
      let project = (await sources(root, ".csproj"))[0];
      if (project) project = path.join(root, project);
      else {
        project = path.join(build, "SterraCodeRun.csproj");
        // O_EXCL prevents another unprivileged session replacing a generated
        // project with a symlink before the privileged write.
        const directory = await safeOpen(build, "", true);
        let handle;
        try {
          handle = await fs.open(
            process.platform === "linux"
              ? `/proc/self/fd/${directory.fd}/SterraCodeRun.csproj`
              : project,
            "wx",
            0o664,
          );
          await handle.writeFile(
            `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net${runtime.sdkMajor}.0</TargetFramework><EnableDefaultCompileItems>false</EnableDefaultCompileItems><AssemblyName>SterraCodeRun</AssemblyName><BaseIntermediateOutputPath>${xml(build)}/obj/</BaseIntermediateOutputPath></PropertyGroup><ItemGroup>${(await sources(root, ".cs")).map((f) => `<Compile Include="${xml(path.join(root, f))}" />`).join("")}</ItemGroup></Project>`,
          );
        } finally {
          await handle?.close();
          await directory.close();
        }
      }
      if (
        await compile(runtime.command, [
          "build",
          project,
          "--nologo",
          "-o",
          build,
        ])
      )
        return job.lastExitCode;
      const dir = await safeOpen(build, "", true);
      let config;
      try {
        config = (await fs.readdir(`/proc/self/fd/${dir.fd}`)).find((n) =>
          n.endsWith(".runtimeconfig.json"),
        );
      } finally {
        await dir.close();
      }
      if (!config)
        throw new RunnerError("Keine ausführbare .NET-Anwendung erzeugt.");
      return await run(runtime.command, [
        path.join(build, config.replace(".runtimeconfig.json", ".dll")),
      ]);
    }
    return await run(runtime.command, [full]);
  } finally {
    await removeTree(manager.config.tempDir, job.id);
  }
}
