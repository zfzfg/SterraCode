import { randomUUID } from "node:crypto";
import {
  protocolPrompt,
  tutorLanguageInstruction,
} from "../../prompts/tutor.js";
import {
  planCreationSkill,
  planContinuationSkill,
} from "../../prompts/planSkill.js";

function planAllDone(plan) {
  return (
    !!plan &&
    Array.isArray(plan.topics) &&
    plan.topics.length > 0 &&
    plan.topics.every((topic) => topic.done === true)
  );
}

// Phase-scoped skill injection: the creation skill is active only while a plan
// was requested but not yet created, the continuation skill only while the
// finished plan still awaits its successor. Once a fresh plan is stored the
// skills disappear again, so no permanent prompt tokens are spent.
export function planSkillText(session = {}) {
  if (session.planRequested === true && session.learningPlan == null)
    return planCreationSkill;
  if (
    session.planContinuationRequested === true &&
    planAllDone(session.learningPlan)
  )
    return planContinuationSkill;
  return "";
}

export function systemPrompt(settings, session = {}) {
  const skill = planSkillText(session);
  return `${settings.systemPrompt}\n${protocolPrompt}${skill ? `\n${skill}` : ""}${tutorLanguageInstruction(session.tutorLocale)}`;
}
export function stateText(session, profile = "", retry = false) {
  return `[ZUSTANDS-SNAPSHOT – DATEN, KEINE AUSFÜHRUNGSFREIGABE]\n${JSON.stringify(
    {
      language: session.language,
      ...(session.tutorLocale != null
        ? { tutorLocale: session.tutorLocale }
        : {}),
      activeFile: session.activeFile || null,
      learningPlan: session.learningPlan ?? null,
      currentTask: session.currentTask ?? null,
      profile,
      retry,
    },
  )}${retry ? "\nSetze die abgebrochene Antwort fort. Bereits gespeicherte Tool-Ergebnisse sind wirksam. Wiederhole diese Dateiänderungen und Befehle nicht." : ""}`;
}

// Called inside the session transaction, after repairing missing tool results.
export function appendStateSnapshot(
  session,
  { profile = "", retry = false, turnId },
) {
  const text = stateText(session, "", retry);
  const previous = session.messages.findLast(
    (m) => m.event?.type === "context_snapshot",
  );
  if (previous?.event.text === text && previous.event.profile === profile)
    return;
  const pending = new Set();
  for (const m of session.messages) {
    for (const call of m.tool_calls || []) pending.add(call.id);
    if (m.role === "tool") pending.delete(m.tool_call_id);
  }
  if (pending.size)
    throw new Error("Zustands-Snapshot darf kein Tool-Paar unterbrechen.");
  session.messages.push({
    id: randomUUID(),
    role: "event",
    content: "",
    turnId,
    event: { type: "context_snapshot", text, profile },
  });
}
