import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compareVersions,
  validateRelease,
  latestRelease,
  updateAllowed,
} from "../shared/releases.js";
import {
  Controller,
  inWindow,
  validateSettings,
} from "../installer/runtime/controller.mjs";
import { deployment, volumeKeys } from "../installer/runtime/deployment.mjs";
import { atomic } from "../installer/runtime/io.mjs";
import { migrate } from "../installer/runtime/migrate.mjs";
import { createUpdateService } from "../server/services/updates.js";

const image = (kind) =>
  `ghcr.io/zfzfg/sterracode-${kind}@sha256:${"a".repeat(64)}`;
function release(version = "1.2.0") {
  return validateRelease({
    schema: 1,
    version,
    protocol: 1,
    minUpdaterVersion: "1.0.0",
    upgradeFrom: ["1.1.0"],
    architectures: ["amd64", "arm64"],
    images: Object.fromEntries(
      ["app", "runner", "updater"].map((k) => [k, image(k)]),
    ),
    packageSHA256: "b".repeat(64),
    packageURL: `https://github.com/zfzfg/SterraCode/releases/download/v${version}/installer.zip`,
  });
}
const temporary = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })),
  );
});
async function instance(overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-updates-"));
  temporary.push(dir);
  const config = {
    schema: 1,
    id: "test-owner",
    project: "sterra-unit",
    architecture: "amd64",
    bindIP: "127.0.0.1",
    port: 3000,
    publicURL: "http://127.0.0.1:3000",
    timeZone: "Europe/Berlin",
    release: release("1.1.0"),
    updaterImage: image("updater"),
    volumes: Object.fromEntries(volumeKeys.map((k) => [k, `sterra-unit_${k}`])),
  };
  await atomic(path.join(dir, "installation.json"), config);
  const run = vi.fn(async (args) => {
    if (args[0] === "volume" && args[1] === "inspect") {
      if (args[2].includes("_backup_") || args[2].includes("_recovery_"))
        throw new Error("Docker command failed (1): No such volume");
      return JSON.stringify([
        { Labels: { "online.sterra.installation": config.id } },
      ]);
    }
    return "";
  });
  const controller = new Controller(dir, {
    run,
    fetchRelease: async () => release(),
    ...overrides,
  });
  await controller.initialize();
  controller.internal = vi.fn(async () => ({
    busy: false,
    version: controller.config.release.version,
  }));
  controller.runner = vi.fn(async (route) =>
    route === "programs"
      ? { activeJob: null }
      : { status: "ready", protocolVersion: 1, activeJobs: [] },
  );
  await controller.check(true);
  return { controller, dir, run, config };
}
describe("trusted stable releases", () => {
  it("compares semantic versions numerically and excludes unapproved upgrades", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(() => compareVersions("1.2.3-beta", "1.2.3")).toThrow();
    expect(updateAllowed("1.1.0", release(), "arm64")).toBe(true);
    expect(updateAllowed("1.0.0", release(), "amd64")).toBe(false);
    expect(
      updateAllowed(
        "1.1.0",
        { ...release(), minUpdaterVersion: "2.0.0" },
        "amd64",
      ),
    ).toBe(false);
  });
  it("rejects arbitrary image registries, tags, archive URLs and protocols", () => {
    for (const value of [
      {
        ...release(),
        images: { ...release().images, app: "ghcr.io/attacker/app:latest" },
      },
      { ...release(), packageURL: "https://example.com/installer.zip" },
      { ...release(), protocol: 2 },
      { ...release(), architectures: ["armv7"] },
    ])
      expect(() => validateRelease(value)).toThrow();
  });
  it("verifies the GitHub asset location and tag against its metadata", async () => {
    const valid = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tag_name: "v1.2.0",
            assets: [
              {
                name: "release.json",
                size: 1000,
                browser_download_url:
                  "https://github.com/zfzfg/SterraCode/releases/download/v1.2.0/release.json",
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(release())));
    expect((await latestRelease(valid)).version).toBe("1.2.0");
    await expect(
      latestRelease(
        async () =>
          new Response(
            JSON.stringify({ tag_name: "v1.2.0", prerelease: true }),
          ),
      ),
    ).rejects.toThrow();
  });
});
describe("update transactions", () => {
  it("does not create a volume when Docker inspection fails for a reason other than absence", async () => {
    const { controller, run } = await instance();
    run.mockClear();
    run.mockRejectedValue(
      new Error("Docker command failed (1): permission denied"),
    );
    await expect(
      controller.createVolume("sterra-unit_recovery_private"),
    ).rejects.toThrow("permission denied");
    expect(run.mock.calls).toHaveLength(1);
  });
  it("coalesces concurrent requests, backs up before replacing images and resumes after success", async () => {
    const { controller, run, dir } = await instance();
    const [first, second] = await Promise.all([
      controller.install(),
      controller.install(),
    ]);
    expect(first.operation.id).toBe(second.operation.id);
    await controller.task;
    expect(controller.status().operation.phase).toBe("succeeded");
    expect(controller.status().installed).toBe("1.2.0");
    const calls = run.mock.calls.map(([args]) => args.join(" "));
    expect(
      calls.findIndex((c) => c.includes("admin backup --offline")),
    ).toBeLessThan(calls.findIndex((c) => c.includes("up -d --no-build")));
    expect(calls.some((c) => /down.*-v|system prune/.test(c))).toBe(false);
    expect(
      JSON.parse(await fs.readFile(path.join(dir, "installation.json"), "utf8"))
        .release.version,
    ).toBe("1.2.0");
    expect(controller.internal).toHaveBeenCalledWith("resume");
  });
  it("does not stop containers on failed ownership/preflight", async () => {
    const { controller, run } = await instance();
    run.mockImplementation(async () => JSON.stringify([{ Labels: {} }]));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await controller.install();
    await controller.task;
    expect(controller.status().operation.phase).toBe("failed");
    expect(run.mock.calls.some(([a]) => a.includes("stop"))).toBe(false);
  });
  it("rolls back failed health checks into new empty volumes and preserves old volumes", async () => {
    const { controller, run, config } = await instance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    controller.ready = vi.fn(async () => {
      if (!attempts++) throw new Error("Migration failed");
    });
    await controller.install();
    await controller.task;
    expect(controller.status().operation.phase).toBe("rolled-back");
    expect(controller.config.release.version).toBe("1.1.0");
    expect(controller.config.volumes["app-data"]).not.toBe(
      config.volumes["app-data"],
    );
    expect(run.mock.calls.some(([a]) => a.includes("restore"))).toBe(true);
    expect(
      run.mock.calls.some(([a]) => a[0] === "volume" && a[1] === "rm"),
    ).toBe(false);
  });
  it("keeps old services when backup verification fails", async () => {
    const { controller, run } = await instance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const original = run.getMockImplementation();
    run.mockImplementation(async (args) => {
      if (args.at(-1) === "verify-backup") throw new Error("Checksum failure");
      return original(args);
    });
    await controller.install();
    await controller.task;
    expect(controller.config.release.version).toBe("1.1.0");
    expect(controller.status().operation.phase).toBe("failed");
    expect(run.mock.calls.some(([args]) => args.includes("restore"))).toBe(
      false,
    );
  });
  it("stops after failed recovery and rejects further updates", async () => {
    const { controller } = await instance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    controller.ready = vi.fn(async () => {
      throw new Error("Broken runtime");
    });
    await controller.install();
    await controller.task;
    expect(controller.status().operation.phase).toBe("recovery-failed");
    await expect(controller.install()).rejects.toThrow("Manual recovery");
  });
  it("allows an explicit local recovery into fresh volumes and pauses automatic updates", async () => {
    const { controller } = await instance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    controller.ready = vi.fn(async () => {
      throw new Error("Disk unavailable");
    });
    await controller.install();
    await controller.task;
    expect(controller.status().operation.recoveryCommand).toContain(
      "bash manage.sh recover",
    );
    const previousVolume = controller.config.volumes["app-data"];
    controller.state.settings.enabled = true;
    controller.ready = vi.fn(async () => {});
    await controller.retryRecovery();
    expect(controller.status().operation.phase).toBe("rolled-back");
    expect(controller.state.settings.enabled).toBe(false);
    expect(controller.config.volumes["app-data"]).not.toBe(previousVolume);
    expect(controller.state.operation.recoveryGeneration).toBe(2);
  });
  it("resumes an interrupted restore into another new generation", async () => {
    const { controller, dir } = await instance();
    controller.state.operation = {
      id: "interrupted",
      phase: "restoring",
      before: controller.config,
      backup: "sterra-unit_backup_interrupted",
      recoveryGeneration: 1,
      recoveryVolumes: { "app-data": "partial" },
    };
    await controller.persist();
    await controller.recover();
    expect(controller.state.operation.recoveryGeneration).toBe(2);
    expect(controller.config.volumes["app-data"]).toContain("_2_app-data");
    expect(
      JSON.parse(await fs.readFile(path.join(dir, "updates.json"), "utf8"))
        .operation.phase,
    ).toBe("rolled-back");
  });
  it("defers for active browser leases and respects the local maintenance window", async () => {
    const { controller } = await instance();
    expect(
      inWindow(
        { hour: 4, timeZone: "Europe/Berlin" },
        new Date("2026-10-20T02:30:00Z"),
      ),
    ).toBe(true);
    controller.activity({ id: "a".repeat(36), busy: true, dirty: false });
    expect(controller.browserBusy(true)).toBe(true);
    expect(controller.browserBusy(false)).toBe(false);
    controller.activity({ id: "a".repeat(36), busy: false, dirty: true });
    expect(controller.browserBusy(false)).toBe(true);
    expect(() =>
      validateSettings({ enabled: true, hour: 24, timeZone: "UTC" }),
    ).toThrow();
    expect(() =>
      validateSettings({ enabled: true, hour: 4, timeZone: "invalid" }),
    ).toThrow();
  });
  it("defers without stopping running jobs after the drain deadline", async () => {
    let now = 0;
    const { controller, run } = await instance({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    controller.runner = vi.fn(async (route) =>
      route === "programs"
        ? { activeJob: null }
        : { status: "ready", protocolVersion: 1, activeJobs: [{}] },
    );
    await controller.install();
    await controller.task;
    expect(controller.status().operation.phase).toBe("deferred");
    expect(run.mock.calls.some(([a]) => a.includes("stop"))).toBe(false);
  });
});
describe("deployment boundary and offline fallback", () => {
  it("does not revert an earlier successful import when a new backup is invalid", async () => {
    const { controller, run, config, dir } = await instance();
    await atomic(path.join(dir, "migration.json"), {
      phase: "succeeded",
      before: { ...config, project: "obsolete-project" },
    });
    const original = run.getMockImplementation();
    run.mockImplementation(async (args) =>
      args[0] === "inspect"
        ? JSON.stringify([
            { Config: { Labels: { "online.sterra.installation": config.id } } },
          ])
        : original(args),
    );
    await expect(
      migrate(
        dir,
        vi.fn(),
        async () => {
          throw new Error("Invalid backup");
        },
        false,
        run,
      ),
    ).rejects.toThrow("Invalid backup");
    expect(run.mock.calls.some(([a]) => a.includes("compose"))).toBe(false);
    expect(
      run.mock.calls.some(
        ([a]) => a[0] === "start" && a[1] === `${config.project}-updater`,
      ),
    ).toBe(true);
    expect(controller.config.project).toBe(config.project);
  });
  it("recovers an interrupted import using untouched previous volumes", async () => {
    const { run, config, dir } = await instance();
    await atomic(path.join(dir, "migration.json"), {
      phase: "restoring",
      before: config,
    });
    const original = run.getMockImplementation();
    run.mockImplementation(async (args) =>
      args[0] === "inspect"
        ? JSON.stringify([
            { Config: { Labels: { "online.sterra.installation": config.id } } },
          ])
        : original(args),
    );
    const launch = vi.fn();
    await migrate(dir, launch, vi.fn(), true, run);
    expect(launch).toHaveBeenCalledWith(config);
    expect(
      JSON.parse(await fs.readFile(path.join(dir, "migration.json"), "utf8"))
        .phase,
    ).toBe("failed");
    expect(
      run.mock.calls.some(([a]) => a[0] === "volume" && a[1] === "rm"),
    ).toBe(false);
  });
  it("rejects an import while an update is active before stopping the updater", async () => {
    const { controller, run, config, dir } = await instance();
    controller.state.operation = { id: "pending", phase: "applying" };
    await controller.persist();
    const original = run.getMockImplementation();
    run.mockImplementation(async (args) =>
      args[0] === "inspect"
        ? JSON.stringify([
            { Config: { Labels: { "online.sterra.installation": config.id } } },
          ])
        : original(args),
    );
    await expect(migrate(dir, vi.fn(), vi.fn(), false, run)).rejects.toThrow(
      "active update",
    );
    expect(run.mock.calls.some(([a]) => a[0] === "stop")).toBe(false);
  });
  it("keeps the Docker socket outside app/runner and maps private volumes explicitly", async () => {
    const { config } = await instance();
    const value = deployment(config, release(), config.volumes);
    expect(JSON.stringify(value)).not.toContain("docker.sock");
    expect(value.services.app.environment.STERRACODE_UPDATE_PENDING).toBe("1");
    expect(value.services.app.ports).toEqual(["127.0.0.1:3000:3000"]);
    expect(value.volumes["app-data"]).toEqual({
      name: config.volumes["app-data"],
      external: true,
    });
  });
  it("continues working when release discovery is offline and caches retries", async () => {
    const { dir } = await instance();
    const discover = vi.fn(async () => {
      throw new Error("Offline");
    });
    const service = createUpdateService({ dataDir: dir }, { discover });
    await service.start();
    expect((await service.get()).error).toBe("UPDATE_CHECK_UNAVAILABLE");
    expect((await service.get()).managed).toBe(false);
    await expect(service.install()).rejects.toMatchObject({ status: 503 });
    expect(discover).toHaveBeenCalledTimes(1);
  });
});
