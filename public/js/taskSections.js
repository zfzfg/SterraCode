import { node } from "./ui.js";
import { state } from "./state.js";

const sections = new Map();

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
