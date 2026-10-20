import express from "express";
import path from "node:path";
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
import {
  AppError,
  LANGUAGES,
  DATA_DIR,
  writeJSON,
  serial,
  readJSON,
} from "../services/storage.js";
import { normalizePath } from "../services/workspace.js";
import { LOCALES } from "../../shared/i18n/locale.js";
const router = express.Router();
router.get(
  "/",
  route(async (req, res) => res.json(await listSessions())),
);
router.post(
  "/",
  route(async (req, res) =>
    res.status(201).json(
      await createSession({
        ...req.body,
        ...(!Object.hasOwn(req.body, "title")
          ? { title: req.t("sessions:new.title") }
          : {}),
        ...(!Object.hasOwn(req.body, "tutorLocale")
          ? { tutorLocale: req.uiLocale }
          : {}),
      }),
    ),
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
                "tutorLocale",
                "activeFile",
                "openFiles",
                "learningPlan",
                "expectedRevision",
              ].includes(key)
            )
              throw new AppError(
                `Nicht unterstütztes Sessionfeld: ${key}`,
                400,
                "INVALID_REQUEST",
                { messageKey: "errors:session.field", params: { name: key } },
              );
          if (b.title !== undefined) {
            if (
              typeof b.title !== "string" ||
              !b.title.trim() ||
              b.title.length > 200
            )
              throw new AppError(
                "Ungültiger Sessionname.",
                400,
                "INVALID_REQUEST",
                { messageKey: "errors:session.name" },
              );
            s.title = b.title.trim();
          }
          if (b.language !== undefined) {
            if (!LANGUAGES.includes(b.language))
              throw new AppError("Ungültige Sprache.", 400, "INVALID_REQUEST", {
                messageKey: "errors:session.language",
              });
            s.language = b.language;
          }
          if (b.tutorLocale !== undefined) {
            if (!Object.hasOwn(LOCALES, b.tutorLocale))
              throw new AppError(
                "Ungültige Tutorsprache.",
                400,
                "INVALID_REQUEST",
                { messageKey: "sessions:errors.tutorLocale" },
              );
            s.tutorLocale = b.tutorLocale;
          }
          if (b.activeFile !== undefined)
            s.activeFile =
              b.activeFile === null ? null : normalizePath(b.activeFile);
          if (b.openFiles !== undefined) {
            if (!Array.isArray(b.openFiles) || b.openFiles.length > 50)
              throw new AppError(
                "Ungültige Dateireiter.",
                400,
                "INVALID_REQUEST",
                { messageKey: "errors:session.tabs" },
              );
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
    const id = req.params.id;
    await serial(`delete:${id}`, async () => {
      const marker = path.join(DATA_DIR, "deletions", `${id}.json`);
      let previous = {};
      await serial(`lifecycle:${id}`, async () => {
        if (isActive(id))
          throw new AppError(
            "Bitte die laufende Antwort zuerst stoppen.",
            409,
            "INVALID_REQUEST",
            { messageKey: "errors:session.stop" },
          );
        await loadSession(id);
        await serial(`session:${id}`, async () => {
          try {
            previous = await readJSON(marker);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          await writeJSON(marker, {
            ...previous,
            sessionId: id,
            status: "pending",
            requestedAt: new Date().toISOString(),
          });
        });
      });
      if (
        process.env.STERRACODE_MODE === "docker" ||
        process.env.STERRACODE_RUNNER_URL
      ) {
        try {
          const { blockSession } = await import("../services/runnerClient.js");
          await blockSession(id);
          await stopSessionProcesses(id);
        } catch (error) {
          await writeJSON(marker, {
            ...previous,
            sessionId: id,
            status: "pending",
            code: error.code || "RUNNER_UNAVAILABLE",
          });
          throw new AppError(
            "Löschen wartet auf den Runner. Die Session bleibt gesperrt; den Vorgang nach Wiederherstellung erneut ausführen.",
            503,
            "DELETION_PENDING",
            { messageKey: "errors:session.deletionRunner" },
          );
        }
      } else await stopSessionProcesses(id);
      await serial(`workspace:${id}`, () => removeSession(id));
    });
    res.json({ ok: true });
  }),
);
export default router;
