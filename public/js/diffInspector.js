import { t } from "./i18n.js";
import { api, workspaceURL, sessionURL } from "./api.js";
import { state } from "./state.js";
import { node } from "./ui.js";
import { button } from "./icons.js";
import { flush, refreshEditor, fileLanguage } from "./editor.js";
import { loadFiles } from "./workspace.js";
import { randomUUID } from "./uuid.js";

const labels = () => ({
  pending_review: t("features:diffInspector.pending"),
  applied: t("features:diffInspector.applied"),
  partially_applied: t("features:diffInspector.partiallyApplied"),
  rejected: t("features:diffInspector.rejected"),
  stale: t("features:diffInspector.stale"),
  undone: t("features:shared.undone"),
  pending: t("features:diffInspector.interrupted"),
});
function modal(title) {
  const previous = document.activeElement;
  const dialog = node("dialog", "diff-dialog");
  const heading = node("h2", "", title);
  heading.id = `diff-${randomUUID()}`;
  dialog.setAttribute("aria-labelledby", heading.id);
  const close = button(t("features:shared.close"), "close", () =>
    dialog.close(),
  );
  const header = node("div", "dialog-heading");
  header.append(heading, close);
  dialog.append(header);
  document.body.append(dialog);
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      (previous?.isConnected
        ? previous
        : document.getElementById("changes-btn")
      )?.focus();
    },
    { once: true },
  );
  dialog.showModal();
  close.focus();
  return dialog;
}
async function refresh(sid) {
  if (state.session?.id !== sid) return;
  state.session = await api(sessionURL(sid));
  await refreshEditor();
  await loadFiles();
  window.dispatchEvent(new CustomEvent("diff-decided"));
}
export async function inspectDiff(sid, id, proposal = false) {
  const dialog = modal(t("features:shared.inspectChange"));
  const info = node("p", "", t("features:diffInspector.loading"));
  dialog.append(info);
  let ed, original, modified;
  const dispose = () => {
    ed?.dispose();
    original?.dispose();
    modified?.dispose();
  };
  dialog.addEventListener("close", dispose, { once: true });
  try {
    const url = `${workspaceURL(sid)}/${proposal ? "proposals" : "changes"}/${id}`;
    const data = await api(url);
    const appliedChange =
      proposal && data.changeId
        ? await api(`${workspaceURL(sid)}/changes/${data.changeId}`)
        : null;
    if (!dialog.isConnected) return;
    info.textContent = `${data.historicalPath || data.path} · ${labels()[data.status] || data.status} · ${data.reason || t("features:shared.aiChange")}`;
    dialog.append(node("p", "muted", t("features:diffInspector.help")));
    if (!proposal && !data.diffAvailable) {
      dialog.append(node("p", "", t("features:diffInspector.noAfter")));
    } else {
      const container = node("div", "diff-editor");
      dialog.append(container);
      original = monaco.editor.createModel(
        data.before.content || "",
        fileLanguage(data.path),
      );
      modified = monaco.editor.createModel(
        proposal
          ? (appliedChange?.after?.content ?? data.proposedContent)
          : data.after.content,
        fileLanguage(data.path),
      );
      const media = matchMedia("(min-width: 900px)");
      ed = monaco.editor.createDiffEditor(container, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: media.matches,
        theme: "sterra",
        minimap: { enabled: false },
        maxComputationTime: 2000,
        accessibilitySupport: "auto",
      });
      ed.setModel({ original, modified });
      const resize = () =>
        ed.updateOptions({ renderSideBySide: media.matches });
      media.addEventListener("change", resize);
      dialog.addEventListener(
        "close",
        () => media.removeEventListener("change", resize),
        { once: true },
      );
      dialog.append(
        button(t("features:diffInspector.next"), null, () =>
          ed.goToDiff("next"),
        ),
      );
    }
    const controls = node("div", "diff-actions");

    let processing = false;
    const perform = async (action) => {
      if (processing) return;
      processing = true;
      try {
        await action();
        await refresh(sid);
        dialog.close();
      } finally {
        processing = false;
      }
    };
    if (proposal && data.status === "pending_review") {
      dialog.append(node("p", "muted", t("features:diffInspector.hunksHelp")));
      const choices = node("fieldset");
      choices.append(
        node("legend", "", t("features:diffInspector.selectHunks")),
      );
      const inputs = data.hunks.map((h) => {
        const label = node("label", "diff-hunk");
        const input = node("input");
        input.type = "checkbox";
        input.checked = true;
        input.value = h.id;
        label.append(
          input,
          document.createTextNode(
            h.summary +
              (h.dependsOn.length
                ? t("features:diffInspector.depends", {
                    p1: h.dependsOn.join(", "),
                  })
                : ""),
          ),
        );
        choices.append(label);
        return input;
      });
      dialog.append(choices);
      let operationId = randomUUID();
      choices.addEventListener("change", () => {
        operationId = randomUUID();
      });
      const apply = button(t("features:diffInspector.apply"), "check", () =>
        perform(async () => {
          if (state.busy)
            throw new Error(t("features:diffInspector.finishTurn"));
          await flush();
          await api(`${url}/apply`, {
            method: "POST",
            body: {
              operationId,
              expectedVersion: data.baseVersion,
              selectedHunkIds: inputs
                .filter((i) => i.checked)
                .map((i) => i.value),
            },
          });
        }),
      );
      apply.disabled = !inputs.length || state.busy;
      controls.append(apply);
    }
    if (proposal && ["pending_review", "stale"].includes(data.status))
      controls.append(
        button(t("features:diffInspector.reject"), "close", () =>
          perform(() => api(`${url}/reject`, { method: "POST", body: {} })),
        ),
      );
    const changeId = proposal ? data.changeId : id;
    if (changeId && ["applied", "partially_applied"].includes(data.status)) {
      const undo = button(t("features:shared.undo"), "undo", () =>
        perform(async () => {
          if (state.busy)
            throw new Error(t("features:diffInspector.finishTurn"));
          await flush();
          await api(`${workspaceURL(sid)}/changes/${changeId}/undo`, {
            method: "POST",
            body: {},
          });
        }),
      );
      undo.disabled = state.busy;
      controls.append(undo);
    }
    dialog.append(controls);
  } catch (e) {
    info.textContent = e.message;
    dispose();
  }
}
export async function showDiffHistory() {
  if (!state.session) throw new Error(t("features:shared.selectSession"));
  const sid = state.session.id;
  const dialog = modal(t("features:diffInspector.title"));
  const loading = node("p", "", t("features:diffInspector.loadingHistory"));
  dialog.append(loading);
  try {
    const [proposals, changes] = await Promise.all([
      api(`${workspaceURL(sid)}/proposals`),
      api(`${workspaceURL(sid)}/changes`),
    ]);
    if (!dialog.isConnected) return;
    loading.textContent = t("features:diffInspector.historyHelp");
    const list = node("div", "diff-history");
    dialog.append(list);
    for (const [records, isProposal] of [
      [proposals, true],
      [changes, false],
    ])
      for (const record of records) {
        list.append(
          button(
            `${isProposal ? t("features:diffInspector.proposal") : t("features:tracer.change")}: ${record.path} · ${labels()[record.status] || record.status} · ${record.reason || t("features:shared.aiChange")}`,
            "file",
            () => {
              dialog.close();
              return inspectDiff(
                sid,
                record.proposalId || record.changeId,
                isProposal,
              );
            },
          ),
        );
      }
    if (!proposals.length && !changes.length)
      list.append(node("p", "", t("features:diffInspector.empty")));
  } catch (e) {
    loading.textContent = e.message;
  }
}
