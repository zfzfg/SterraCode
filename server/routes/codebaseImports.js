import express from "express";
import { route } from "./helpers.js";
import {
  createCodebaseImport,
  listCodebaseImports,
  getCodebaseImport,
  uploadCodebaseArchive,
  codebaseImportTree,
  updateCodebaseSelection,
  commitCodebaseImport,
  cancelCodebaseImport,
  deleteCodebaseImport,
  codebaseImportPreview,
} from "../services/codebaseImports.js";
import {
  workspaceTreePage,
  workspaceMetadata,
} from "../services/codebaseTree.js";

const router = express.Router();
router.get(
  "/",
  route(async (req, res) => res.json(await listCodebaseImports())),
);
router.get(
  "/capabilities",
  route(async (req, res) => {
    const { getGitImportCapabilities } =
      await import("../services/gitImports.js");
    res.json(await getGitImportCapabilities());
  }),
);
router.post(
  "/",
  route(async (req, res) =>
    res.status(202).json(await createCodebaseImport(req.body)),
  ),
);
router.get(
  "/:importId",
  route(async (req, res) =>
    res.json(await getCodebaseImport(req.params.importId)),
  ),
);
const upload = route(async (req, res) => {
  if (!req.is("application/zip"))
    return res.status(415).json({
      code: "IMPORT_UPLOAD_CONTENT_TYPE",
      messageKey: "features:codebase.errors.import",
      params: { reason: "IMPORT_UPLOAD_CONTENT_TYPE" },
    });
  const contentLength = req.get("content-length");
  res.status(202).json(
    await uploadCodebaseArchive(req.params.importId, req, {
      contentLength:
        contentLength === undefined ? undefined : Number(contentLength),
    }),
  );
});
router.put("/:importId/upload", upload);
router.post("/:importId/archive", upload);
router.get(
  "/:importId/tree",
  route(async (req, res) =>
    res.json(await codebaseImportTree(req.params.importId, req.query)),
  ),
);
router.get(
  "/:importId/preview",
  route(async (req, res) =>
    res.json(await codebaseImportPreview(req.params.importId, req.query.path)),
  ),
);
router.get(
  "/:importId/events",
  route(async (req, res) => {
    let snapshot = await getCodebaseImport(req.params.importId, {
      touch: false,
    });
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    let closed = false;
    let sequence = -1;
    const deadline = Date.now() + 5 * 60 * 1000;
    res.on("close", () => {
      closed = true;
    });
    while (!closed && Date.now() < deadline) {
      if (snapshot.sequence !== sequence) {
        sequence = snapshot.sequence;
        res.write(
          `id: ${sequence}\nevent: status\ndata: ${JSON.stringify({ jobId: snapshot.id, sequence, phase: snapshot.phase, state: snapshot.state, progress: snapshot.progress, error: snapshot.error, sessionId: snapshot.state === "completed" ? snapshot.sessionId : undefined })}\n\n`,
        );
      }
      if (
        [
          "awaiting_selection",
          "completed",
          "failed",
          "cancelled",
          "expired",
          "interrupted",
        ].includes(snapshot.state)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!closed)
        snapshot = await getCodebaseImport(req.params.importId, {
          touch: false,
        });
    }
    res.end();
  }),
);
const selection = route(async (req, res) =>
  res.json(await updateCodebaseSelection(req.params.importId, req.body)),
);
router.patch("/:importId/selection", selection);
router.put("/:importId/selection", selection);
router.post(
  "/:importId/commit",
  route(async (req, res) =>
    res
      .status(202)
      .json(await commitCodebaseImport(req.params.importId, req.body)),
  ),
);
router.post(
  "/:importId/cancel",
  route(async (req, res) =>
    res.json(await cancelCodebaseImport(req.params.importId)),
  ),
);
router.delete(
  "/:importId",
  route(async (req, res) =>
    res.json(await deleteCodebaseImport(req.params.importId)),
  ),
);
export default router;

export const codebaseSessionTreeRouter = express.Router();
codebaseSessionTreeRouter.get(
  "/:sessionId/tree",
  route(async (req, res) =>
    res.json(await workspaceTreePage(req.params.sessionId, req.query)),
  ),
);
codebaseSessionTreeRouter.get(
  "/:sessionId/metadata",
  route(async (req, res) =>
    res.json(await workspaceMetadata(req.params.sessionId, req.query.path)),
  ),
);
