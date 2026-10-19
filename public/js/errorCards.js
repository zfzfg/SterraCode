import { explainError } from "./errorCatalog.js";
import { state } from "./state.js";
import { node, toast } from "./ui.js";
import { selectFile } from "./workspace.js";
import { revealLine } from "./editor.js";

export function errorCard(data) {
  const sessionId = data.sessionId || state.session?.id;
  const info = explainError(data);
  const card = node("section", "error-card");
  card.setAttribute("aria-label", "Fehlerkarte");
  card.append(
    node("strong", "", `${info.category}: ${info.title}`),
    node("p", "", info.explanation),
  );
  if (data.runId)
    card.append(
      node(
        "small",
        "muted",
        `Lauf: ${data.runId}${data.historical ? " · gespeicherter Stand; Editor zeigt aktuelle Datei" : ""}`,
      ),
    );
  if (data.file && Number.isInteger(data.line) && data.line > 0) {
    const jump = node("button", "", `Zur Zeile: ${data.file}:${data.line}`);
    jump.onclick = async () => {
      if (state.session?.id !== sessionId) return;
      try {
        await selectFile(data.file);
        if (state.session?.id === sessionId) {
          revealLine(data.line);
          document.getElementById("view-editor")?.click();
          data.onNavigate?.();
        }
      } catch (e) {
        toast(e.message, "error");
      }
    };
    card.append(jump);
  }
  const original = node("details");
  original.append(
    node("summary", "", "Originalmeldung"),
    node(
      "pre",
      "",
      data.message || data.reason || data.kind || "Keine weitere Meldung.",
    ),
  );
  card.append(original);
  return card;
}
