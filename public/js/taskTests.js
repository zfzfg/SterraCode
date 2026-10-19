import { api, workspaceURL } from "./api.js";
import { state } from "./state.js";
import { flush } from "./editor.js";
import { node, toast } from "./ui.js";
import { errorCard } from "./errorCards.js";
import { openPrograms } from "./programs.js";
import { showTerminal } from "./terminal.js";
import { randomUUID } from "./uuid.js";

const valueType = (value) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

export function renderTaskTests(container, task, onComplete) {
  const sessionId = state.session.id;
  const base = workspaceURL(sessionId);
  const panel = node("section", "task-tests");
  panel.setAttribute("aria-label", "Lösung prüfen");
  const status = node("p");
  status.setAttribute("role", "status");
  const cases = node("div");
  const controls = node("div", "task-test-controls");
  const assistanceLabel = node("label", "", "Lösungshilfe (eigene Angabe): ");
  const assistance = node("select");
  for (const [value, label] of [
    ["not_recorded", "Keine Angabe"],
    ["independent", "Selbstständig gelöst"],
    ["assisted", "Mit Lösungshilfe"],
  ]) {
    const option = node("option", "", label);
    option.value = value;
    assistance.append(option);
  }
  assistanceLabel.append(assistance);
  const start = node("button", "", "Lösung prüfen");
  const cancel = node("button", "", "Tests abbrechen");
  const complete = node(
    "button",
    "",
    task.done ? "Aufgabe abgeschlossen" : "Aufgabe abschließen",
  );
  const discuss = node("button", "", "Testergebnis im Chat vorbereiten");
  const historyLabel = node("label", "", "Gespeicherte Testläufe");
  const history = node("select");
  historyLabel.append(history);
  let caseSignature,
    run,
    timer,
    requestBody,
    reading = 0;
  const current = () =>
    panel.isConnected &&
    state.session?.id === sessionId &&
    state.session.currentTask?.id === task.id &&
    (state.session.currentTask.taskVersion || 1) === (task.taskVersion || 1);
  const active = () => ["starting", "running"].includes(run?.status);
  cancel.hidden = true;
  complete.disabled = true;
  discuss.disabled = true;
  controls.append(start, cancel, complete, discuss);
  panel.append(
    node(
      "p",
      "muted",
      `Python: ${task.testSuite.entry.path} → ${task.testSuite.entry.function}. Strenger JSON-Vergleich; maximal 2 Sekunden je Fall / 30 Sekunden je Suite.`,
    ),
    controls,
    assistanceLabel,
    historyLabel,
    status,
    cases,
  );
  const examples = node("details");
  const sources = node("details");
  sources.append(
    node(
      "summary",
      "",
      "Python-Quelldateien im Snapshot auswählen (maximal 20)",
    ),
  );
  const sourceFiles = new Map();
  async function loadSources() {
    const tree = await api(`${base}/files`);
    if (!current()) return;
    const paths = [];
    const walk = (items) => {
      for (const f of items) {
        if (f.children) walk(f.children);
        else if (f.path.endsWith(".py")) paths.push(f.path);
      }
    };
    walk(tree);
    paths.sort((a, b) =>
      a === task.testSuite.entry.path
        ? -1
        : b === task.testSuite.entry.path
          ? 1
          : a.localeCompare(b),
    );
    const selected = new Map(
      [...sourceFiles].map(([p, input]) => [p, input.checked]),
    );
    for (const label of sources.querySelectorAll("label")) label.remove();
    sourceFiles.clear();
    for (const [index, p] of paths.entries()) {
      const label = node("label"),
        input = node("input");
      input.type = "checkbox";
      input.checked = selected.get(p) ?? index < 20;
      input.disabled = p === task.testSuite.entry.path;
      label.append(input, document.createTextNode(p));
      sources.append(label);
      sourceFiles.set(p, input);
    }
  }
  examples.append(node("summary", "", "Sichtbare Testfälle und Erwartungen"));
  for (const c of task.testSuite.cases)
    examples.append(
      node(
        "pre",
        "",
        `${c.name}${c.required ? " (erforderlich)" : " (optional)"}\nArgumente: ${JSON.stringify(c.args)}\nErwartet: ${JSON.stringify(c.expected)}`,
      ),
    );
  panel.append(examples, sources);
  container.append(panel);
  const sourceReady = loadSources();
  function show() {
    if (!current() || !run) return;
    start.disabled = active();
    cancel.hidden = !active();
    complete.disabled =
      task.done || active() || !run.current || run.assessment !== "passed";
    discuss.disabled = false;
    const assessments = {
      passed: "Erforderliche Tests bestanden",
      failed: "Tests fehlgeschlagen",
      inconclusive: "Lauf nicht vollständig auswertbar",
    };
    const option = [...history.options].find((o) => o.value === run.testRunId);
    if (option)
      option.textContent = `${new Date(run.startedAt).toLocaleString("de-DE")} · ${assessments[run.assessment] || run.status}`;
    status.textContent = `${run.status === "expired" ? "Testartefakt abgelaufen. Bitte erneut pr\u00fcfen." : active() ? "Tests laufen …" : assessments[run.assessment] || (run.status === "cancelled" ? "Tests abgebrochen" : "Lauf unterbrochen")}${run.summary ? ` · ${run.summary.passed}/${run.summary.total} bestanden` : ""} · ${new Date(run.startedAt).toLocaleString("de-DE")}${run.current === false ? " · Älterer Stand: vor Abschluss erneut prüfen." : ""}${run.reason ? ` · ${run.reason}` : ""}`;
    const signature = JSON.stringify([run.testRunId, run.cases]);
    if (caseSignature === signature) return;
    caseSignature = signature;
    cases.replaceChildren();
    for (const c of run.cases || []) {
      const detail = node("details");
      detail.open = !c.passed;
      detail.append(
        node(
          "summary",
          "",
          `${c.passed ? "Bestanden" : c.kind === "not_run" ? "Nicht ausgeführt" : "Fehlgeschlagen"}: ${c.name}`,
        ),
      );
      detail.append(
        node(
          "pre",
          "",
          `Argumente: ${JSON.stringify(c.args)}\nErwartet (${valueType(c.expected)}): ${JSON.stringify(c.expected)}${Object.hasOwn(c, "actual") ? `\nErhalten (${valueType(c.actual)}): ${JSON.stringify(c.actual)}` : ""}${c.message ? `\n${c.message}` : ""}${c.output ? `\nProgrammausgabe${c.outputTruncated ? " (gekürzt)" : ""}:\n${c.output}` : ""}`,
        ),
      );
      if (!c.passed)
        detail.append(
          errorCard({
            ...c,
            sessionId,
            runId: run.testRunId,
            historical: true,
          }),
        );
      cases.append(detail);
    }
  }
  async function refresh() {
    if (!current() || !run) return;
    const id = run.testRunId,
      token = ++reading;
    try {
      const result = await api(`${base}/test-runs/${id}`);
      if (!current() || token !== reading || run.testRunId !== id) return;
      run = result;
      show();
    } catch (e) {
      if (current())
        status.textContent = `${e.message} Gespeicherten Lauf erneut lesen.`;
    }
    if (current()) timer = setTimeout(refresh, active() ? 400 : 2000);
  }
  async function loadHistory() {
    const rows = await api(`${base}/tasks/${task.id}/test-runs`);
    if (!current()) return;
    history.replaceChildren();
    for (const r of rows) {
      const option = node(
        "option",
        "",
        `${new Date(r.startedAt).toLocaleString("de-DE")} · ${r.assessment || r.status}`,
      );
      option.value = r.testRunId;
      history.append(option);
    }
    history.disabled = !rows.length;
    if (!run && rows.length)
      run = { testRunId: task.lastTestRunId || rows[0].testRunId };
    if (run) history.value = run.testRunId;
  }
  history.onchange = () => {
    clearTimeout(timer);
    run = { testRunId: history.value };
    refresh();
  };
  start.onclick = async () => {
    start.disabled = true;
    try {
      await flush();
      if (!current()) return;
      // Retain a failed HTTP request for a safe retry with the same operation ID.
      if (!requestBody) {
        await sourceReady;
        await loadSources();
        const paths = [...sourceFiles]
          .filter(([, input]) => input.checked)
          .map(([p]) => p);
        const expectedVersions = {};
        for (const p of paths)
          expectedVersions[p] = (
            await api(`${base}/files/content?path=${encodeURIComponent(p)}`)
          ).version;
        requestBody = {
          operationId: randomUUID(),
          taskVersion: task.taskVersion || 1,
          expectedVersions,
        };
      }
      const result = await api(`${base}/tasks/${task.id}/test-runs`, {
        method: "POST",
        body: requestBody,
      });
      requestBody = null;
      if (!current()) return;
      clearTimeout(timer);
      run = result;
      await loadHistory();
      await refresh();
    } catch (e) {
      if (e.status && e.status < 500) requestBody = null;
      if (current()) {
        status.textContent = e.message;
        if (e.code === "RUNTIME_MISSING") {
          const manage = node("button", "", "Laufzeitverwaltung öffnen");
          manage.onclick = () =>
            openPrograms().catch((error) => toast(error.message, "error"));
          status.append(manage);
        } else if (e.message.includes("Prozess") || e.code === "RUNNER_BUSY") {
          const running = node(
            "button",
            "",
            "Laufenden Auftrag im Terminal anzeigen",
          );
          running.onclick = () => showTerminal();
          status.append(running);
        }
        toast(e.message, "error");
      }
    } finally {
      if (current()) start.disabled = active();
    }
  };
  cancel.onclick = async () => {
    try {
      await api(`${base}/test-runs/${run.testRunId}/cancel`, {
        method: "POST",
        body: {},
      });
      clearTimeout(timer);
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  complete.onclick = async () => {
    complete.disabled = true;
    try {
      await flush();
      const result = await api(`${base}/tasks/${task.id}/complete`, {
        method: "POST",
        body: {
          taskVersion: task.taskVersion || 1,
          testRunId: run.testRunId,
          assistance: assistance.value,
        },
      });
      if (!current()) return;
      state.session = result;
      onComplete();
    } catch (e) {
      toast(e.message, "error");
      clearTimeout(timer);
      await refresh();
    }
  };
  discuss.onclick = () => {
    const input = document.getElementById("chat-input");
    input.value = `Bitte erkläre Testlauf ${run.testRunId} (${run.summary?.passed || 0}/${run.summary?.total || 0} bestanden). Lies read_task_test_results; starte keinen neuen Lauf.`;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  };
  loadHistory()
    .then(refresh)
    .catch((e) => {
      if (current()) status.textContent = e.message;
    });
  sourceReady.catch((e) => {
    if (current()) status.textContent = e.message;
  });
}
