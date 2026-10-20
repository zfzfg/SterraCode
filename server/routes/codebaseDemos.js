import express from "express";
import { route } from "./helpers.js";
import {
  createCodebaseDemo,
  listCodebaseDemos,
  getExecutionCapabilities,
  requestRuntimeInstallation,
  listCodebaseActions,
  decideCodebaseAction,
  runCodebaseDemo,
} from "../services/codebaseDemos.js";

const router = express.Router();
router.get(
  "/capabilities",
  route(async (req, res) => res.json(await getExecutionCapabilities())),
);
router.get(
  "/sessions/:id/demos",
  route(async (req, res) =>
    res.json({ demos: await listCodebaseDemos(req.params.id) }),
  ),
);
router.post(
  "/sessions/:id/demos",
  route(async (req, res) =>
    res.status(201).json(await createCodebaseDemo(req.params.id, req.body)),
  ),
);
router.post(
  "/sessions/:id/demos/:demoId/runtime-request",
  route(async (req, res) =>
    res
      .status(201)
      .json(
        await requestRuntimeInstallation(
          req.params.id,
          req.params.demoId,
          req.body,
        ),
      ),
  ),
);
router.get(
  "/sessions/:id/actions",
  route(async (req, res) =>
    res.json({ actions: await listCodebaseActions(req.params.id) }),
  ),
);
router.post(
  "/sessions/:id/actions/:requestId/decision",
  route(async (req, res) =>
    res.json(
      await decideCodebaseAction(
        req.params.id,
        req.params.requestId,
        req.body.decision,
      ),
    ),
  ),
);
router.post(
  "/sessions/:id/demos/:demoId/run",
  route(async (req, res) =>
    res
      .status(202)
      .json(await runCodebaseDemo(req.params.id, req.params.demoId, req.body)),
  ),
);
export default router;
