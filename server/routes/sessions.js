import express from "express";
import { route } from "./helpers.js";
import {
  createSession,
  listSessions,
  loadSession,
  mutateSession,
  removeSession,
  setLearningPlan,
  message,
} from "../services/sessions.js";
import { isActive } from "../services/teacher.js";
import { stopSessionProcesses } from "../services/processes.js";
import { AppError, LANGUAGES } from "../services/storage.js";
import { normalizePath } from "../services/workspace.js";
const router = express.Router();
router.get(
  "/",
  route(async (req, res) => res.json(await listSessions())),
);
router.post(
  "/",
  route(async (req, res) =>
    res.status(201).json(await createSession(req.body)),
  ),
);
router.get(
  "/:id",
  route(async (req, res) => res.json(await loadSession(req.params.id))),
);
router.patch(
  "/:id",
  route(async (req, res) =>
    res.json(
      await mutateSession(
        req.params.id,
        (s) => {
          const b = req.body;
          for (const key of Object.keys(b))
            if (
              ![
                "title",
                "language",
                "activeFile",
                "openFiles",
                "learningPlan",
                "expectedRevision",
              ].includes(key)
            )
              throw new AppError(`Nicht unterstütztes Sessionfeld: ${key}`);
          if (b.title !== undefined) {
            if (
              typeof b.title !== "string" ||
              !b.title.trim() ||
              b.title.length > 200
            )
              throw new AppError("Ungültiger Sessionname.");
            s.title = b.title.trim();
          }
          if (b.language !== undefined) {
            if (!LANGUAGES.includes(b.language))
              throw new AppError("Ungültige Sprache.");
            s.language = b.language;
          }
          if (b.activeFile !== undefined)
            s.activeFile =
              b.activeFile === null ? null : normalizePath(b.activeFile);
          if (b.openFiles !== undefined) {
            if (!Array.isArray(b.openFiles) || b.openFiles.length > 50)
              throw new AppError("Ungültige Dateireiter.");
            s.openFiles = [...new Set(b.openFiles.map(normalizePath))];
          }
          if (b.learningPlan !== undefined) {
            setLearningPlan(s, b.learningPlan);
            s.messages.push(
              message("event", "", {
                event: {
                  type: "update_learning_plan",
                  ...s.learningPlan,
                  actor: "user",
                },
              }),
            );
          }
        },
        req.body.expectedRevision,
      ),
    ),
  ),
);
router.delete(
  "/:id",
  route(async (req, res) => {
    if (isActive(req.params.id))
      throw new AppError("Bitte die laufende Antwort zuerst stoppen.", 409);
    await stopSessionProcesses(req.params.id);
    await removeSession(req.params.id);
    res.json({ ok: true });
  }),
);
export default router;
