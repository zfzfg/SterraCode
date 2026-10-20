import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const bash =
  process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const script = fileURLToPath(
  new URL("../installer/hosting/install.sh", import.meta.url),
).replaceAll("\\", "/");
const folders = [];
it("keeps administrative failures in the public installation flow English", () => {
  const admin = fileURLToPath(new URL("../docker/admin.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [admin, "invalid-install-action"],
    {
      env: { ...process.env, STERRACODE_ADMIN_ENGLISH: "1" },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    'Administration command "invalid-install-action" failed',
  );
  expect(result.stderr).not.toContain("Befehle");
});
it("preserves the actual legacy image pair when source helpers first use local tags", () => {
  const helper = fileURLToPath(
    new URL("../scripts/docker-common.sh", import.meta.url),
  ).replaceAll("\\", "/");
  const result = spawnSync(
    bash,
    [
      "-c",
      `source "$STERRA_HELPER"
sterra_env() { printf 'sterra-unit'; }
docker() {
  if [ "$1" = image ]; then return 1; fi
  if [ "$1" = ps ]; then echo legacy-container; return 0; fi
  if [ "$1" = inspect ]; then echo 'sha256:existing-image'; return 0; fi
  if [ "$1" = tag ]; then echo "ALIAS:$3"; return 0; fi
  return 0
}
STERRA_COMPOSE=()
sterra_compose config --quiet`,
    ],
    {
      env: {
        ...process.env,
        STERRA_HELPER: helper,
        STERRACODE_VERSION: "local",
      },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("ALIAS:sterra-unit-app:local");
  expect(result.stdout).toContain("ALIAS:sterra-unit-runner:local");
});
afterEach(async () => {
  for (const folder of folders.splice(0))
    await fs.rm(folder, { recursive: true, force: true });
});
async function run(code) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sterra installer "));
  folders.push(temp);
  const dir = path.join(temp, "installation with spaces");
  const result = spawnSync(
    bash,
    [
      "-c",
      `${code}\nsource "$STERRA_SCRIPT" --directory "$STERRA_DIR" --bind-ip 127.0.0.1 --non-interactive`,
    ],
    {
      env: {
        ...process.env,
        STERRA_SCRIPT: script,
        STERRA_DIR: dir.replaceAll("\\", "/"),
      },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  return { result, dir };
}
it("prints Docker Desktop instructions in English without creating installation files", async () => {
  const { result, dir } = await run(`uname() { echo Darwin; }
command() { if [ "$1" = -v ] && [ "$2" = docker ]; then return 1; fi; builtin command "$@"; }`);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("Docker is not installed");
  expect(result.stdout).toContain("mac-install");
  await expect(fs.access(dir)).rejects.toThrow();
});
it("distinguishes missing Compose and a stopped daemon before downloading", async () => {
  for (const [mock, text] of [
    ["return 1", "Docker Compose v2 is missing"],
    [
      'if [ "$1" = compose ]; then return 0; fi; return 1',
      "Docker daemon is unavailable",
    ],
  ]) {
    const { result, dir } = await run(`uname() { echo Linux; }
command() { if [ "$1" = -v ] && [ "$2" = docker ]; then return 0; fi; builtin command "$@"; }
docker() { ${mock}; }`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(text);
    await expect(fs.access(dir)).rejects.toThrow();
  }
});
it("rejects Windows container mode before downloading", async () => {
  const { result } = await run(`uname() { echo Linux; }
command() { if [ "$1" = -v ] && [ "$2" = docker ]; then return 0; fi; builtin command "$@"; }
docker() { if [ "$1" = info ]; then echo 'windows x86_64'; fi; return 0; }`);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Linux Docker daemon");
});
it("verifies archive checksums before executing release images, including paths with spaces", async () => {
  const metadata = JSON.stringify(
    {
      version: "1.2.0",
      images: {
        updater: `ghcr.io/zfzfg/sterracode-updater@sha256:${"a".repeat(64)}`,
      },
      packageSHA256: "0".repeat(64),
    },
    null,
    2,
  );
  const { result } = await run(`uname() { echo Linux; }
command() { if [ "$1" = -v ] && [ "$2" = docker ]; then return 0; fi; builtin command "$@"; }
docker() { if [ "$1" = info ]; then echo 'linux aarch64'; elif [ "$1" != compose ] && [ "$1" != context ]; then echo 'UNEXPECTED_EXECUTION' >&2; return 1; fi; }
curl() { local output; while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then output=$2; shift; fi; shift; done; case "$output" in *.json) printf '%s' '${metadata}' > "$output" ;; *) printf 'corrupt' > "$output" ;; esac; }`);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("checksum mismatch");
  expect(result.stderr).not.toContain("UNEXPECTED_EXECUTION");
});
