import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { RunnerError, safeRead, relativePath, removeTree } from "./common.js";
import { LANGUAGES, TOOL_PATH } from "./runtime.js";

const unavailable = () =>
  new RunnerError(
    "Isolated demo execution is unavailable.",
    409,
    "DEMO_ISOLATION_REQUIRED",
    { messageKey: "serverFeature:demo.isolation", params: {} },
  );
export function validateIsolatedDemo(value) {
  if (
    !value ||
    typeof value.fileVersion !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.fileVersion) ||
    Object.keys(value).some((k) => k !== "fileVersion")
  )
    throw unavailable();
  return { fileVersion: value.fileVersion };
}
// Flags are fixed by the adapter, never accepted from code, tools or the API.
// Debian 12 bubblewrap documents --unshare-user, --disable-userns and --size:
// https://manpages.debian.org/bookworm/bubblewrap/bwrap.1.en.html
export function demoSandboxArguments(sourceName, command, args = []) {
  return [
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "--die-with-parent",
    "--new-session",
    "--uid",
    "10002",
    "--gid",
    "10001",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--setenv",
    "PATH",
    TOOL_PATH,
    "--setenv",
    "HOME",
    "/build/home",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "LC_ALL",
    "C.UTF-8",
    "--setenv",
    "GOCACHE",
    "/build/go-cache",
    "--setenv",
    "GOPATH",
    "/build/go",
    "--setenv",
    "GO111MODULE",
    "off",
    "--setenv",
    "GOPROXY",
    "off",
    "--setenv",
    "GOSUMDB",
    "off",
    "--setenv",
    "DOTNET_CLI_HOME",
    "/build/dotnet",
    "--setenv",
    "DOTNET_CLI_TELEMETRY_OPTOUT",
    "1",
    "--setenv",
    "DOTNET_SKIP_FIRST_TIME_EXPERIENCE",
    "1",
    "--setenv",
    "DOTNET_NOLOGO",
    "1",
    "--setenv",
    "NUGET_PACKAGES",
    "/build/nuget",
    "--setenv",
    "DOTNET_GCHeapHardLimit",
    "0x10000000",
    "--setenv",
    "GOMEMLIMIT",
    "256MiB",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--ro-bind-try",
    "/opt/sterracode",
    "/opt/sterracode",
    "--dir",
    "/etc",
    "--ro-bind-try",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--perms",
    "1777",
    "--size",
    "16777216",
    "--tmpfs",
    "/tmp",
    "--perms",
    "1777",
    "--size",
    "268435456",
    "--tmpfs",
    "/build",
    "--dir",
    "/demo",
    "--ro-bind-data",
    "3",
    `/demo/${path.posix.basename(relativePath(sourceName))}`,
    "--remount-ro",
    "/",
    "--chdir",
    "/demo",
    "--",
    command,
    ...args,
  ];
}
export function demoCommand(language, file, runtime) {
  const source = `/demo/${path.posix.basename(relativePath(file))}`;
  const command = runtime.command;
  if (language === "python") return [command, ["-I", "-S", "-B", "-u", source]];
  if (language === "javascript")
    return [
      command,
      [
        "--max-old-space-size=128",
        "--max-semi-space-size=8",
        "--jitless",
        "--no-addons",
        "--disable-proto=throw",
        source,
      ],
    ];
  if (language === "bash") return [command, ["--noprofile", "--norc", source]];
  if (language === "lua") return [command, ["-E", source]];
  // Compiler invocations are fixed scripts with positional filenames. They see
  // one source, immutable runtime assets, and an empty bounded build directory.
  const scripts = {
    go: '"$1" build -trimpath -o /build/program "$2" && exec /build/program',
    rust: '"$1" "$2" -o /build/program && exec /build/program',
    cpp: '"$1" -std=c++17 "$2" -o /build/program && exec /build/program',
    java: 'javac -J-Xmx128m -encoding UTF-8 -d /build "$2" && exec java -Xms16m -Xmx128m -XX:CompressedClassSpaceSize=32m -XX:MaxMetaspaceSize=64m -XX:ReservedCodeCacheSize=32m -cp /build "$3"',
    csharp:
      'mkdir -p /build/project && cp -- "$2" /build/project/Program.cs && printf \'%s\' \'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><RestoreIgnoreFailedSources>true</RestoreIgnoreFailedSources></PropertyGroup></Project>\' > /build/project/Demo.csproj && "$1" build /build/project/Demo.csproj --nologo -o /build/bin --source /build/empty && exec "$1" /build/bin/Demo.dll',
  };
  if (!scripts[language]) throw unavailable();
  return [
    "/bin/sh",
    [
      "-c",
      scripts[language],
      "sterracode-demo",
      command,
      source,
      path.posix.basename(file, ".java"),
    ],
  ];
}
async function launchProbe(config, snapshot) {
  // /sys is deliberately absent. /proc/net/dev must contain only loopback;
  // validate it explicitly rather than relying on a successful bwrap spawn.
  const assertion =
    'test "$(id -u)" = 10002 && test ! -e /workspaces && test ! -e /runner-state && test ! -e /run/secrets && test ! -e /data && test ! -e /sys && test "$(grep -c : /proc/net/dev)" = 1 && grep -q "lo:" /proc/net/dev && test -z "$STERRACODE_RUNNER_SECRET_FILE"';
  const source = await fs.open(path.join(snapshot, "probe.txt"), "wx+", 0o400);
  try {
    return await new Promise((resolve) => {
      const child = spawn(
        config.launcher,
        [
          "--isolated-demo",
          snapshot,
          "/usr/bin/bwrap",
          ...demoSandboxArguments("probe.txt", "/bin/sh", ["-c", assertion]),
        ],
        {
          env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
          stdio: ["ignore", "ignore", "ignore", source.fd],
        },
      );
      const timer = setTimeout(() => child.kill("SIGTERM"), 5000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  } finally {
    await source.close();
  }
}
export async function isolatedDemoCapabilities(config, probe = launchProbe) {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    return {
      executionAllowed: false,
      adapter: "bubblewrap-v1",
      allowedLanguages: [],
      reasonCode: "DEMO_ISOLATION_REQUIRED",
      isolation: { verified: false },
    };
  const directory = path.join(config.stateDir, "demo-snapshots");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const snapshot = path.join(directory, `probe-${randomUUID()}`);
  await fs.mkdir(snapshot, { mode: 0o700 });
  try {
    const verified = await probe(config, snapshot);
    return {
      executionAllowed: verified,
      adapter: "bubblewrap-v1",
      allowedLanguages: verified ? LANGUAGES : [],
      ...(verified ? {} : { reasonCode: "DEMO_ISOLATION_REQUIRED" }),
      isolation: {
        verified,
        sourcesRestricted: verified,
        networkRestricted: verified,
        processDataBytes: 512 * 1024 ** 2,
        addressSpaceBytes: 8 * 1024 ** 3,
        temporaryBytes: 272 * 1024 ** 2,
        cpuSeconds: 30,
        processLimit: 64,
      },
    };
  } finally {
    await fs.rm(snapshot, { recursive: true, force: true });
  }
}
export async function runIsolatedDemo(manager, job, root, runtime) {
  if (!(await isolatedDemoCapabilities(manager.config)).executionAllowed)
    throw unavailable();
  const { file, language, isolatedDemo } = job.payload;
  const content = await safeRead(root, file);
  if (
    createHash("sha256").update(content).digest("hex") !==
    isolatedDemo.fileVersion
  )
    throw new RunnerError("Demo source changed.", 409, "DEMO_SOURCE_CHANGED", {
      messageKey: "serverFeature:demo.changed",
      params: {},
    });
  const parent = path.join(manager.config.stateDir, "demo-snapshots"),
    snapshot = path.join(parent, job.id);
  await fs.mkdir(snapshot, { mode: 0o700 });
  try {
    await fs.writeFile(
      path.join(snapshot, path.posix.basename(file)),
      content,
      { mode: 0o400, flag: "wx" },
    );
    const [command, args] = demoCommand(language, file, runtime);
    const source = await fs.open(
      path.join(snapshot, path.posix.basename(file)),
      "r",
    );
    try {
      return await manager.launch(
        job,
        "/usr/bin/bwrap",
        demoSandboxArguments(path.posix.basename(file), command, args),
        snapshot,
        Math.min(60000, job.payload.executionTimeout || 30000),
        { isolatedDemo: true, sourceFd: source.fd },
      );
    } finally {
      await source.close();
    }
  } finally {
    await removeTree(parent, job.id);
  }
}
