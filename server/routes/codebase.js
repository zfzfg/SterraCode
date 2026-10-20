import express from "express";
import { route } from "./helpers.js";
import {
  currentAnalysis,
  getAnalysis,
  startAnalysis,
  cancelAnalysis,
  updateCodebaseTour,
  resolveCodeReference,
  searchCodebase,
  codebaseFileInfo,
  clearCodebaseAnalysis,
} from "../services/codebaseAnalyzer.js";
const router = express.Router();
router.get(
  "/:id/file",
  route(async (req, res) =>
    res.json(await codebaseFileInfo(req.params.id, req.query.path)),
  ),
);
router.get(
  "/:id/search",
  route(async (req, res) =>
    res.json(
      await searchCodebase(req.params.id, {
        ...req.query,
        content: req.query.content === "true",
      }),
    ),
  ),
);
router.get(
  "/:id/references/resolve",
  route(async (req, res) =>
    res.json(await resolveCodeReference(req.params.id, req.query)),
  ),
);
router.get(
  "/:id/analyses/current",
  route(async (req, res) => res.json(await currentAnalysis(req.params.id))),
);
router.get(
  "/:id/analyses/:analysisId",
  route(async (req, res) =>
    res.json(await getAnalysis(req.params.id, req.params.analysisId)),
  ),
);
router.post(
  "/:id/analyses",
  route(async (req, res) =>
    res.status(202).json(await startAnalysis(req.params.id, req.body)),
  ),
);
router.post(
  "/:id/analyses/:analysisId/cancel",
  route(async (req, res) =>
    res.json(await cancelAnalysis(req.params.id, req.params.analysisId)),
  ),
);
router.delete(
  "/:id/analyses",
  route(async (req, res) =>
    res.json(await clearCodebaseAnalysis(req.params.id, req.body)),
  ),
);
router.patch(
  "/:id/tour",
  route(async (req, res) =>
    res.json(await updateCodebaseTour(req.params.id, req.body)),
  ),
);
router.get(
  "/:id/analyses/:analysisId/events",
  route(async (req, res) => {
    let snapshot = await getAnalysis(req.params.id, req.params.analysisId);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    let closed = false;
    res.on("close", () => {
      closed = true;
    });
    let sequence = -1;
    while (!closed) {
      if (snapshot.sequence !== sequence) {
        sequence = snapshot.sequence;
        res.write(
          `id: ${sequence}\nevent: status\ndata: ${JSON.stringify({ jobId: snapshot.analysisId, sequence, phase: snapshot.phase, status: snapshot.status, sourceCount: snapshot.sourceCount, error: snapshot.error })}\n\n`,
        );
      }
      if (!["queued", "running"].includes(snapshot.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!closed)
        snapshot = await getAnalysis(req.params.id, req.params.analysisId);
    }
    res.end();
  }),
);
export default router;
