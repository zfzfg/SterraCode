import {
  t,
  getLocale,
  getFormatLocale,
  formatNumber,
  translateMessage,
} from "./i18n.js";
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
const observedTasks = new Set();
export async function testsWorkActive() {
  for (const path of observedTasks) {
    let rows;
    try {
      rows = await api(`${path}/test-runs`);
    } catch (error) {
      if (error.status === 404) {
        observedTasks.delete(path);
        continue;
      }
      throw error;
    }
    if (rows.some((run) => ["starting", "running"].includes(run.status)))
      return true;
  }
  return false;
}

export function renderTaskTests(container, task, onComplete) {
  const sessionId = state.session.id;
  const base = workspaceURL(sessionId);
  observedTasks.add(`${base}/tasks/${encodeURIComponent(task.id)}`);
  const panel = node("section", "task-tests");
  panel.setAttribute("aria-label", t("features:taskTests.check"));
  const status = node("p");
  status.setAttribute("role", "status");
  const cases = node("div");
  const controls = node("div", "task-test-controls");
  const assistanceLabel = node("label", "", t("features:taskTests.assistance"));
  const assistance = node("select");
  assistance.className = "task-assistance";
  for (const [value, label] of [
    ["not_recorded", t("features:taskTests.notRecorded")],
    ["independent", t("features:taskTests.independent")],
    ["assisted", t("features:taskTests.assisted")],
  ]) {
    const option = node("option", "", label);
    option.value = value;
    assistance.append(option);
  }
  assistanceLabel.append(assistance);
  const start = node("button", "", t("features:taskTests.check"));
  const cancel = node("button", "", t("features:taskTests.cancel"));
  const complete = node(
    "button",
    "",
    task.done
      ? t("features:shared.taskDone")
      : t("features:taskTests.complete"),
  );
  const discuss = node("button", "", t("features:taskTests.discuss"));
  const historyLabel = node("label", "", t("features:taskTests.history"));
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
      t("features:taskTests.contract", {
        p1: task.testSuite.entry.path,
        p2: task.testSuite.entry.function,
      }),
    ),
    controls,
    assistanceLabel,
    historyLabel,
    status,
    cases,
  );
  const examples = node("details");
  const sources = node("details");
  sources.append(node("summary", "", t("features:taskTests.sources")));
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
  examples.append(node("summary", "", t("features:taskTests.examples")));
  for (const c of task.testSuite.cases)
    examples.append(
      node(
        "pre",
        "",
        t("features:taskTests.caseExample", {
          p1: c.name,
          p2: c.required
            ? t("features:taskTests.required")
            : t("features:taskTests.optional"),
          p3: JSON.stringify(c.args),
          p4: JSON.stringify(c.expected),
        }),
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
      passed: t("features:taskTests.passedRequired"),
      failed: t("features:taskTests.failed"),
      inconclusive: t("features:shared.inconclusive"),
    };
    const option = [...history.options].find((o) => o.value === run.testRunId);
    if (option)
      option.textContent = `${new Date(run.startedAt).toLocaleString(getFormatLocale())} · ${assessments[run.assessment] || run.status}`;
    status.textContent = `${run.status === "expired" ? t("features:taskTests.expired") : active() ? t("features:taskTests.running") : assessments[run.assessment] || (run.status === "cancelled" ? t("features:taskTests.cancelled") : t("features:taskTests.interrupted"))}${run.summary ? t("features:taskTests.summary", { count: run.summary.passed, p1: formatNumber(run.summary.passed), p2: formatNumber(run.summary.total) }) : ""} · ${new Date(run.startedAt).toLocaleString(getFormatLocale())}${run.current === false ? t("features:taskTests.older") : ""}${run.reason ? ` · ${translateMessage({ messageKey: run.reasonKey, params: run.reasonParams }, run.reason)}` : ""}${run.error || run.errorKey ? ` · ${translateMessage({ messageKey: run.errorKey, params: run.errorParams }, run.error)}` : ""}`;
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
          `${c.passed ? t("features:taskTests.passed") : c.kind === "not_run" ? t("features:taskTests.notRun") : t("features:shared.failed")}: ${c.name}`,
        ),
      );
      detail.append(
        node(
          "pre",
          "",
          t("features:taskTests.caseDetails", {
            p1: JSON.stringify(c.args),
            p2: valueType(c.expected),
            p3: JSON.stringify(c.expected),
            p4: Object.hasOwn(c, "actual")
              ? t("features:taskTests.actual", {
                  p1: valueType(c.actual),
                  p2: JSON.stringify(c.actual),
                })
              : "",
            p5:
              c.message || c.messageKey
                ? `\n${translateMessage(c, c.message)}`
                : "",
            p6: c.output
              ? t("features:taskTests.programOutput", {
                  p1: c.outputTruncated
                    ? t("features:taskTests.truncated")
                    : "",
                  p2: c.output,
                })
              : "",
          }),
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
        status.textContent = t("features:taskTests.reread", { p1: e.message });
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
        `${new Date(r.startedAt).toLocaleString(getFormatLocale())} · ${r.assessment || r.status}`,
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
          const manage = node("button", "", t("features:taskTests.runtimes"));
          manage.onclick = () =>
            openPrograms().catch((error) => toast(error.message, "error"));
          status.append(manage);
        } else if (["PROCESS_RUNNING", "RUNNER_BUSY"].includes(e.code)) {
          const running = node(
            "button",
            "",
            t("features:taskTests.runningTerminal"),
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
    input.value = t("features:taskTests.discussPrompt", {
      lng: state.session?.tutorLocale || getLocale(),
      p1: run.testRunId,
      p2: run.summary?.passed || 0,
      p3: run.summary?.total || 0,
    });
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
