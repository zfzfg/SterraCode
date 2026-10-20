import express from "express";
import { route } from "./helpers.js";
import { AppError, LANGUAGES } from "../services/storage.js";
import {
  localizeProgramJob,
  localizeProgramStatus,
} from "../services/messageOutput.js";

const router = express.Router();
async function request(endpoint, options) {
  if (!process.env.STERRACODE_RUNNER_URL)
    throw new AppError(
      "Die Programmverwaltung steht im Dockerbetrieb zur Verfügung. Beim lokalen Start werden die installierten Hostprogramme verwendet.",
      409,
      "LOCAL_MODE",
      { messageKey: "serverFeature:programs.localMode", params: {} },
    );
  const { runnerRequest } = await import("../services/runnerClient.js");
  return runnerRequest(endpoint, options);
}
router.get(
  "/",
  route(async (req, res) =>
    res.json(
      localizeProgramStatus(await request("/v1/programs"), req.uiLocale),
    ),
  ),
);
router.post(
  "/:id/actions",
  route(async (req, res) => {
    if (
      !LANGUAGES.includes(req.params.id) ||
      !["install", "remove", "retry", "repair"].includes(req.body.action)
    )
      throw new AppError(
        "Unbekanntes Programm oder unbekannte Aktion.",
        undefined,
        undefined,
        { messageKey: "serverFeature:programs.invalidAction", params: {} },
      );
    res.status(202).json(
      localizeProgramJob(
        await request(`/v1/programs/${req.params.id}/actions`, {
          method: "POST",
          body: {
            action: req.body.action,
            stopRunning: req.body.stopRunning === true,
            clearCache: req.body.clearCache === true,
          },
        }),
        req.uiLocale,
      ),
    );
  }),
);
router.get(
  "/jobs/:id",
  route(async (req, res) => {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id))
      throw new AppError("Ungültiger Auftrag.", undefined, undefined, {
        messageKey: "serverFeature:programs.invalidJob",
        params: {},
      });
    res.json(
      localizeProgramJob(
        await request(`/v1/program-jobs/${req.params.id}`),
        req.uiLocale,
      ),
    );
  }),
);
router.post(
  "/jobs/:id/cancel",
  route(async (req, res) => {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id))
      throw new AppError("Ungültiger Auftrag.", undefined, undefined, {
        messageKey: "serverFeature:programs.invalidJob",
        params: {},
      });
    res.json(
      localizeProgramJob(
        await request(`/v1/program-jobs/${req.params.id}/cancel`, {
          method: "POST",
          body: {},
        }),
        req.uiLocale,
      ),
    );
  }),
);
router.get(
  "/cache",
  route(async (req, res) => res.json(await request("/v1/cache"))),
);
router.delete(
  "/cache",
  route(async (req, res) =>
    res.json(await request("/v1/cache", { method: "DELETE", body: {} })),
  ),
);
export default router;
