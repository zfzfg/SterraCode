import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AppError,
  DATA_DIR,
  getSettings,
  listFiles,
  readJSON,
  serial,
} from "./storage.js";
import { getProfile, deferReview } from "./profileManager.js";
import { createSession, mutateSession } from "./sessions.js";
import {
  taskAssessment,
  getTaskTestResults,
  completeTask,
} from "./testRunner.js";
import { reviewExercise } from "./concepts.js";
import { validateContentLocale } from "./contentLocale.js";

async function requireEnabled() {
  if (!(await getSettings()).crossChatProfileEnabled)
    throw new AppError("Lernprofil ist deaktiviert.", 403, "PROFILE_DISABLED", {
      messageKey: "learningContent:errors.profileDisabled",
      params: {},
    });
}
export async function startReview(reviewId, { tutorLocale = "de" } = {}) {
  tutorLocale = validateContentLocale(tutorLocale);
  await requireEnabled();
  return serial("review-start", async () => {
    const review = (await getProfile()).reviews.find(
      (r) => r.reviewId === reviewId,
    );
    if (!review)
      throw new AppError(
        "Wiederholung nicht mehr aktuell.",
        409,
        "INVALID_REQUEST",
        { messageKey: "learningContent:errors.reviewOutdated", params: {} },
      );
    const exercise = reviewExercise(review.conceptId, tutorLocale);
    if (!exercise)
      throw new AppError(
        "Für diese Sprache gibt es noch keine geprüfte Offlineaufgabe.",
        400,
        "INVALID_REQUEST",
        { messageKey: "learningContent:errors.reviewUnavailable", params: {} },
      );
    for (const f of await listFiles(path.join(DATA_DIR, "sessions"))) {
      const s = await readJSON(f);
      if (s.currentTask?.reviewId === reviewId && !s.currentTask.done) return s;
    }
    const s = await createSession({
      title: exercise.title,
      language: "python",
      tutorLocale,
    });
    return mutateSession(s.id, (session) => {
      const task = {
        ...exercise,
        ...taskAssessment(exercise),
        id: randomUUID(),
        done: false,
        reviewId,
        reviewStartedAt: new Date().toISOString(),
        profileEnabled: true,
      };
      session.currentTask = task;
    });
  });
}
export async function reviewResult(id, body) {
  await requireEnabled();
  if (["skip", "snooze"].includes(body.action))
    return deferReview(id, body.action);
  if (body.action !== "submit")
    throw new AppError(
      "Ungültige Wiederholungsaktion.",
      400,
      "INVALID_REQUEST",
      { messageKey: "learningContent:errors.reviewAction", params: {} },
    );
  const { loadSession } = await import("./sessions.js");
  const s = await loadSession(body.sessionId),
    t = s.currentTask;
  if (t?.reviewId !== id)
    throw new AppError(
      "Wiederholungsaufgabe stimmt nicht überein.",
      409,
      "INVALID_REQUEST",
      { messageKey: "learningContent:errors.reviewTask", params: {} },
    );
  const run = await getTaskTestResults(s.id, body.testRunId);
  if (run.taskId !== t.id || !run.current)
    throw new AppError("Teststand ist nicht aktuell.", 409, "INVALID_REQUEST", {
      messageKey: "learningContent:errors.reviewTests",
      params: {},
    });
  if (run.assessment === "passed")
    await completeTask(s.id, {
      taskId: t.id,
      taskVersion: t.taskVersion,
      testRunId: body.testRunId,
      assistance: body.assistance,
    });
  // Validated failures are recorded by the test service. Runtime failures never lower a stage.
  return getProfile();
}
