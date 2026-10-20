import { api } from "./api.js";
import { state } from "./state.js";
import { node, formDialog, toast } from "./ui.js";
import { button } from "./icons.js";
import { t } from "./i18n.js";
import { randomUUID } from "./uuid.js";
import { codebaseURL } from "./codebaseTree.js";
import { openSession, languageOptions } from "./sessions.js";
import { attachProcess } from "./terminal.js";
const tr = (key, params) => t(`features:codebase.${key}`, params);
export async function renderDemos(host, id) {
  const [data, cards, capabilities] = await Promise.all([
    api(`${codebaseURL(id)}/demos`),
    api(`${codebaseURL(id)}/actions`),
    api("/api/codebase/capabilities"),
  ]);
  if (!host.isConnected || state.session?.id !== id) return;
  const reload = async () => {
    if (!host.isConnected || state.session?.id !== id) return;
    host.replaceChildren(node("h3", "", tr("demos")));
    await renderDemos(host, id);
  };
  host.append(node("p", "muted", tr("demoHelp")));
  host.append(
    button(tr("createDemo"), "plus", () =>
      createDemo(id)
        .then(reload)
        .catch((e) => toast(e.message, "error")),
    ),
  );
  for (const demo of data.demos || []) {
    const row = node("article", "codebase-demo");
    row.append(
      node("h4", "", demo.title || demo.description || demo.demoId),
      node("p", "", demo.description || ""),
    );
    row.append(
      button(tr("openDemo"), "file", () => openSession(demo.sessionId)),
    );
    if (!capabilities.executionAllowed)
      row.append(node("p", "muted", tr("demoIsolation")));
    const runtime = capabilities.runtimes?.find(
      (item) => item.language === demo.language,
    );
    if (
      capabilities.executionAllowed &&
      runtime?.available &&
      demo.status === "applied" &&
      !demo.changed
    )
      row.append(
        button(tr("requestDemoRun"), "play", async () => {
          await api(
            `${codebaseURL(id)}/demos/${encodeURIComponent(demo.demoId)}/run`,
            {
              method: "POST",
              body: {
                fileVersion: demo.fileVersion,
                operationId: randomUUID(),
              },
            },
          );
          await reload();
        }),
      );
    else if (
      !runtime?.available &&
      capabilities.installationAvailable &&
      capabilities.aiTerminalAllowed
    )
      row.append(
        button(tr("requestRuntime"), "plus", async () => {
          await api(
            `${codebaseURL(id)}/demos/${encodeURIComponent(demo.demoId)}/runtime-request`,
            {
              method: "POST",
              body: {
                programId: demo.language,
                reason: demo.description || demo.title || tr("demoDescription"),
                operationId: randomUUID(),
              },
            },
          );
          await reload();
        }),
      );
    if (demo.changed) row.append(node("p", "muted", tr("demoChanged")));
    host.append(row);
  }
  for (const card of Array.isArray(cards)
    ? cards
    : cards.actions || cards.requests || []) {
    const row = node("article", "codebase-decision");
    row.append(
      node(
        "h4",
        "",
        tr(
          card.kind === "demo-execution"
            ? "executionDecision"
            : "runtimeDecision",
        ),
      ),
      node(
        "p",
        "",
        tr("runtimeDescription", {
          program: card.programId || card.program?.name || "",
          reason: card.reason || "",
          demo: card.demoId || "",
        }),
      ),
      node(
        "p",
        "muted",
        tr(card.kind === "demo-execution" ? "executionScope" : "runtimeScope"),
      ),
      node(
        "p",
        "muted",
        tr("boundVersion", {
          version: card.fileVersion || "",
          expires: card.expiresAt || "",
        }),
      ),
    );
    if (card.affectedWork?.length)
      row.append(
        node("p", "", tr("affectedWork", { count: card.affectedWork.length })),
      );
    if (card.status && card.status !== "pending" && card.status !== "proposed")
      row.append(
        node("p", "muted", tr("decisionStatus", { status: card.status })),
      );
    else
      for (const decision of [
        card.kind === "demo-execution" ? "run" : "install",
        "code-only",
        "cancel",
      ]) {
        const action = button(
          tr(
            decision === "install"
              ? "installRuntime"
              : decision === "run"
                ? "runDemo"
                : decision === "code-only"
                  ? "codeOnly"
                  : "cancelDemo",
          ),
          null,
          async () => {
            for (const b of row.querySelectorAll("button")) b.disabled = true;
            try {
              const result = await api(
                `${codebaseURL(id)}/actions/${encodeURIComponent(card.requestId || card.id)}/decision`,
                { method: "POST", body: { decision } },
              );
              if (state.session?.id !== id || !host.isConnected) return;
              row.append(node("p", "", tr("decisionSaved")));
              if (result.process) {
                await openSession(card.demoSessionId);
                attachProcess(result.process);
              }
            } catch (e) {
              toast(e.message, "error");
              for (const b of row.querySelectorAll("button"))
                b.disabled = false;
            }
          },
        );
        row.append(action);
      }
    host.append(row);
  }
}
async function createDemo(id) {
  await formDialog({
    title: tr("createDemo"),
    description: tr("demoHelp"),
    fields: [
      {
        name: "title",
        label: t("sessions:name"),
        required: true,
        maxLength: 200,
      },
      {
        name: "language",
        label: t("app:static.programmingLanguage"),
        type: "select",
        options: languageOptions,
      },
      {
        name: "description",
        label: tr("demoDescription"),
        type: "textarea",
        required: true,
      },
      { name: "path", label: tr("demoPath"), value: "demo.py", required: true },
      {
        name: "code",
        label: tr("demoCode"),
        type: "textarea",
        required: true,
        rows: 10,
      },
    ],
    onSave: async (values) => {
      await api(`${codebaseURL(id)}/demos`, {
        method: "POST",
        body: { ...values, operationId: randomUUID() },
      });
    },
  });
}
