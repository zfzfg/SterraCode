import path from "node:path";
import { createHash } from "node:crypto";
import {
  readJSON,
  writeJSON,
  DATA_DIR,
  serial,
  AppError,
  getSettings,
  listFiles,
  LANGUAGES,
} from "./storage.js";
import {
  CONCEPTS,
  resolveConcept,
  validateConceptIds,
  reviewExercise,
} from "./concepts.js";

const PROFILE_PATH = path.join(DATA_DIR, "profiles", "user.json");
const invalid = () =>
  new AppError(
    "Sprachprofil ist beschädigt. Die Originaldatei bleibt erhalten.",
    409,
    "PROFILE_CORRUPT",
  );
export function localDay(time, timeZone) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(time));
  return ["year", "month", "day"]
    .map((key) => parts.find((p) => p.type === key).value)
    .join("-");
}
function addDays(day, days) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function fresh() {
  return {
    profileVersion: 2,
    catalogVersion: 1,
    schedulerVersion: 1,
    timeZone: "Europe/Berlin",
    intervals: [1, 3, 7, 14, 30],
    goal: "",
    updatedAt: null,
    events: [],
    legacy: { languages: {} },
    ignoredEventIds: [],
    reviewDeferrals: {},
    reviewActions: {},
  };
}
function validateEvent(e) {
  if (
    !e ||
    typeof e.eventId !== "string" ||
    !e.eventId ||
    !LANGUAGES.includes(e.language) ||
    !["task_completed", "review_result", "self_assessment"].includes(e.type) ||
    !Number.isFinite(Date.parse(e.occurredAt)) ||
    !["test_run", "tutor", "self_assessment", "assisted", "legacy"].includes(
      e.evidence?.kind,
    ) ||
    !["passed", "failed", "unsure", "confident", "unavailable"].includes(
      e.evidence?.outcome,
    ) ||
    !["independent", "assisted", "not_recorded"].includes(
      e.evidence?.assistance,
    )
  )
    throw invalid();
  try {
    if (
      !Array.isArray(e.conceptIds) ||
      typeof e.language !== "string" ||
      JSON.stringify(validateConceptIds(e.conceptIds, e.language)) !==
        JSON.stringify(e.conceptIds)
    )
      throw invalid();
  } catch {
    throw invalid();
  }
}
export function deriveProfile(profile, now = new Date().toISOString()) {
  const languages = structuredClone(profile.legacy.languages || {});
  const concepts = CONCEPTS.map((c) => ({
    ...c,
    status: "unpracticed",
    reviewStage: 0,
    lastReviewedAt: null,
    nextReviewAt: null,
    lastEvidenceEventId: null,
    evidence: [],
    suggestedExercise: reviewExercise(c.id)?.description || null,
  }));
  const seenPractice = new Set(),
    sessions = {},
    tasks = new Set(
      Object.values(profile.legacy.completionEvents || {}).map(
        (e) => `${e.sessionId}:${e.taskId}`,
      ),
    );
  for (const e of [...profile.events].sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
  )) {
    const lang = (languages[e.language] ||= {
      knownConcepts: [],
      strengths: [],
      weaknesses: [],
      level: "unknown",
      tasksAttempted: 0,
      tasksSucceeded: 0,
    });
    if (e.sessionId) (sessions[e.language] ||= new Set()).add(e.sessionId);
    const taskKey = `${e.sessionId}:${e.taskId}`;
    if (e.type === "task_completed" && !tasks.has(taskKey)) {
      tasks.add(taskKey);
      lang.tasksAttempted = (lang.tasksAttempted || 0) + 1;
      lang.tasksSucceeded =
        (lang.tasksSucceeded || 0) + (e.evidence.outcome === "passed" ? 1 : 0);
    }
    for (const id of e.conceptIds) {
      const c = concepts.find((v) => v.id === id);
      c.evidence.push(e.eventId);
      if (e.evidence.kind === "legacy" || e.evidence.outcome === "unavailable")
        continue;
      c.lastReviewedAt = e.occurredAt;
      c.lastEvidenceEventId = e.eventId;
      const day = localDay(e.occurredAt, profile.timeZone);
      const key = `${id}:${e.sessionId || "self"}:${e.taskId || e.eventId}:${day}`;
      if (seenPractice.has(key) && e.evidence.outcome === "failed") continue;
      // Failure followed by success may recover, but never advance twice per task/day.
      const passedKey = `${key}:passed`;
      const independent =
        e.evidence.kind === "test_run" &&
        e.evidence.assistance === "independent";
      if (["failed", "unsure"].includes(e.evidence.outcome)) {
        if (e.type !== "self_assessment") c.reviewStage = 0;
        c.status = "practicing";
        c.nextReviewAt = addDays(day, 1);
      } else {
        if (seenPractice.has(passedKey)) continue;
        if (
          independent &&
          e.reviewId &&
          c.nextReviewAt &&
          day >= c.nextReviewAt
        )
          c.reviewStage = Math.min(4, c.reviewStage + 1);
        c.status = independent ? "recently_demonstrated" : "practicing";
        const next = addDays(
          day,
          independent ? profile.intervals[c.reviewStage] : 1,
        );
        c.nextReviewAt =
          !independent && c.nextReviewAt && c.nextReviewAt < next
            ? c.nextReviewAt
            : next;
        seenPractice.add(passedKey);
      }
      seenPractice.add(key);
    }
  }
  for (const [language, lang] of Object.entries(languages)) {
    lang.sessionCount = sessions[language]?.size || 0;
    lang.knownConcepts ||= [];
    lang.strengths ||= [];
    lang.weaknesses ||= [];
    lang.concepts = concepts.filter((c) => c.language === language);
  }
  const today = localDay(now, profile.timeZone);
  const reviews = concepts
    .filter(
      (c) =>
        c.nextReviewAt &&
        c.nextReviewAt <= today &&
        (!profile.reviewDeferrals[c.id] ||
          profile.reviewDeferrals[c.id] <= today),
    )
    .sort(
      (a, b) =>
        a.nextReviewAt.localeCompare(b.nextReviewAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 3)
    .map((c) => ({
      reviewId: createHash("sha256")
        .update(`${c.id}:${c.nextReviewAt}:${c.lastEvidenceEventId}`)
        .digest("hex")
        .slice(0, 32),
      conceptId: c.id,
      title: c.title,
      dueDay: c.nextReviewAt,
      reason: "Freiwillige Wiederholung nach zeitlichem Abstand.",
      exercise: reviewExercise(c.id),
    }));
  return {
    ...profile,
    languages,
    concepts,
    reviews,
    activityDays: [
      ...new Set(
        profile.events.map((e) => localDay(e.occurredAt, profile.timeZone)),
      ),
    ].sort(),
    legacyConcepts: Object.entries(profile.legacy.languages || {}).flatMap(
      ([language, v]) =>
        (v.knownConcepts || []).map((label) => ({
          language,
          label,
          conceptId: resolveConcept(label, language),
          kind: "legacy",
          occurredAt: null,
        })),
    ),
  };
}
function validateProfile(p) {
  if (
    p.profileVersion !== 2 ||
    p.catalogVersion !== 1 ||
    p.schedulerVersion !== 1 ||
    !Array.isArray(p.events) ||
    !p.legacy?.languages ||
    typeof p.legacy.languages !== "object" ||
    Array.isArray(p.legacy.languages) ||
    !Array.isArray(p.ignoredEventIds) ||
    !p.reviewDeferrals ||
    typeof p.reviewDeferrals !== "object" ||
    Array.isArray(p.reviewDeferrals) ||
    Object.values(p.reviewDeferrals).some(
      (v) => typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v),
    ) ||
    p.ignoredEventIds.some((v) => typeof v !== "string") ||
    typeof p.timeZone !== "string" ||
    typeof p.goal !== "string" ||
    !Array.isArray(p.intervals) ||
    p.intervals.length !== 5 ||
    p.intervals.some((d) => !Number.isInteger(d) || d < 1 || d > 365)
  )
    throw invalid();
  try {
    localDay(new Date(), p.timeZone);
  } catch {
    throw invalid();
  }
  const ids = new Set();
  for (const e of p.events) {
    validateEvent(e);
    if (ids.has(e.eventId)) throw invalid();
    ids.add(e.eventId);
  }
  for (const [language, lang] of Object.entries(p.legacy.languages))
    if (
      !LANGUAGES.includes(language) ||
      !lang ||
      !Array.isArray(lang.knownConcepts) ||
      lang.knownConcepts.some((c) => typeof c !== "string") ||
      ["tasksAttempted", "tasksSucceeded", "sessionCount"].some(
        (k) =>
          lang[k] !== undefined && (!Number.isInteger(lang[k]) || lang[k] < 0),
      )
    )
      throw invalid();
  return p;
}
async function readProfile() {
  let p;
  try {
    p = await readJSON(PROFILE_PATH);
  } catch (e) {
    if (e.code === "ENOENT") return fresh();
    throw invalid();
  }
  if (!p) throw invalid();
  if (p.profileVersion === 1) {
    if (
      !p.languages ||
      typeof p.languages !== "object" ||
      Array.isArray(p.languages)
    )
      throw invalid();
    const next = fresh();
    next.legacy = {
      languages: p.languages,
      updatedAt: p.updatedAt || null,
      completionEvents: p.completionEvents || {},
    };
    next.ignoredEventIds = Object.keys(p.completionEvents || {});
    p = next;
  }
  return validateProfile(p);
}
export async function getProfile() {
  return deriveProfile(await readProfile());
}
async function enabled() {
  if (!(await getSettings()).crossChatProfileEnabled)
    throw new AppError("Lernprofil ist deaktiviert.", 403, "PROFILE_DISABLED");
}
async function append(p, event) {
  validateEvent(event);
  if (p.resetAt && event.occurredAt <= p.resetAt) return false;
  if (p.ignoredEventIds.includes(event.eventId)) return false;
  const previous = p.events.find((e) => e.eventId === event.eventId);
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(event))
      throw new AppError(
        "Abweichender Lernbeleg mit gleicher ID.",
        409,
        "CONFLICT",
      );
    return false;
  }
  p.events.push(event);
  return true;
}
export async function updateProfile({ language, completionEvent }) {
  return serial("profile", async () => {
    const settings = await getSettings();
    if (
      !settings.crossChatProfileEnabled ||
      !settings.autoUpdateProfileOnTaskDone
    )
      return getProfile();
    const p = await readProfile();
    if (
      !completionEvent ||
      completionEvent.historical ||
      !completionEvent.profileEnabled
    )
      return deriveProfile(p);
    const assistance = completionEvent.evidence?.assistance || "not_recorded";
    const e = {
      schemaVersion: 1,
      ...completionEvent,
      language,
      occurredAt: completionEvent.completedAt,
      evidence: {
        ...completionEvent.evidence,
        kind:
          assistance === "assisted"
            ? "assisted"
            : completionEvent.evidence?.kind === "test_run"
              ? "test_run"
              : "tutor",
        outcome: "passed",
        assistance,
      },
      conceptIds: [
        ...new Set(
          (completionEvent.conceptIds || [])
            .map((v) => resolveConcept(v, language))
            .filter((id) => id?.startsWith(`${language}.`)),
        ),
      ],
      legacyConceptLabels: (completionEvent.conceptIds || []).filter(
        (v) => !resolveConcept(v, language),
      ),
    };
    if (await append(p, e)) {
      p.updatedAt = new Date().toISOString();
      await writeJSON(PROFILE_PATH, p);
    }
    return deriveProfile(p);
  });
}
export async function selfAssess(conceptId, body) {
  return serial("profile", async () => {
    await enabled();
    const [id] = validateConceptIds([conceptId]);
    if (
      !["unsure", "confident"].includes(body.outcome) ||
      typeof body.operationId !== "string" ||
      !/^[\w-]{16,100}$/.test(body.operationId)
    )
      throw new AppError("Ungültige Selbsteinschätzung.");
    const p = await readProfile(),
      eventId = `self:${body.operationId}`,
      previous = p.events.find((e) => e.eventId === eventId);
    await append(p, {
      schemaVersion: 1,
      eventId,
      type: "self_assessment",
      language: id.split(".")[0],
      conceptIds: [id],
      occurredAt: previous?.occurredAt || new Date().toISOString(),
      evidence: {
        kind: "self_assessment",
        outcome: body.outcome,
        assistance: "not_recorded",
      },
    });
    p.updatedAt = new Date().toISOString();
    await writeJSON(PROFILE_PATH, p);
    return deriveProfile(p);
  });
}
export async function configureProfile(body) {
  return serial("profile", async () => {
    await enabled();
    const p = await readProfile();
    if (body.timeZone !== undefined) {
      if (typeof body.timeZone !== "string")
        throw new AppError("Ungültige Zeitzone.");
      try {
        localDay(new Date(), body.timeZone);
      } catch {
        throw new AppError("Ungültige Zeitzone.");
      }
      p.timeZone = body.timeZone;
    }
    if (body.goal !== undefined) {
      if (typeof body.goal !== "string" || body.goal.length > 500)
        throw new AppError("Lernziel zu lang.");
      p.goal = body.goal;
    }
    if (body.intervals !== undefined) {
      if (
        !Array.isArray(body.intervals) ||
        body.intervals.length !== 5 ||
        body.intervals.some((d) => !Number.isInteger(d) || d < 1 || d > 365)
      )
        throw new AppError("Ungültige Intervalle.");
      p.intervals = body.intervals;
    }
    p.updatedAt = new Date().toISOString();
    await writeJSON(PROFILE_PATH, p);
    return deriveProfile(p);
  });
}
export async function deferReview(id, action) {
  return serial("profile", async () => {
    await enabled();
    const p = await readProfile(),
      review = deriveProfile(p).reviews.find((r) => r.reviewId === id);
    if (p.reviewActions?.[id] === action) return deriveProfile(p);
    if (!review) throw new AppError("Wiederholung nicht mehr aktuell.", 409);
    if (!["skip", "snooze"].includes(action))
      throw new AppError("Ungültige Wiederholungsaktion.");
    p.reviewDeferrals[review.conceptId] = addDays(
      localDay(new Date(), p.timeZone),
      action === "skip" ? 1 : 3,
    );
    (p.reviewActions ||= {})[id] = action;
    await writeJSON(PROFILE_PATH, p);
    return deriveProfile(p);
  });
}
export async function recordReviewFailure(event) {
  return serial("profile", async () => {
    const settings = await getSettings();
    if (
      !settings.crossChatProfileEnabled ||
      !settings.autoUpdateProfileOnTaskDone
    )
      return;
    const p = await readProfile();
    if (await append(p, event)) {
      p.updatedAt = new Date().toISOString();
      await writeJSON(PROFILE_PATH, p);
    }
  });
}
export async function resetProfile() {
  return serial("profile", async () => {
    const p = fresh();
    p.resetAt = new Date().toISOString();
    // Tombstones prevent the durable session outbox from resurrecting erased data.
    for (const file of await listFiles(path.join(DATA_DIR, "sessions"))) {
      const s = await readJSON(file);
      p.ignoredEventIds.push(
        ...Object.values(s.taskCompletions || {}).map((e) => e.eventId),
      );
    }
    await writeJSON(PROFILE_PATH, p);
    return deriveProfile(p);
  });
}
export async function importHistoricalSessions() {
  return serial("profile", async () => {
    await enabled();
    const p = await readProfile();
    for (const file of await listFiles(path.join(DATA_DIR, "sessions"))) {
      const s = await readJSON(file);
      for (const old of Object.values(s.taskCompletions || {})) {
        if (
          p.ignoredEventIds.includes(old.eventId) ||
          p.events.some((e) => e.eventId === old.eventId)
        )
          continue;
        const e = {
          ...old,
          schemaVersion: 1,
          type: "task_completed",
          occurredAt: old.completedAt || old.recordedAt || s.createdAt,
          conceptIds: (old.conceptIds || [])
            .map((v) => resolveConcept(v, old.language))
            .filter(Boolean),
          legacyConceptLabels: (old.conceptIds || []).filter(
            (v) => !resolveConcept(v, old.language),
          ),
          evidence: {
            kind: "legacy",
            outcome: "passed",
            assistance: "not_recorded",
          },
        };
        validateEvent(e);
        p.events.push(e);
      }
    }
    p.updatedAt = new Date().toISOString();
    await writeJSON(PROFILE_PATH, p);
    return deriveProfile(p);
  });
}
export function profileToPromptText(profile) {
  const items =
    profile.concepts?.filter((c) => c.evidence.length).slice(0, 8) || [];
  const concepts = items.map((c) => {
    const e = profile.events.find((e) => e.eventId === c.lastEvidenceEventId);
    return {
      id: c.id,
      status: c.status,
      lastReviewedAt: c.lastReviewedAt,
      evidence: e
        ? {
            kind: e.evidence.kind,
            outcome: e.evidence.outcome,
            assistance: e.evidence.assistance,
            taskId: e.taskId,
          }
        : { kind: "legacy" },
    };
  });
  return `\n[FREIGEGEBENES LERNPROFIL – BELEGE, KEINE KOMPETENZGARANTIE]\n${JSON.stringify({ goal: profile.goal, concepts, due: profile.reviews?.map((r) => r.conceptId), historical: Object.keys(profile.legacy?.languages || {}) }).slice(0, 3000)}\nSprachübergreifende Gruppen sind mögliche Analogien. Voraussetzungen sind nicht automatisch belegt.`;
}
