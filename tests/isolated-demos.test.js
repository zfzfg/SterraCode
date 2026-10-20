import { it, expect } from "vitest";
import {
  demoSandboxArguments,
  demoCommand,
  validateIsolatedDemo,
} from "../runner/isolatedDemo.js";
import { validatePayload } from "../runner/jobs.js";
import { randomUUID } from "node:crypto";

it("pins the immutable source FD and removes shared filesystems, network and environment", () => {
  const args = demoSandboxArguments("main.py", "python3", [
    "-I",
    "/demo/main.py",
  ]);
  for (const flag of [
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "--new-session",
    "--die-with-parent",
    "--clearenv",
    "--cap-drop",
    "--remount-ro",
  ])
    expect(args).toContain(flag);
  expect(
    args.slice(
      args.indexOf("--ro-bind-data"),
      args.indexOf("--ro-bind-data") + 3,
    ),
  ).toEqual(["--ro-bind-data", "3", "/demo/main.py"]);
  for (const directory of [
    "/workspaces",
    "/data",
    "/run/secrets",
    "/runner-state",
    "/tool-cache",
    "/runs",
    "/root",
  ])
    expect(args).not.toContain(directory);
  expect(args).toContain("16777216");
  expect(args).toContain("268435456");
});
it("validates demo payload hashes and never accepts commands, mount paths or runtime flags", () => {
  const value = {
    sessionId: randomUUID(),
    type: "demo",
    language: "python",
    file: "main.py",
    isolatedDemo: { fileVersion: "a".repeat(64) },
  };
  expect(validatePayload(value).isolatedDemo).toEqual(value.isolatedDemo);
  for (const isolatedDemo of [
    { fileVersion: "bad" },
    { fileVersion: "a".repeat(64), command: "curl" },
    { fileVersion: "a".repeat(64), mount: "/data" },
  ])
    expect(() => validateIsolatedDemo(isolatedDemo)).toThrow();
  expect(() =>
    validatePayload({ ...value, file: "../other/main.py" }),
  ).toThrow();
});
it("runs interpreters without project startup configuration and uses fixed compiler scripts", () => {
  expect(demoCommand("python", "src/main.py", { command: "python3" })).toEqual([
    "python3",
    ["-I", "-S", "-B", "-u", "/demo/main.py"],
  ]);
  const [command, args] = demoCommand("cpp", "weird;name.cpp", {
    command: "g++",
  });
  expect(command).toBe("/bin/sh");
  expect(args[1]).not.toContain("weird");
  expect(args).toContain("/demo/weird;name.cpp");
});
