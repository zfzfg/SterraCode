import { localizeProcess } from "../services/messageOutput.js";
import express from "express";
import { route } from "./helpers.js";
import { startProcess, waitProcess } from "../services/processes.js";
const router = express.Router();
router.post(
  "/",
  route(async (req, res) => {
    const job = await startProcess(req.body);
    res.json(
      localizeProcess(
        await waitProcess(job.processId, req.body.sessionId),
        req.uiLocale,
      ),
    );
  }),
);
export default router;
