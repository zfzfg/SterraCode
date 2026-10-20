import { randomUUID } from "node:crypto";
import {
  protocolPrompt,
  tutorLanguageInstruction,
} from "../../prompts/tutor.js";

export function systemPrompt(settings, session = {}) {
  return `${settings.systemPrompt}\n${protocolPrompt}${tutorLanguageInstruction(session.tutorLocale)}`;
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
