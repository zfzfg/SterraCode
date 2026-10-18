import { api } from "./api.js";
import { state, emit, on } from "./state.js";
import { $, toast } from "./ui.js";
import { flush, currentFile, fileLanguage } from "./editor.js";
const sessions = new Map();
let polling = false;
let timer;
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
  $("terminal-output").textContent = s.output;
  $("stop-process-btn").disabled = s.exited;
  $("process-status").textContent = s.processId
    ? s.exited
      ? `Beendet · ${s.reason === "timeout" ? "Zeitlimit" : s.reason === "output_limit" ? "Ausgabelimit" : s.reason === "stopped" ? "gestoppt" : "Exit " + s.exitCode}`
      : "Läuft"
    : "Bereit";
  $("terminal-input").placeholder = s.exited
    ? "Befehl im Session-Workspace eingeben …"
    : "Eingabe für das laufende Programm …";
}
export function attachProcess(job) {
  const s = entry(job.sessionId);
  if (s.processId !== job.processId) {
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
        s.offset = job.offset;
        s.exited = job.exited;
        s.exitCode = job.exitCode;
        s.reason = job.reason;
        if (state.session?.id === id) {
          const output = $("terminal-output"),
            bottom =
              output.scrollHeight - output.scrollTop - output.clientHeight < 60;
          display();
          if (bottom) output.scrollTop = output.scrollHeight;
        }
      } catch (error) {
        s.exited = true;
        s.output += `\n${error.message}\n`;
        if (state.session?.id === id) {
          display();
          toast(error.message, "error");
        }
      }
    }
    if (running) startPolling();
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
