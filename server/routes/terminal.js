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
  route(async (req, res) => res.json(await startProcess(req.body))),
);
router.get(
  "/:processId/output",
  route(async (req, res) =>
    res.json(
      await readProcess(
        req.params.processId,
        req.query.sessionId,
        Number(req.query.offset || 0),
      ),
    ),
  ),
);
router.post(
  "/:processId/input",
  route(async (req, res) =>
    res.json(
      await inputProcess(
        req.params.processId,
        req.body.sessionId,
        req.body.input,
      ),
    ),
  ),
);
router.delete(
  "/:processId",
  route(async (req, res) =>
    res.json(await stopProcess(req.params.processId, req.body.sessionId)),
  ),
);
export default router;
