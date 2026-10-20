import { t, translateMessage } from "./i18n.js";
import { explainError } from "./errorCatalog.js";
import { state } from "./state.js";
import { node, toast } from "./ui.js";
import { selectFile } from "./workspace.js";
import { revealLine } from "./editor.js";

export function errorCard(data) {
  const sessionId = data.sessionId || state.session?.id;
  const info = explainError(data);
  const card = node("section", "error-card");
  card.setAttribute("aria-label", t("features:errorCards.label"));
  card.append(
    node("strong", "", `${info.category}: ${info.title}`),
    node("p", "", info.explanation),
  );
  if (data.runId)
    card.append(
      node(
        "small",
        "muted",
        t("features:errorCards.run", {
          p1: data.runId,
          p2: data.historical ? t("features:errorCards.historical") : "",
        }),
      ),
    );
  if (data.file && Number.isInteger(data.line) && data.line > 0) {
    const jump = node(
      "button",
      "",
      t("features:errorCards.jump", { p1: data.file, p2: data.line }),
    );
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
    node("summary", "", t("features:errorCards.original")),
    node(
      "pre",
      "",
      translateMessage(
        data,
        data.message ||
          data.reason ||
          data.kind ||
          t("features:errorCards.noMessage"),
      ),
    ),
  );
  card.append(original);
  return card;
}
