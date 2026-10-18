import express from "express";
import { route } from "./helpers.js";
import { startProcess, waitProcess } from "../services/processes.js";
const router = express.Router();
router.post(
  "/",
  route(async (req, res) => {
    const job = await startProcess(req.body);
    res.json(await waitProcess(job.processId, req.body.sessionId));
  }),
);
export default router;
