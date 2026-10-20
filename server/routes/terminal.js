import { localizeProcess } from "../services/messageOutput.js";
import express from "express";
import { route } from "./helpers.js";
import {
  startProcess,
  readProcess,
  inputProcess,
  stopProcess,
} from "../services/processes.js";
const router = express.Router();
router.post(
  "/",
  route(async (req, res) =>
    res.json(localizeProcess(await startProcess(req.body), req.uiLocale)),
  ),
);
router.get(
  "/:processId/output",
  route(async (req, res) =>
    res.json(
      localizeProcess(
        await readProcess(
          req.params.processId,
          req.query.sessionId,
          Number(req.query.offset || 0),
        ),
        req.uiLocale,
      ),
    ),
  ),
);
router.post(
  "/:processId/input",
  route(async (req, res) =>
    res.json(
      localizeProcess(
        await inputProcess(
          req.params.processId,
          req.body.sessionId,
          req.body.input,
        ),
        req.uiLocale,
      ),
    ),
  ),
);
router.delete(
  "/:processId",
  route(async (req, res) =>
    res.json(
      localizeProcess(
        await stopProcess(req.params.processId, req.body.sessionId),
        req.uiLocale,
      ),
    ),
  ),
);
export default router;
