import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JobManager } from "./jobs.js";
import { ProgramManager } from "./programs.js";
import { RunnerError, UUID } from "./common.js";
import { runtimes } from "./runtime.js";

export function configuration(env = process.env) {
  return {
    workspaceDir: env.STERRACODE_WORKSPACE_DIR || "/workspaces",
    stateDir: env.RUNNER_STATE_DIR || "/runner-state",
    cacheDir: env.RUNNER_CACHE_DIR || "/package-cache",
    toolCacheDir: env.RUNNER_TOOL_CACHE_DIR || "/tool-cache",
    tempDir: env.RUNNER_TEMP_DIR || "/runs",
    launcher: env.RUNNER_LAUNCHER || "/usr/local/bin/sterra-launch",
    secretFile: env.STERRACODE_RUNNER_SECRET_FILE || "/run/secrets/runner_key",
    imageDigest: env.RUNNER_IMAGE_DIGEST,
    host: env.RUNNER_HOST || "0.0.0.0",
    port: Number(env.RUNNER_PORT || 3001),
    maxCacheBytes: Number(env.RUNNER_MAX_CACHE_BYTES || 8 * 1024 ** 3),
  };
}
async function body(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024)
      throw new RunnerError("Runner-Anfrage zu groß.", 413, "BODY_TOO_LARGE", {
        messageKey: "runner:request.large",
        params: {},
      });
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RunnerError("Ungültiges JSON.", 400, "INVALID_REQUEST", {
      messageKey: "runner:request.json",
      params: {},
    });
  }
}
function send(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Runner-Protocol": "1",
  });
  res.end(JSON.stringify(value));
}
export async function createRunner(config = configuration(), overrides = {}) {
  const stat = await fs.stat(config.secretFile);
  if (
    !stat.isFile() ||
    (process.platform === "linux" &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))
  )
    throw Object.assign(
      new Error(
        "Runner-Dienstschlüssel muss dem Steuerbenutzer gehören und Modus 0400/0600 haben.",
      ),
      { messageKey: "runner:auth.permissions", params: {} },
    );
  const secret = (await fs.readFile(config.secretFile, "utf8")).trim();
  if (secret.length < 32)
    throw Object.assign(new Error("Runner-Dienstschlüssel ist zu kurz."), {
      messageKey: "runner:auth.short",
      params: {},
    });
  const jobs = overrides.jobs || new JobManager(config);
  const programs = overrides.programs || new ProgramManager(config, jobs);
  const server = http.createServer(async (req, res) => {
    try {
      const actual = Buffer.from(req.headers.authorization || ""),
        expected = Buffer.from(`Bearer ${secret}`);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new RunnerError(
          "Runner-Dienstauthentifizierung erforderlich.",
          401,
          "UNAUTHORIZED",
          { messageKey: "runner:auth.required", params: {} },
        );
      if (
        req.headers["x-runner-protocol"] &&
        req.headers["x-runner-protocol"] !== "1"
      )
        throw new RunnerError(
          "App und Runner verwenden inkompatible Protokolle.",
          409,
          "PROTOCOL_MISMATCH",
          { messageKey: "runner:protocol.incompatible", params: {} },
        );
      const url = new URL(req.url, "http://runner"),
        route = url.pathname,
        method = req.method;
      if (route === "/v1/health" && method === "GET")
        return send(res, 200, { ok: true });
      if (route === "/v1/status" && method === "GET")
        return send(res, 200, {
          protocolVersion: 1,
          status: jobs.state,
          error: jobs.initializationError || null,
          activeJobs: jobs.active().map((j) => jobs.snapshot(j)),
          blockedSessions: [...jobs.blocked],
          maintenance: jobs.maintenance,
        });
      if (route === "/v1/runtimes" && method === "GET")
        return send(
          res,
          200,
          (await runtimes()).map((runtime) => ({
            ...runtime,
            available: runtime.available && jobs.state === "ready",
            reason:
              jobs.state === "ready"
                ? runtime.reason
                : "Runner wird wiederhergestellt oder befindet sich in Wartung.",
            reasonKey:
              jobs.state === "ready"
                ? runtime.reasonKey
                : "runner:runtime.recovering",
            reasonParams: jobs.state === "ready" ? runtime.reasonParams : {},
            runnerStatus: jobs.state,
          })),
        );
      if (route === "/v1/jobs" && method === "GET")
        return send(res, 200, {
          jobs: jobs
            .active()
            .filter(
              (job) =>
                !url.searchParams.get("sessionId") ||
                job.payload.sessionId === url.searchParams.get("sessionId"),
            )
            .map((job) => jobs.snapshot(job)),
        });
      if (route === "/v1/jobs" && method === "POST") {
        const value = await body(req);
        return send(
          res,
          200,
          await jobs.start(value.id || req.headers["idempotency-key"], value),
        );
      }
      const jobRoute = route.match(
        /^\/v1\/jobs\/([^/]+)(?:\/(output|input))?$/,
      );
      if (jobRoute) {
        const [, id, action] = jobRoute;
        if (!UUID.test(id))
          throw new RunnerError(
            "Ungültige Auftrags-ID.",
            400,
            "INVALID_REQUEST",
            { messageKey: "runner:job.invalidId", params: {} },
          );
        if (method === "GET" && (!action || action === "output"))
          return send(
            res,
            200,
            await jobs.read(
              id,
              url.searchParams.get("sessionId"),
              Number(url.searchParams.get("offset") || 0),
            ),
          );
        const value = await body(req);
        if (method === "POST" && action === "input")
          return send(
            res,
            200,
            await jobs.input(id, value.sessionId, value.input),
          );
        if (method === "DELETE" && !action)
          return send(res, 200, await jobs.stop(id, value.sessionId));
      }
      const sessionRoute = route.match(
        /^\/v1\/sessions\/([^/]+)\/(block|stop)$/,
      );
      if (sessionRoute) {
        const [, id, action] = sessionRoute;
        if (action === "block" && method === "POST")
          return send(res, 200, await jobs.block(id));
        if (action === "block" && method === "DELETE")
          return send(res, 200, await jobs.unblock(id));
        if (action === "stop" && method === "POST")
          return send(res, 200, await jobs.stopSession(id));
      }
      if (route === "/v1/stop" && method === "POST")
        return send(res, 200, await jobs.stopAll());
      if (route === "/v1/maintenance" && method === "POST") {
        const value = await body(req);
        await jobs.serial(async () => {
          jobs.maintenance = true;
          jobs.state = "maintenance";
        });
        if (value.stopRunning) await jobs.stopAll();
        return send(res, 200, {
          status: jobs.state,
          blockingJobs: jobs.active().map((j) => jobs.snapshot(j)),
        });
      }
      if (route === "/v1/maintenance" && method === "DELETE") {
        if (
          programs.activeJob &&
          !["succeeded", "failed", "cancelled", "interrupted"].includes(
            programs.activeJob.state,
          )
        )
          throw new RunnerError("Paketaktion läuft.", 409, "PACKAGE_BUSY", {
            messageKey: "runner:programs.busy",
            params: {},
          });
        jobs.maintenance = false;
        if (!jobs.initializationError) jobs.state = "ready";
        return send(res, 200, { status: jobs.state });
      }
      if (route === "/v1/programs" && method === "GET")
        return send(res, 200, await programs.status());
      const programRoute = route.match(/^\/v1\/programs\/([^/]+)\/actions$/);
      if (programRoute && method === "POST")
        return send(
          res,
          202,
          await programs.action(programRoute[1], await body(req)),
        );
      const operationRoute = route.match(
        /^\/v1\/program-jobs\/([^/]+)(?:\/(cancel))?$/,
      );
      if (operationRoute && method === "GET" && !operationRoute[2])
        return send(res, 200, programs.getJob(operationRoute[1]));
      if (operationRoute && method === "POST" && operationRoute[2])
        return send(res, 200, await programs.cancel(operationRoute[1]));
      if (route === "/v1/cache" && method === "GET")
        return send(res, 200, await programs.cacheStatus());
      if (route === "/v1/cache" && method === "DELETE")
        return send(res, 200, await programs.cleanCache());
      throw new RunnerError(
        "Runner-Endpunkt nicht gefunden.",
        404,
        "NOT_FOUND",
        { messageKey: "runner:request.notFound", params: {} },
      );
    } catch (error) {
      if (!res.headersSent)
        send(res, error.status || 500, {
          error: error.status ? error.message : "Interner Runner-Fehler.",
          code: error.code || "RUNNER_ERROR",
          messageKey: error.status
            ? error.messageKey
            : "runner:request.internal",
          params: error.status ? error.params || {} : {},
        });
    }
  });
  server.requestTimeout = 21 * 60 * 1000;
  server.headersTimeout = 15000;
  const initialize = async () => {
    try {
      await jobs.initialize();
      await programs.initialize();
    } catch (error) {
      jobs.state = "error";
      jobs.initializationError = {
        code: error.code || "INITIALIZATION_FAILED",
        message: error.message,
        ...(error.messageKey
          ? { messageKey: error.messageKey, params: error.params || {} }
          : {}),
      };
      console.error("Runner initialization failed", {
        code: error.code || "INITIALIZATION_FAILED",
      });
    }
  };
  return {
    server,
    jobs,
    programs,
    initialize,
    close: async () => {
      await jobs.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.platform !== "linux" || process.getuid() !== 0)
    throw new Error(
      "Der Docker-Runner benötigt Linux und einen privilegierten Steuerprozess.",
    );
  const config = configuration();
  const runner = await createRunner(config);
  runner.server.listen(config.port, config.host, () =>
    console.log(
      `SterraCode Runner protocol v1 on ${config.host}:${config.port}`,
    ),
  );
  void runner.initialize();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await runner.close();
      process.exit(0);
    } catch (error) {
      console.error("Runner shutdown failed", {
        code: error.code || "SHUTDOWN_FAILED",
      });
      process.exit(1);
    }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
