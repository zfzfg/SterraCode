import { t, translateMessage } from "./i18n.js";
import { api } from "./api.js";
import { state, emit, on } from "./state.js";
import { $, toast } from "./ui.js";
import { flush, currentFile, fileLanguage } from "./editor.js";
import { errorLocation } from "./errorCatalog.js";
import { errorCard } from "./errorCards.js";
const sessions = new Map();
let polling = false;
let timer;
let diagnostics;
async function showDiagnostic(s) {
  const id = state.session?.id;
  const key = `${s.processId}:${s.output.length}:${s.reason}:${s.exitCode}`;
  if (!diagnostics || !s.output || !s.exited || (!s.reason && !s.exitCode)) {
    diagnostics?.replaceChildren();
    return;
  }
  if (s.diagnosticKey === key) {
    diagnostics.replaceChildren(...(s.diagnostic ? [s.diagnostic] : []));
    return;
  }
  s.diagnosticKey = key;
  const output = s.output.slice(s.diagnosticOffset || 0).slice(-65536);
  let paths = [];
  try {
    const tree = await api(`/api/workspaces/${id}/files`);
    const walk = (items) => {
      for (const f of items) {
        if (f.children) walk(f.children);
        else paths.push(f.path);
      }
    };
    walk(tree);
  } catch {
    /* The original diagnostic remains useful without source navigation. */
  }
  if (s.diagnosticKey !== key) return;
  s.diagnostic = errorCard({
    message: output,
    reason: s.reason,
    ...errorLocation(output, paths, id),
    sessionId: id,
    runId: s.processId,
    historical: true,
  });
  if (state.session?.id === id) diagnostics.replaceChildren(s.diagnostic);
}
export function showTerminal(show = true) {
  if (show && !state.session) {
    toast(t("features:shared.openSession"));
    return;
  }
  if (show && innerWidth < 960) $("view-editor").click();
  $("terminal-panel").hidden = !show;
  $("terminal-toggle").setAttribute("aria-expanded", String(show));
  $("terminal-resizer").setAttribute("aria-expanded", String(show));
  emit("layout");
}
function entry(id = state.session?.id) {
  if (!sessions.has(id))
    sessions.set(id, {
      output: "",
      processId: null,
      offset: 0,
      exited: true,
      jobs: [],
      systemMessages: [],
    });
  return sessions.get(id);
}
function appendSystemMessages(s, job, offset, start) {
  for (const message of job.systemMessages || []) {
    const key = `${job.processId}:${message.outputOffset}:${message.messageKey}:${JSON.stringify(message.params)}`;
    if (s.systemMessages.some((item) => item.dedupeKey === key)) continue;
    s.systemMessages.push({
      ...message,
      dedupeKey: key,
      position: start + Math.max(0, message.outputOffset - offset),
    });
  }
}
function displayedOutput(s) {
  let output = "",
    start = 0;
  for (const message of [...s.systemMessages].sort(
    (a, b) => a.position - b.position,
  )) {
    const position = Math.min(s.output.length, message.position);
    output +=
      s.output.slice(start, position) +
      "\n" +
      translateMessage(message, message.message || "") +
      "\n";
    start = position;
  }
  return output + s.output.slice(start);
}
export const terminalWorkActive = () =>
  [...sessions.values()].some((s) => s.processId && !s.exited);
export const captureTerminalState = () =>
  [...sessions].map(([sessionId, s]) => ({
    sessionId,
    jobs: s.jobs.map(({ processId, actor, fromOffset, hideHeader }) => ({
      processId,
      actor,
      fromOffset,
      hideHeader,
    })),
  }));
export async function restoreTerminalState(saved) {
  if (!Array.isArray(saved)) return;
  for (const row of saved.slice(-100)) {
    if (typeof row?.sessionId !== "string" || !Array.isArray(row.jobs))
      continue;
    const s = entry(row.sessionId);
    for (const meta of row.jobs.slice(-100)) {
      if (typeof meta?.processId !== "string") continue;
      const offset =
        Number.isSafeInteger(meta.fromOffset) && meta.fromOffset > 0
          ? meta.fromOffset
          : 0;
      try {
        const job = await api(
          `/api/terminal/${encodeURIComponent(meta.processId)}/output?sessionId=${encodeURIComponent(row.sessionId)}&offset=${offset}`,
        );
        if (!meta.hideHeader)
          s.output += `\n${(job.actor || meta.actor) === "ai" ? t("features:terminal.ai") : t("features:terminal.user")} > ${job.command || ""}\n`;
        appendSystemMessages(s, job, offset, s.output.length);
        s.output += job.output || "";
        Object.assign(s, {
          processId: job.processId,
          exited: job.exited,
          exitCode: job.exitCode,
          reason: job.outputExpired ? "output_expired" : job.reason,
          offset: job.nextOffset ?? job.offset,
          unavailable: false,
        });
        if (job.outputExpired) s.output += t("features:terminal.outputExpired");
      } catch (error) {
        if ([0, 502, 503, 504].includes(error.status)) throw error;
        s.output +=
          "\n" +
          t("features:terminal.restoreUnavailable", {
            message: error.message,
          }) +
          "\n";
        Object.assign(s, {
          processId: meta.processId,
          exited: true,
          reason: "output_expired",
        });
      }
      s.jobs.push(meta);
    }
  }
  display();
  if (terminalWorkActive()) startPolling();
}
function display() {
  const s = entry();
  showDiagnostic(s);
  $("terminal-output").textContent = displayedOutput(s);
  $("stop-process-btn").disabled = s.exited;
  const reasons = {
    timeout: t("features:terminal.timeLimit"),
    output_limit: t("features:terminal.outputLimit"),
    stopped: t("features:terminal.stopped"),
    interrupted: t("features:terminal.runnerRestart"),
    runner_restarted: t("features:terminal.runnerRestart"),
    output_expired: t("features:terminal.expired"),
    resource_limit_or_sigkill: t("features:terminal.resourceLimit"),
  };
  $("process-status").textContent = s.processId
    ? s.unavailable
      ? t("features:terminal.reconnecting")
      : s.exited
        ? t("features:terminal.ended", {
            p1:
              reasons[s.reason] ||
              t("features:terminal.exit", { code: s.exitCode }),
          })
        : t("features:terminal.running")
    : t("features:shared.ready");
  $("terminal-input").placeholder = s.exited
    ? t("features:terminal.commandPlaceholder")
    : t("features:terminal.inputPlaceholder");
}
export function attachProcess(job) {
  const s = entry(job.sessionId);
  if (s.processId !== job.processId) {
    s.diagnosticOffset = s.output.length;
    s.diagnosticKey = s.diagnostic = null;
    s.output += `\n${job.actor === "ai" ? t("features:terminal.ai") : t("features:terminal.user")} > ${job.command}\n`;
    s.offset = 0;
    s.jobs.push({
      processId: job.processId,
      command: job.command || "",
      actor: job.actor,
      fromOffset: 0,
    });
  }
  Object.assign(s, {
    processId: job.processId,
    exited: job.exited,
    exitCode: job.exitCode,
    reason: job.reason,
  });
  if (state.session?.id === job.sessionId) {
    showTerminal();
    display();
  }
  startPolling();
}
function startPolling() {
  clearTimeout(timer);
  timer = setTimeout(poll, 200);
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    let running = false;
    for (const [id, s] of sessions) {
      if (!s.processId || s.exited) continue;
      running = true;
      try {
        const job = await api(
          `/api/terminal/${s.processId}/output?sessionId=${id}&offset=${s.offset}`,
        );
        appendSystemMessages(s, job, s.offset, s.output.length);
        s.output += job.output;
        s.offset = job.nextOffset ?? job.offset;
        s.unavailable = false;
        s.exited = job.exited;
        s.exitCode = job.exitCode;
        s.reason = job.outputExpired ? "output_expired" : job.reason;
        if (job.outputExpired) s.output += t("features:terminal.outputExpired");
        if (state.session?.id === id) {
          const output = $("terminal-output"),
            bottom =
              output.scrollHeight - output.scrollTop - output.clientHeight < 60;
          display();
          if (bottom) output.scrollTop = output.scrollHeight;
        }
      } catch (error) {
        const recoverable =
          error.status === 0 ||
          error.status === 502 ||
          error.status === 503 ||
          error.status === 504;
        s.exited = !recoverable;
        if (!s.unavailable) s.output += `\n${error.message}\n`;
        const firstFailure = !s.unavailable;
        s.unavailable = recoverable;
        if (state.session?.id === id) {
          display();
          if (firstFailure) toast(error.message, "error");
        }
      }
    }
    if (running) {
      clearTimeout(timer);
      timer = setTimeout(
        poll,
        [...sessions.values()].some((s) => s.unavailable) ? 2000 : 200,
      );
    }
  } finally {
    polling = false;
  }
}
export async function runCode() {
  if (!state.session) throw new Error(t("features:shared.selectSession"));
  if (["codebase", "demo"].includes(state.session.mode))
    throw new Error(t("features:codebase.useDemo"));
  await flush();
  const file = currentFile();
  if (!file) throw new Error(t("features:terminal.openFile"));
  const language = runtimeLanguage();
  const runtime = state.runtimes.find((r) => r.language === language);
  if (!runtime?.available)
    throw new Error(
      translateMessage(
        { messageKey: runtime?.reasonKey, params: runtime?.reasonParams },
        runtime?.reason || t("features:terminal.checking"),
      ),
    );
  attachProcess(
    await api("/api/terminal", {
      method: "POST",
      body: { sessionId: state.session.id, file, language },
    }),
  );
}
function runtimeLanguage() {
  const lang = fileLanguage(currentFile());
  return lang === "shell"
    ? "bash"
    : state.runtimes.some((r) => r.language === lang)
      ? lang
      : state.session?.language;
}
export function updateRunState() {
  const runtime = state.runtimes.find((r) => r.language === runtimeLanguage());
  $("run-btn").disabled =
    !state.session ||
    state.session.mode === "codebase" ||
    state.session.mode === "demo" ||
    !currentFile() ||
    !runtime?.available;
  $("runtime-hint").textContent =
    state.session?.mode === "codebase" || state.session?.mode === "demo"
      ? t("features:codebase.useDemo")
      : state.session && currentFile() && !runtime?.available
        ? translateMessage(
            { messageKey: runtime?.reasonKey, params: runtime?.reasonParams },
            runtime?.reason || t("features:terminal.checkingAll"),
          )
        : "";
}
export function initTerminal() {
  diagnostics = document.createElement("div");
  diagnostics.id = "terminal-diagnostics";
  $("terminal-output").after(diagnostics);
  $("terminal-toggle").addEventListener("click", () =>
    showTerminal(
      $("terminal-panel").hidden ||
        (innerWidth < 960 && $("app").dataset.view === "chat"),
    ),
  );
  $("close-terminal-btn").addEventListener("click", () => showTerminal(false));
  $("run-btn").addEventListener("click", () =>
    runCode().catch((e) => toast(e.message, "error")),
  );
  on("run-code", runCode);
  $("terminal-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("terminal-input").value;
    if (!text.trim()) return;
    try {
      if (!state.session) throw new Error(t("features:shared.selectSession"));
      const s = entry();
      if (s.processId && !s.exited) {
        await api(`/api/terminal/${s.processId}/input`, {
          method: "POST",
          body: { sessionId: state.session.id, input: text },
        });
        s.output += text + "\n";
        display();
      } else
        attachProcess(
          await api("/api/terminal", {
            method: "POST",
            body: { sessionId: state.session.id, command: text },
          }),
        );
      $("terminal-input").value = "";
    } catch (e) {
      toast(e.message, "error");
    }
  });
  $("clear-terminal-btn").addEventListener("click", () => {
    const s = entry();
    s.output = "";
    s.systemMessages = [];
    s.jobs =
      s.processId && !s.exited
        ? [
            {
              ...(s.jobs.at(-1) || {}),
              processId: s.processId,
              command: s.jobs.at(-1)?.command || "",
              fromOffset: s.offset,
              hideHeader: true,
            },
          ]
        : [];
    s.diagnosticOffset = 0;
    s.diagnosticKey = s.diagnostic = null;
    display();
  });
  $("stop-process-btn").addEventListener("click", async () => {
    const s = entry();
    try {
      await api(`/api/terminal/${s.processId}`, {
        method: "DELETE",
        body: { sessionId: state.session.id },
      });
      await poll();
    } catch (e) {
      toast(e.message, "error");
    }
  });
  on("session-opened", () => {
    display();
    updateRunState();
  });
  on("runtime-changed", updateRunState);
}
