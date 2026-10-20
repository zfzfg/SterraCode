import express from "express";
import { route } from "./helpers.js";
import {
  runTeacher,
  abortTurn,
  answerQuestion,
  editUserMessage,
  deleteLastUserMessage,
} from "../services/teacher.js";
import { getSettings, updateSettings, AppError } from "../services/storage.js";
import { getDefaultSystemPrompt } from "../prompts/tutor.js";
import { mutateSession } from "../services/sessions.js";
import { errorPayload, t } from "../services/i18n.js";
import {
  localizeFields,
  localizeProcess,
  localizeTeacherResult,
} from "../services/messageOutput.js";
const router = express.Router();
router.get(
  "/settings",
  route(async (req, res) => res.json(await getSettings())),
);
router.get("/default-prompt", (req, res) =>
  res.json({ prompt: getDefaultSystemPrompt(req.uiLocale) }),
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
        req.body.optionId,
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
    if (![-1, 1].includes(value))
      throw new AppError("Ungültiges Feedback.", undefined, undefined, {
        messageKey: "serverFeature:chat.invalidFeedback",
        params: {},
      });
    await mutateSession(sessionId, (s) => {
      const m = s.messages.find(
        (m) => m.id === messageId && m.role === "assistant",
      );
      if (!m)
        throw new AppError("Nachricht nicht gefunden.", 404, undefined, {
          messageKey: "serverFeature:chat.messageMissing",
          params: {},
        });
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
    res.json(
      localizeTeacherResult(
        await runTeacher({ ...req.body, signal: controller.signal }),
        req.uiLocale,
      ),
    );
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
      if (event === "context-usage")
        data = localizeFields(data, req.uiLocale, ["error"]);
      if (event === "context-report" && data.contextUsage)
        data = {
          ...data,
          contextUsage: localizeFields(data.contextUsage, req.uiLocale, [
            "error",
          ]),
        };
      if (event === "process") data = localizeProcess(data, req.uiLocale);
      if (event === "done") data = localizeTeacherResult(data, req.uiLocale);
      if (data?.messageKey)
        data = {
          ...data,
          message: t(req.uiLocale, data.messageKey, data.params),
        };
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
      const payload =
        !error.status || error.status === 500
          ? {
              error: req.t("errors:http.internal"),
              code: error.code || "SERVER_ERROR",
              messageKey: "errors:http.internal",
              params: {},
            }
          : errorPayload(error, req.uiLocale);
      send("error", { ...payload, message: payload.error });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }),
);
export default router;
