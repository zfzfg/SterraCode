import express from "express";
import { route } from "./helpers.js";
import {
  readFile,
  writeFile,
  listWorkspace,
  createFolder,
  renamePath,
  deletePath,
  undoChange,
  listChanges,
} from "../services/workspace.js";
const router = express.Router();
router.get(
  "/:sessionId/changes",
  route(async (req, res) => res.json(await listChanges(req.params.sessionId))),
);
router.get(
  "/:sessionId/files",
  route(async (req, res) =>
    res.json(await listWorkspace(req.params.sessionId)),
  ),
);
router.get(
  "/:sessionId/files/content",
  route(async (req, res) =>
    res.json(await readFile(req.params.sessionId, req.query.path)),
  ),
);
router.put(
  "/:sessionId/files/content",
  route(async (req, res) =>
    res.json(
      await writeFile(
        req.params.sessionId,
        req.body.path,
        req.body.content,
        req.body.expectedVersion,
      ),
    ),
  ),
);
router.post(
  "/:sessionId/files",
  route(async (req, res) =>
    res
      .status(201)
      .json(
        req.body.type === "folder"
          ? await createFolder(req.params.sessionId, req.body.path)
          : await writeFile(
              req.params.sessionId,
              req.body.path,
              req.body.content || "",
              null,
            ),
      ),
  ),
);
router.patch(
  "/:sessionId/files",
  route(async (req, res) =>
    res.json(
      await renamePath(
        req.params.sessionId,
        req.body.oldPath,
        req.body.newPath,
      ),
    ),
  ),
);
router.delete(
  "/:sessionId/files",
  route(async (req, res) =>
    res.json(await deletePath(req.params.sessionId, req.query.path)),
  ),
);
router.post(
  "/:sessionId/changes/:changeId/undo",
  route(async (req, res) =>
    res.json(await undoChange(req.params.sessionId, req.params.changeId)),
  ),
);
export default router;
