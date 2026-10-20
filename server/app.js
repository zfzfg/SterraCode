import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chat from "./routes/chat.js";
import models from "./routes/models.js";
import sessions from "./routes/sessions.js";
import workspaces from "./routes/workspaces.js";
import terminal from "./routes/terminal.js";
import execute from "./routes/execute.js";
import { route } from "./routes/helpers.js";
import { getRuntimes } from "./services/processes.js";
import { loadConfig, normalizeHost } from "./config.js";
import { createAuthService } from "./services/auth.js";
import {
  createAuthRouter,
  requireAuthentication,
  createAccountRouter,
} from "./routes/auth.js";
import { createServerRouter } from "./routes/server.js";
import programs from "./routes/programs.js";
import provider from "./routes/provider.js";
import profile from "./routes/profile.js";
import projects from "./routes/projects.js";
import {
  localeMiddleware,
  namespaces,
  catalogRoot,
  errorPayload,
} from "./services/i18n.js";
import { LOCALES } from "../shared/i18n/locale.js";
import { createUpdateService, applicationVersion } from "./services/updates.js";
import { createUpdatesRouter } from "./routes/updates.js";
import { activeTurnCount } from "./services/teacher.js";
import { localizeFields } from "./services/messageOutput.js";
import codebaseImports, {
  codebaseSessionTreeRouter,
} from "./routes/codebaseImports.js";
import codebase from "./routes/codebase.js";
import gitCredentials from "./routes/gitCredentials.js";
import codebaseDemos from "./routes/codebaseDemos.js";
import { listActiveCodebaseJobs } from "./services/codebaseJobs.js";

export function createApp({
  config = loadConfig(),
  auth = createAuthService({ dataDir: config.dataDir }),
  updates = createUpdateService(config),
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(localeMiddleware);
  app.locals.updates = updates;
  let updateMaintenance = process.env.STERRACODE_UPDATE_PENDING === "1";
  let activeMutations = 0;
  // Dedicated service authentication, independent of browser sessions and Host headers.
  app.post(
    "/internal/updates",
    express.json({ limit: "1kb" }),
    route(async (req, res) => {
      if (!(await updates.internalAuthorized(req.get("authorization"))))
        return res.status(401).json({ error: "Authentication required." });
      if (req.body.action === "drain") updateMaintenance = true;
      else if (req.body.action === "resume") updateMaintenance = false;
      else if (req.body.action !== "status")
        return res.status(400).json({ error: "Unknown action." });
      res.json({
        busy:
          activeMutations > 0 ||
          activeTurnCount() > 0 ||
          listActiveCodebaseJobs().length > 0,
        version: applicationVersion,
      });
    }),
  );
  let maintenance = false;
  app.locals.beginMaintenance = () => {
    maintenance = true;
  };
  app.set("trust proxy", config.trustedProxies);
  app.get("/api/health", (req, res, next) =>
    req.method === "GET" ? res.json({ ok: true }) : next(),
  );
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    });
    const host = normalizeHost(req.hostname);
    if (!config.allowedHosts.has(host))
      return res.status(403).json({
        error: req.t("errors:http.host"),
        messageKey: "errors:http.host",
        params: {},
        code: "HOST_DENIED",
      });
    const origin = req.get("origin");
    const proxyTrusted = app.get("trust proxy fn")(req.socket.remoteAddress, 0);
    const requestHost =
      proxyTrusted && req.get("x-forwarded-host")
        ? req.get("x-forwarded-host").split(",")[0].trim()
        : req.get("host");
    const requestOrigin = `${req.protocol}://${requestHost}`;
    res.locals.appOrigin = new URL(requestOrigin).origin;
    if (
      origin &&
      (origin !== requestOrigin ||
        (config.authRequired && !config.allowedOrigins.has(origin)))
    )
      return res.status(403).json({
        error: req.t("errors:http.origin"),
        messageKey: "errors:http.origin",
        params: {},
        code: "ORIGIN_DENIED",
      });
    if (req.get("sec-fetch-site") === "cross-site")
      return res.status(403).json({
        error: req.t("errors:http.crossSite"),
        messageKey: "errors:http.crossSite",
        params: {},
        code: "ORIGIN_DENIED",
      });
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      req.path.startsWith("/api") &&
      !req.is("application/json") &&
      !(
        ((req.method === "PUT" &&
          /^\/api\/codebase\/imports\/[a-f0-9-]{36}\/upload$/.test(req.path)) ||
          (req.method === "POST" &&
            /^\/api\/codebase\/imports\/[a-f0-9-]{36}\/archive$/.test(
              req.path,
            ))) &&
        req.is("application/zip")
      )
    )
      return res.status(415).json({
        error: req.t("errors:http.json"),
        messageKey: "errors:http.json",
        params: {},
      });
    next();
  });
  app.use(express.json({ limit: "4mb" }));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (maintenance)
      return res.status(503).json({
        error: req.t("errors:http.maintenance"),
        messageKey: "errors:http.maintenance",
        params: {},
        code: "SERVER_MAINTENANCE",
      });
    next();
  });
  app.use("/api", createAuthRouter(config, auth));
  app.use("/api", requireAuthentication(config, auth));
  app.use("/api/updates", createUpdatesRouter(updates));
  app.use("/api", (req, res, next) => {
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (updateMaintenance && mutation)
      return res.status(503).json({
        error: req.t("updates:maintenance"),
        messageKey: "updates:maintenance",
        params: {},
        code: "SERVER_MAINTENANCE",
      });
    if (mutation) {
      activeMutations++;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          activeMutations--;
        }
      };
      res.once("finish", release);
      res.once("close", release);
    }
    next();
  });
  app.use("/api", createAccountRouter(config, auth));
  app.use("/api", createServerRouter(config));
  app.use("/api/programs", programs);
  app.use("/api/provider", provider);
  app.use("/api/profile", profile);
  app.use("/api/projects", projects);
  app.use("/api/codebase/imports", codebaseImports);
  app.use("/api/codebase/sessions", codebase);
  app.use("/api/codebase/sessions", codebaseSessionTreeRouter);
  app.use("/api/codebase", codebaseDemos);
  app.use("/api/git-credentials", gitCredentials);
  app.use("/api/chat", chat);
  app.use("/api/models", models);
  app.use("/api/sessions", sessions);
  app.use("/api/workspaces", workspaces);
  app.use("/api/terminal", terminal);
  app.use("/api/execute", execute);
  app.get(
    "/api/runtimes",
    route(async (req, res) =>
      res.json(
        (await getRuntimes()).map((runtime) =>
          localizeFields(runtime, req.uiLocale, ["reason"]),
        ),
      ),
    ),
  );
  app.use("/api", (req, res) =>
    res.status(404).json({
      error: req.t("errors:http.notFound"),
      messageKey: "errors:http.notFound",
      params: {},
      code: "NOT_FOUND",
    }),
  );
  const root = path.dirname(fileURLToPath(import.meta.url));
  app.get("/vendor/i18next.js", (req, res) =>
    res.sendFile(
      path.join(root, "../node_modules/i18next/dist/esm/i18next.js"),
    ),
  );
  app.get("/i18n/locale.js", (req, res) =>
    res.sendFile(path.join(root, "../shared/i18n/locale.js")),
  );
  app.get("/i18n/manifest.json", (req, res) =>
    res.json({ locales: Object.keys(LOCALES), namespaces }),
  );
  app.get("/i18n/locales/:locale/:namespace.json", (req, res) => {
    if (
      !Object.hasOwn(LOCALES, req.params.locale) ||
      !namespaces.includes(req.params.namespace)
    )
      return res.sendStatus(404);
    res.set("Content-Language", req.params.locale);
    res.sendFile(
      path.join(catalogRoot, req.params.locale, `${req.params.namespace}.json`),
    );
  });
  app.use(
    "/monaco",
    express.static(path.join(root, "../node_modules/monaco-editor/min")),
  );
  app.use(express.static(path.join(root, "../public")));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status =
      error.status ||
      { ENOENT: 404, EEXIST: 409, EACCES: 403, EPERM: 403 }[error.code] ||
      500;
    const nativeKey =
      !error.messageKey &&
      ({
        "entity.parse.failed": "errors:http.invalidJson",
        "entity.too.large": "errors:http.requestTooLarge",
      }[error.type] ||
        {
          ENOENT: "errors:file.notFound",
          EEXIST: "errors:file.exists",
          EACCES: "errors:file.accessDenied",
          EPERM: "errors:file.accessDenied",
        }[error.code]);
    const safeError = nativeKey
      ? { messageKey: nativeKey, params: {}, code: error.code }
      : error;
    res.status(status).json({
      ...errorPayload(safeError, req.uiLocale),
      ...(status === 500
        ? {
            error: req.t("errors:http.internal"),
            messageKey: "errors:http.internal",
            params: {},
          }
        : {}),
      code: error.code || "SERVER_ERROR",
    });
    if (status === 500)
      console.error("Interner Serverfehler", {
        code: error.code || "SERVER_ERROR",
      });
  });
  return app;
}
