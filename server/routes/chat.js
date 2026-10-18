import express from "express";
import { route } from "./helpers.js";
import {
  runTeacher,
  abortTurn,
  answerQuestion,
  editUserMessage,
  deleteLastUserMessage,
} from "../services/teacher.js";
import {
  getSettings,
  updateSettings,
  DEFAULT_SYSTEM_PROMPT,
  AppError,
} from "../services/storage.js";
import { mutateSession } from "../services/sessions.js";
const router = express.Router();
router.get(
  "/settings",
  route(async (req, res) => res.json(await getSettings())),
);
router.get("/default-prompt", (req, res) =>
  res.json({ prompt: DEFAULT_SYSTEM_PROMPT }),
);
router.patch(
  "/settings",
  route(async (req, res) => res.json(await updateSettings(req.body))),
);
router.post("/abort", (req, res) => res.json(abortTurn(req.body.sessionId)));
router.post(
  "/answer",
  route(async (req, res) =>
    res.json(
      await answerQuestion(
        req.body.sessionId,
        req.body.questionId,
        req.body.answer,
      ),
    ),
  ),
);
router.post(
  "/edit",
  route(async (req, res) => res.json(await editUserMessage(req.body))),
);
router.delete(
  "/last",
  route(async (req, res) => res.json(await deleteLastUserMessage(req.body))),
);
router.post(
  "/feedback",
  route(async (req, res) => {
    const { sessionId, messageId, value } = req.body;
    if (![-1, 1].includes(value)) throw new AppError("Ungültiges Feedback.");
    await mutateSession(sessionId, (s) => {
      const m = s.messages.find(
        (m) => m.id === messageId && m.role === "assistant",
      );
      if (!m) throw new AppError("Nachricht nicht gefunden.", 404);
      m.feedback = value;
    });
    res.json({ ok: true });
  }),
);
router.post(
  "/",
  route(async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    res.json(await runTeacher({ ...req.body, signal: controller.signal }));
  }),
);
router.post(
  "/stream",
  route(async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (event, data) => {
      if (!res.destroyed && !res.writableEnded)
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(": heartbeat\n\n");
    }, 15000);
    try {
      const result = await runTeacher({
        ...req.body,
        stream: true,
        signal: controller.signal,
        onEvent: send,
      });
      send("done", result);
    } catch (error) {
      send("error", { message: error.message, code: error.code });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }),
);
export default router;
