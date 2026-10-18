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

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    });
    const host = req.hostname;
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host))
      return res
        .status(403)
        .json({ error: "Unzulässiger Host.", code: "HOST_DENIED" });
    const origin = req.get("origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`)
      return res.status(403).json({
        error: "Zugriff nur vom Ursprung der Anwendung erlaubt.",
        code: "ORIGIN_DENIED",
      });
    if (req.get("sec-fetch-site") === "cross-site")
      return res.status(403).json({
        error: "Ursprungsfremder Zugriff blockiert.",
        code: "ORIGIN_DENIED",
      });
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      req.path.startsWith("/api") &&
      !req.is("application/json")
    )
      return res.status(415).json({ error: "JSON erforderlich." });
    next();
  });
  app.use(express.json({ limit: "4mb" }));
  app.use("/api/chat", chat);
  app.use("/api/models", models);
  app.use("/api/sessions", sessions);
  app.use("/api/workspaces", workspaces);
  app.use("/api/terminal", terminal);
  app.use("/api/execute", execute);
  app.get(
    "/api/runtimes",
    route(async (req, res) => res.json(await getRuntimes())),
  );
  app.use("/api", (req, res) =>
    res
      .status(404)
      .json({ error: "API-Endpunkt nicht gefunden.", code: "NOT_FOUND" }),
  );
  const root = path.dirname(fileURLToPath(import.meta.url));
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
    res.status(status).json({
      error:
        status === 500
          ? "Interner Fehler. Bitte Serverprotokoll prüfen."
          : error.message,
      code: error.code || "SERVER_ERROR",
    });
    if (status === 500) console.error(error);
  });
  return app;
}
