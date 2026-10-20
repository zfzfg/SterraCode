import { api } from "./api.js";
import { state } from "./state.js";
import { $, node, toast } from "./ui.js";
import { button } from "./icons.js";
import { t } from "./i18n.js";
import { selectFile, renameFile, removeFile } from "./workspace.js";

export const isCodebase = (session = state.session) =>
  session?.mode === "codebase";
export const codebaseURL = (id = state.session?.id) =>
  `/api/codebase/sessions/${encodeURIComponent(id)}`;
export function formatBytes(bytes) {
  return t("features:codebase.megabytes", {
    value: new Intl.NumberFormat(document.documentElement.lang, {
      maximumFractionDigits: 1,
    }).format((Number(bytes) || 0) / 1000000),
  });
}

// Only loaded directory pages are retained. Search is a view, never a selection.
export async function loadCodebaseTree() {
  const id = state.session?.id;
  if (!id) return;
  const container = $("file-tree");
  container.removeAttribute("role");
  const search = node("input", "codebase-search");
  search.type = "search";
  search.placeholder = t("features:codebase.search");
  search.setAttribute("aria-label", t("features:codebase.search"));
  const list = node("ul", "codebase-tree");
  container.replaceChildren(search, list);
  let generation = 0;
  async function page(parent, target, cursor, token = generation) {
    const params = new URLSearchParams({ parent, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    if (search.value) params.set("query", search.value);
    const data = await api(
      `/api/workspaces/${encodeURIComponent(id)}/tree?${params}`,
    );
    if (state.session?.id !== id || token !== generation || !target.isConnected)
      return;
    for (const entry of data.entries) {
      const row = node("li");
      const folder = entry.type === "folder";
      const open = button(
        entry.name,
        folder ? "folder" : "file",
        async () => {
          try {
            if (folder) {
              const expanded = open.getAttribute("aria-expanded") === "true";
              open.setAttribute("aria-expanded", String(!expanded));
              if (expanded) children.replaceChildren();
              else await page(entry.path, children, null, token);
              children.hidden = expanded;
            } else await selectFile(entry.path);
          } catch (error) {
            toast(error.message, "error");
          }
        },
        "tree-open",
      );
      open.title = entry.path;
      const controls = node("div", "codebase-tree-row");
      controls.append(
        open,
        button(
          t("features:workspace.renameLabel", { p1: entry.name }),
          "edit",
          () => renameFile(entry.path),
          "icon-only",
        ),
        button(
          t("features:workspace.deleteLabel", { p1: entry.name }),
          "trash",
          () => removeFile(entry.path),
          "icon-only",
        ),
      );
      row.append(controls);
      const children = node("ul", "codebase-tree");
      if (folder) {
        open.setAttribute("aria-expanded", "false");
        children.hidden = true;
        row.append(children);
      } else if (entry.editorEligible === false) {
        row.append(node("small", "muted", t("features:codebase.infoOnly")));
      }
      target.append(row);
    }
    if (data.nextCursor) {
      const more = button(t("features:codebase.more"), null, async () => {
        more.disabled = true;
        try {
          await page(parent, target, data.nextCursor, token);
          more.remove();
        } catch (error) {
          more.disabled = false;
          toast(error.message, "error");
        }
      });
      const row = node("li");
      row.append(more);
      target.append(row);
    }
    if (!data.entries.length && !cursor)
      target.append(node("li", "muted", t("features:codebase.noFiles")));
  }
  let timer;
  search.oninput = () => {
    clearTimeout(timer);
    const token = ++generation;
    timer = setTimeout(() => {
      list.replaceChildren();
      page("", list, null, token).catch((error) =>
        toast(error.message, "error"),
      );
    }, 250);
  };
  await page("", list);
}
