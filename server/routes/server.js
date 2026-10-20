import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getServerConfig } from "../config.js";
import { getSettings } from "../services/storage.js";
import {
  testLMStudioConnection,
  lmStudioWarning,
} from "../services/lmStudio.js";
import { route } from "./helpers.js";
import { testOpenAIConnection } from "../services/openAI.js";
import {
  localizeFields,
  localizeRunnerStatus,
} from "../services/messageOutput.js";

async function writable(directory) {
  const file = path.join(directory, `.diagnostic-${randomUUID()}`);
  try {
    await fs.writeFile(file, "", { flag: "wx", mode: 0o600 });
    return { writable: true };
  } catch {
    return {
      writable: false,
      error: "Volume ist nicht beschreibbar.",
      errorKey: "serverFeature:diagnostics.volumeReadOnly",
      errorParams: {},
    };
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}
export function createServerRouter(config) {
  const router = express.Router();
  router.get("/server", (req, res) =>
    res.json(localizeFields(getServerConfig(config), req.uiLocale, ["source"])),
  );
  router.post(
    "/lm-studio/test",
    route(async (req, res) => {
      const settings = await getSettings();
      if (req.body.url !== undefined) settings.lmStudioUrl = req.body.url;
      res.json(
        localizeFields(await testLMStudioConnection(settings), req.uiLocale, [
          "error",
          "warning",
        ]),
      );
    }),
  );
  router.get(
    "/diagnostics",
    route(async (req, res) => {
      const settings = await getSettings();
      const [data, workspaces, lmStudio] = await Promise.all([
        writable(config.dataDir),
        writable(config.workspacesDir),
        settings.provider === "openai"
          ? testOpenAIConnection(settings)
          : testLMStudioConnection(settings),
      ]);
      let runner = { status: "local", protocolVersion: null };
      if (config.docker) {
        try {
          const { runnerRequest } = await import("../services/runnerClient.js");
          runner = await runnerRequest("/v1/status");
        } catch (error) {
          runner = {
            status: "unavailable",
            code: error.code || "RUNNER_UNAVAILABLE",
            error:
              "Runner ist nicht erreichbar. Datei- und Sessionarbeit bleibt möglich.",
            errorKey: "serverFeature:diagnostics.runnerUnavailable",
            errorParams: {},
          };
        }
      }
      res.json({
        server: localizeFields(getServerConfig(config), req.uiLocale, [
          "source",
        ]),
        volumes: {
          data: localizeFields(data, req.uiLocale, ["error"]),
          workspaces: localizeFields(workspaces, req.uiLocale, ["error"]),
        },
        runner: localizeRunnerStatus(runner, req.uiLocale),
        lmStudio: localizeFields(lmStudio, req.uiLocale, ["error", "warning"]),
        warnings: [
          settings.provider !== "openai" &&
            lmStudioWarning(settings.lmStudioUrl, config.docker) &&
            req.t("serverFeature:lmStudio.containerAddress"),
        ].filter(Boolean),
      });
    }),
  );
  return router;
}
