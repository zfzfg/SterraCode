import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { drainServer } from "../server/services/shutdown.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture(handler = (req, res) => res.end("ok")) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sterracode-stop-"));
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const app = { locals: { beginMaintenance: vi.fn() } };
  return {
    app,
    server,
    dataDir,
    url: `http://127.0.0.1:${server.address().port}`,
    cleanup: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}
describe("bounded consistent shutdown", () => {
  it("waits for active HTTP writes and Runner confirmation before marking a backup-safe state", async () => {
    const entered = deferred(),
      release = deferred(),
      stopStarted = deferred(),
      stopRelease = deferred();
    let completed = false;
    const f = await fixture(async (req, res) => {
      entered.resolve();
      await release.promise;
      await fs.writeFile(path.join(f.dataDir, "completed.json"), '{"ok":true}');
      res.end("saved");
    });
    try {
      const request = fetch(f.url, { method: "POST", body: "write" });
      await entered.promise;
      const shutdown = drainServer({
        ...f,
        abortChats: vi.fn(),
        stopJobs: async () => {
          stopStarted.resolve();
          await stopRelease.promise;
        },
      }).then((value) => {
        completed = true;
        return value;
      });
      await stopStarted.promise;
      expect(f.app.locals.beginMaintenance).toHaveBeenCalledOnce();
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(f.dataDir, "shutdown-state.json"),
            "utf8",
          ),
        ).state,
      ).toBe("draining");
      stopRelease.resolve();
      await Promise.resolve();
      expect(completed).toBe(false);
      release.resolve();
      expect(await (await request).text()).toBe("saved");
      expect(await shutdown).toBe(true);
      expect(
        JSON.parse(
          await fs.readFile(path.join(f.dataDir, "completed.json"), "utf8"),
        ),
      ).toEqual({ ok: true });
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(f.dataDir, "shutdown-state.json"),
            "utf8",
          ),
        ).state,
      ).toBe("clean");
    } finally {
      release.resolve();
      stopRelease.resolve();
      await f.cleanup();
    }
  });
  it("leaves the state unclean if jobs cannot be confirmed or the deadline expires", async () => {
    for (const stopJobs of [
      async () => {
        throw new Error("runner offline");
      },
      () => new Promise(() => {}),
    ]) {
      const f = await fixture();
      try {
        expect(
          await drainServer({
            ...f,
            abortChats: vi.fn(),
            stopJobs,
            timeoutMs: 30,
          }),
        ).toBe(false);
        expect(
          JSON.parse(
            await fs.readFile(
              path.join(f.dataDir, "shutdown-state.json"),
              "utf8",
            ),
          ).state,
        ).toBe("draining");
      } finally {
        await f.cleanup();
      }
    }
  });
});
