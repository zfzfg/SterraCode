import { node } from "./ui.js";
import { state } from "./state.js";

const sections = new Map();
export const captureTaskSections = () => [...sections];
export function restoreTaskSections(saved) {
  if (!Array.isArray(saved)) return;
  for (const entry of saved.slice(-100))
    if (
      Array.isArray(entry) &&
      typeof entry[0] === "string" &&
      typeof entry[1] === "boolean"
    )
      sections.set(entry[0], entry[1]);
}

export function taskSection(task, name, label) {
  const key = `${state.session.id}:${task.id}:${task.taskVersion || 1}:${name}`;
  const details = node("details", name);
  details.open = sections.get(key) ?? true;
  details.append(node("summary", "", label));
  details.addEventListener("toggle", () => {
    if (!details.isConnected) return;
    if (!sections.has(key) && sections.size >= 100)
      sections.delete(sections.keys().next().value);
    sections.set(key, details.open);
  });
  return details;
}
