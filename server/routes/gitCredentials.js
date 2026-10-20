import express from "express";
import { route } from "./helpers.js";
import {
  listGitCredentials,
  saveGitCredential,
  deleteGitCredential,
  unlockGitCredential,
  generateGitCredential,
  gitSecretTransportAllowed,
  gitError,
} from "../services/gitCredentials.js";

const router = express.Router();
router.get(
  "/",
  route(async (req, res) =>
    res.json({
      ...(await listGitCredentials()),
      transportAllowed: gitSecretTransportAllowed(req),
    }),
  ),
);
router.use((req, res, next) => {
  if (!gitSecretTransportAllowed(req))
    return next(gitError("transport", "GIT_SECURE_TRANSPORT_REQUIRED", 403));
  next();
});
router.post(
  "/generate",
  route(async (req, res) =>
    res.status(201).json(await generateGitCredential(req.body)),
  ),
);
router.post(
  "/",
  route(async (req, res) =>
    res.status(201).json(await saveGitCredential(req.body)),
  ),
);
router.put(
  "/:id",
  route(async (req, res) =>
    res.json(
      await saveGitCredential(
        req.body,
        req.params.id,
        req.body.expectedVersion,
      ),
    ),
  ),
);
router.post(
  "/:id/unlock",
  route(async (req, res) =>
    res.json(
      await unlockGitCredential(
        req.params.id,
        req.body.passphrase,
        req.body.expectedVersion,
      ),
    ),
  ),
);
router.delete(
  "/:id",
  route(async (req, res) =>
    res.json(
      await deleteGitCredential(req.params.id, req.body.expectedVersion),
    ),
  ),
);
export default router;
