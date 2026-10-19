import {
  listProposals,
  getProposal,
  decideProposal,
} from "../services/proposals.js";
import {
  startTaskTests,
  getTaskTestResults,
  cancelTaskTests,
  completeTask,
  updateTask,
  listTaskTestRuns,
} from "../services/testRunner.js";
import express from "express";
import {
  revealHint,
  listJournal,
  saveJournal,
} from "../services/learningSupport.js";
import { exportProject, projectFiles } from "../services/projects.js";
import {
  startPreview,
  getPreview,
  previewDocument,
  previewHeaders,
} from "../services/previews.js";
import { route } from "./helpers.js";
import {
  startTrace,
  getTrace,
  traceEvents,
  cancelTrace,
  listTraces,
} from "../services/traces.js";
import {
  readFile,
  writeFile,
  listWorkspace,
  createFolder,
  renamePath,
  deletePath,
  undoChange,
  listChanges,
  getChange,
} from "../services/workspace.js";
const router = express.Router();
router.get(
  "/:sessionId/project-files",
  route(async (req, res) => res.json(await projectFiles(req.params.sessionId))),
);
router.post(
  "/:sessionId/project-export",
  route(async (req, res) =>
    res.json(await exportProject(req.params.sessionId, req.body)),
  ),
);
router.get(
  "/:sessionId/journal",
  route(async (req, res) => res.json(await listJournal(req.params.sessionId))),
);
router.put(
  "/:sessionId/tasks/:taskId/journal",
  route(async (req, res) =>
    res.json(
      await saveJournal(req.params.sessionId, req.params.taskId, req.body),
    ),
  ),
);
router.post(
  "/:sessionId/tasks/:taskId/hints",
  route(async (req, res) =>
    res.json(
      await revealHint(req.params.sessionId, req.params.taskId, req.body),
    ),
  ),
);
router.get(
  "/:sessionId/proposals",
  route(async (req, res) =>
    res.json(await listProposals(req.params.sessionId)),
  ),
);
router.get(
  "/:sessionId/proposals/:proposalId",
  route(async (req, res) =>
    res.json(await getProposal(req.params.sessionId, req.params.proposalId)),
  ),
);
router.post(
  "/:sessionId/proposals/:proposalId/apply",
  route(async (req, res) =>
    res.json(
      await decideProposal(
        req.params.sessionId,
        req.params.proposalId,
        "apply",
        req.body,
      ),
    ),
  ),
);
router.post(
  "/:sessionId/proposals/:proposalId/reject",
  route(async (req, res) =>
    res.json(
      await decideProposal(
        req.params.sessionId,
        req.params.proposalId,
        "reject",
      ),
    ),
  ),
);
router.get(
  "/:sessionId/changes/:changeId",
  route(async (req, res) =>
    res.json(await getChange(req.params.sessionId, req.params.changeId)),
  ),
);
router.post(
  "/:sessionId/preview-runs",
  route(async (req, res) =>
    res.status(201).json(await startPreview(req.params.sessionId, req.body)),
  ),
);
router.get(
  "/:sessionId/preview-runs/:previewRunId",
  route(async (req, res) =>
    res.json(await getPreview(req.params.sessionId, req.params.previewRunId)),
  ),
);
router.get(
  "/:sessionId/preview-runs/:previewRunId/document",
  route(async (req, res) => {
    const html = await previewDocument(
      req.params.sessionId,
      req.params.previewRunId,
      res.locals.appOrigin,
    );
    res.set(previewHeaders(res.locals.appOrigin)).type("html").send(html);
  }),
);
router.post(
  "/:sessionId/tasks/:taskId/test-runs",
  route(async (req, res) =>
    res
      .status(202)
      .json(
        await startTaskTests(req.params.sessionId, req.params.taskId, req.body),
      ),
  ),
);
router.get(
  "/:sessionId/tasks/:taskId/test-runs",
  route(async (req, res) =>
    res.json(await listTaskTestRuns(req.params.sessionId, req.params.taskId)),
  ),
);
router.patch(
  "/:sessionId/tasks/:taskId",
  route(async (req, res) =>
    res.json(
      await updateTask(req.params.sessionId, req.params.taskId, req.body),
    ),
  ),
);
router.post(
  "/:sessionId/tasks/:taskId/complete",
  route(async (req, res) =>
    res.json(
      await completeTask(req.params.sessionId, {
        ...req.body,
        taskId: req.params.taskId,
      }),
    ),
  ),
);
router.get(
  "/:sessionId/test-runs/:testRunId",
  route(async (req, res) =>
    res.json(
      await getTaskTestResults(req.params.sessionId, req.params.testRunId),
    ),
  ),
);
router.post(
  "/:sessionId/test-runs/:testRunId/cancel",
  route(async (req, res) =>
    res.json(await cancelTaskTests(req.params.sessionId, req.params.testRunId)),
  ),
);
router.post(
  "/:sessionId/traces",
  route(async (req, res) =>
    res.status(202).json(await startTrace(req.params.sessionId, req.body)),
  ),
);
router.get(
  "/:sessionId/traces",
  route(async (req, res) => res.json(await listTraces(req.params.sessionId))),
);
router.get(
  "/:sessionId/traces/:traceRunId",
  route(async (req, res) =>
    res.json(await getTrace(req.params.sessionId, req.params.traceRunId)),
  ),
);
router.get(
  "/:sessionId/traces/:traceRunId/events",
  route(async (req, res) =>
    res.json(
      await traceEvents(
        req.params.sessionId,
        req.params.traceRunId,
        Number(req.query.fromStep ?? 1),
        Number(req.query.limit ?? 50),
        req.query.detail ?? "full",
      ),
    ),
  ),
);
router.post(
  "/:sessionId/traces/:traceRunId/cancel",
  route(async (req, res) =>
    res.json(await cancelTrace(req.params.sessionId, req.params.traceRunId)),
  ),
);
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
