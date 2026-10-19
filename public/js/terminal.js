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
  $("terminal-panel").hidden = !show;
  $("terminal-toggle").setAttribute("aria-expanded", String(show));
  emit("layout");
}
function entry(id = state.session?.id) {
  if (!sessions.has(id))
    sessions.set(id, { output: "", processId: null, offset: 0, exited: true });
  return sessions.get(id);
}
function display() {
  const s = entry();
  showDiagnostic(s);
  $("terminal-output").textContent = s.output;
  $("stop-process-btn").disabled = s.exited;
  const reasons = {
    timeout: "Zeitlimit",
    output_limit: "Ausgabelimit",
    stopped: "gestoppt",
    interrupted: "durch Runner-Neustart unterbrochen",
    runner_restarted: "durch Runner-Neustart unterbrochen",
    output_expired: "Ausgabe abgelaufen",
    resource_limit_or_sigkill: "Signal 9 · mögliches Ressourcenlimit",
  };
  $("process-status").textContent = s.processId
    ? s.unavailable
      ? "Runner-Verbindung unterbrochen – Wiederverbindung läuft"
      : s.exited
        ? `Beendet · ${reasons[s.reason] || "Exit " + s.exitCode}`
        : "Läuft"
    : "Bereit";
  $("terminal-input").placeholder = s.exited
    ? "Befehl im Session-Workspace eingeben …"
    : "Eingabe für das laufende Programm …";
}
export function attachProcess(job) {
  const s = entry(job.sessionId);
  if (s.processId !== job.processId) {
    s.diagnosticOffset = s.output.length;
    s.diagnosticKey = s.diagnostic = null;
    s.output += `\n${job.actor === "ai" ? "KI" : "Nutzer"} > ${job.command}\n`;
    s.offset = 0;
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
        s.output += job.output;
        s.offset = job.nextOffset ?? job.offset;
        s.unavailable = false;
        s.exited = job.exited;
        s.exitCode = job.exitCode;
        s.reason = job.outputExpired ? "output_expired" : job.reason;
        if (job.outputExpired)
          s.output +=
            "\nDie Runner-Ausgabe ist nach fünf Minuten abgelaufen. Der Auftrag wird nicht erneut ausgeführt.\n";
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
  if (!state.session) throw new Error("Bitte zuerst eine Session auswählen.");
  await flush();
  const file = currentFile();
  if (!file) throw new Error("Bitte zuerst eine Datei öffnen.");
  const language = runtimeLanguage();
  const runtime = state.runtimes.find((r) => r.language === language);
  if (!runtime?.available)
    throw new Error(runtime?.reason || "Die Laufzeit wird noch geprüft.");
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
    !state.session || !currentFile() || !runtime?.available;
  $("runtime-hint").textContent =
    state.session && currentFile() && !runtime?.available
      ? runtime?.reason || "Laufzeiten werden geprüft …"
      : "";
}
export function initTerminal() {
  diagnostics = document.createElement("div");
  diagnostics.id = "terminal-diagnostics";
  $("terminal-output").after(diagnostics);
  $("terminal-toggle").addEventListener("click", () =>
    showTerminal($("terminal-panel").hidden),
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
      if (!state.session)
        throw new Error("Bitte zuerst eine Session auswählen.");
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
    entry().output = "";
    entry().diagnosticOffset = 0;
    entry().diagnosticKey = entry().diagnostic = null;
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
