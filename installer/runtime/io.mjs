import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
export const missingDockerObject = (error) =>
  /no such (?:volume|object|container)/i.test(error.message);
export async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}
export async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
    if (process.platform === "linux" && process.getuid() === 0) {
      const owner = await fs.stat(path.dirname(file));
      await handle.chown(owner.uid, owner.gid);
    }
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
}
export function docker(args, { input, timeout = 30 * 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "",
      stderr = "",
      bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    for (const [stream, append] of [
      [child.stdout, (chunk) => (stdout += chunk)],
      [child.stderr, (chunk) => (stderr += chunk)],
    ])
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 ** 2) child.kill("SIGKILL");
        else append(chunk.toString());
      });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(stdout.trim())
        : reject(
            new Error(
              `Docker command failed (${code}): ${stderr.slice(-2000)}`,
            ),
          );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export function compose(
  directory,
  project,
  args,
  run = docker,
  file = "compose.json",
) {
  return run([
    "compose",
    "--project-directory",
    directory,
    "-p",
    project,
    "-f",
    path.join(directory, file),
    ...args,
  ]);
}
export async function secretMatches(header, file) {
  const { timingSafeEqual } = await import("node:crypto");
  const expected = Buffer.from(
      `Bearer ${(await fs.readFile(file, "utf8")).trim()}`,
    ),
    actual = Buffer.from(header || "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
