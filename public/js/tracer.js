import {
  t,
  getLocale,
  getFormatLocale,
  formatNumber,
  translateMessage,
} from "./i18n.js";
import { api, workspaceURL } from "./api.js";
import { state, on, emit } from "./state.js";
import { flush, currentFile } from "./editor.js";
import { node, toast } from "./ui.js";
import { randomUUID } from "./uuid.js";

const observedTraceSessions = new Set();
export async function tracesWorkActive() {
  for (const id of observedTraceSessions) {
    let rows;
    try {
      rows = await api(`${workspaceURL(id)}/traces`);
    } catch (error) {
      if (error.status === 404) {
        observedTraceSessions.delete(id);
        continue;
      }
      throw error;
    }
    if (rows.some((run) => ["starting", "running"].includes(run.status)))
      return true;
  }
  return false;
}
// Marker metadata originates in the tracer encoder, never by matching user text.
function traceValue(value) {
  if (Array.isArray(value)) return value.map(traceValue);
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !["valueMessage", "displayValue", "displayMessage"].includes(key),
      )
      .map(([key, item]) => [key, traceValue(item)]),
  );
  if (value.valueMessage)
    result.value = translateMessage(value.valueMessage, value.value);
  return result;
}
const traceEventLabel = (event) =>
  ({
    call: t("features:tracer.call"),
    return: t("features:tracer.returnValue"),
    exception: t("features:tracer.exceptionEvent"),
    line: t("features:tracer.nextLine"),
  })[event] || event;

export function initTracer() {
  const dialog = node("dialog", "trace-dialog");
  dialog.setAttribute("aria-labelledby", "trace-title");
  const title = node("h2", "", t("features:tracer.title"));
  title.id = "trace-title";
  const close = node("button", "", t("features:shared.close"));
  close.type = "button";
  const status = node("p");
  status.setAttribute("role", "status");
  const help = node("p", "", t("features:tracer.help"));
  const limitations = node("details");
  limitations.append(
    node("summary", "", t("features:tracer.whatRecorded")),
    node("p", "", t("features:tracer.limitations")),
  );
  const setup = node("fieldset");
  setup.append(node("legend", "", t("features:tracer.record")));
  const entryLabel = node("p");
  const advanced = node("details");
  advanced.append(node("summary", "", t("features:tracer.additional")));
  const files = node("div", "trace-files");
  const stdinLabel = node("label", "", t("features:tracer.stdin"));
  const stdin = node("textarea");
  stdin.rows = 2;
  stdin.maxLength = 65536;
  stdinLabel.append(stdin);
  const start = node("button", "", t("features:tracer.record"));
  start.type = "button";
  advanced.append(files, stdinLabel);
  setup.append(entryLabel, advanced, start);
  const historyLabel = node("label", "", t("features:tracer.history"));
  const history = node("select");
  historyLabel.append(history);
  const stop = node("button", "", t("features:tracer.stop"));
  const discuss = node("button", "", t("features:tracer.discuss"));
  discuss.type = "button";
  stop.type = "button";
  stop.disabled = true;
  const controls = node("div", "trace-controls");
  const previous = node("button", "", t("features:tracer.previous")),
    play = node("button", "", t("features:tracer.play")),
    next = node("button", "", t("features:tracer.next")),
    errorButton = node("button", "", t("features:tracer.toError"));
  const timeline = node("input");
  timeline.type = "range";
  timeline.min = "1";
  timeline.max = "1";
  timeline.value = "1";
  timeline.setAttribute("aria-label", t("features:tracer.step"));
  controls.append(previous, play, next, errorButton, timeline);
  const caption = node("p", "trace-caption");
  caption.setAttribute("aria-live", "polite");
  const prediction = node("fieldset");
  prediction.append(node("legend", "", t("features:tracer.prediction")));
  const variable = node("input");
  variable.placeholder = t("features:tracer.variableName");
  variable.setAttribute("aria-label", t("features:tracer.predictVariable"));
  const guess = node("input");
  guess.placeholder = t("features:tracer.expectedJSON");
  guess.setAttribute("aria-label", t("features:tracer.expected"));
  const result = node("p");
  prediction.append(variable, guess, result);
  const columns = node("div", "trace-columns");
  const playback = node("section");
  playback.hidden = true;
  const output = node("pre", "trace-output");
  output.setAttribute("aria-label", t("features:shared.output"));
  const source = node("div", "trace-source");
  source.setAttribute("aria-label", t("features:tracer.source"));
  const data = node("div", "trace-data");
  columns.append(source, data);
  playback.append(controls, caption, prediction, columns);
  const programOutput = node("section");
  programOutput.hidden = true;
  programOutput.append(node("h3", "", t("features:shared.output")), output);
  dialog.append(
    title,
    close,
    help,
    limitations,
    setup,
    historyLabel,
    discuss,
    stop,
    status,
    playback,
    programOutput,
  );
  document.body.append(dialog);
  let session,
    base,
    run,
    events = [],
    index = 0,
    pollTimer,
    playTimer,
    viewer,
    model,
    decorations = [],
    generation = 0,
    intent;
  const reasons = {
    completed: t("features:tracer.completed"),
    program_error: t("features:tracer.programError"),
    event_limit: t("features:tracer.eventLimit"),
    trace_size_limit: t("features:tracer.sizeLimit"),
    timeout: t("features:shared.timeout"),
    stopped: t("features:tracer.stopped"),
    incomplete_trace: t("features:tracer.incomplete"),
    invalid_trace: t("features:tracer.invalid"),
    process_unavailable: t("features:tracer.unavailable"),
    runner_restarted: t("features:tracer.runnerRestart"),
  };
  const active = () => run && ["starting", "running"].includes(run.status);
  function pause() {
    clearInterval(playTimer);
    playTimer = null;
    play.textContent = t("features:tracer.play");
  }
  function dispose() {
    clearTimeout(pollTimer);
    pause();
    viewer?.dispose();
    model?.dispose();
    viewer = model = null;
    generation++;
  }
  close.onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    dispose();
    document
      .getElementById(
        document.getElementById("trace-tools").hidden
          ? "sidebar-toggle"
          : "trace-open",
      )
      .focus();
  });
  function updateAccess() {
    const tools = document.getElementById("trace-tools");
    const hidden = !state.session || !currentFile()?.endsWith(".py");
    if (tools.hidden !== hidden) {
      tools.hidden = hidden;
      emit("layout");
    }
  }
  on("session-opened", () => {
    updateAccess();
    if (dialog.open) dialog.close();
  });
  on("file-active", updateAccess);
  updateAccess();
  function show() {
    const event = events[index];
    stop.hidden = !run;
    discuss.hidden = !run;
    playback.hidden = !event;
    programOutput.hidden = !output.textContent;
    previous.disabled = !event || index === 0;
    next.disabled = !event || index >= events.length - 1;
    play.disabled = !event;
    errorButton.disabled = !events.some((e) => e.event === "exception");
    timeline.disabled = !event;
    timeline.max = String(Math.max(1, events.length));
    timeline.value = String(index + 1);
    if (!event) {
      caption.textContent = t("features:tracer.noEvents");
      data.replaceChildren();
      return;
    }
    caption.textContent = t("features:tracer.stepCaption", {
      p1: formatNumber(event.step),
      p2: formatNumber(events.length),
      p3: traceEventLabel(event.event),
      p4: event.file,
      p5: formatNumber(event.line),
      p6:
        event.event === "exception" ? t("features:tracer.exceptionCaught") : "",
    });
    const file = run.snapshot.files.find((f) => f.path === event.file);
    if (file && viewer) {
      if (model?.getValue() !== file.content) {
        viewer.setModel(null);
        model?.dispose();
        model = monaco.editor.createModel(file.content, "python");
        viewer.setModel(model);
        decorations = [];
      }
      decorations = viewer.deltaDecorations(
        decorations,
        event.line > 0
          ? [
              {
                range: new monaco.Range(event.line, 1, event.line, 1),
                options: {
                  isWholeLine: true,
                  className: "trace-line",
                  linesDecorationsClassName: "trace-line-marker",
                },
              },
            ]
          : [],
      );
      viewer.revealLineInCenter(Math.max(1, event.line));
    }
    data.replaceChildren(node("h3", "", t("features:tracer.stack")));
    const stack = node("ol");
    for (const frame of event.stack || [])
      stack.append(
        node(
          "li",
          "",
          `${frame.function} · ${frame.frameId} · ${frame.file}:${frame.line}`,
        ),
      );
    data.append(stack);
    if (event.stackTruncated)
      data.append(node("p", "", t("features:tracer.stackTruncated")));
    for (const frame of event.stack || []) {
      data.append(node("h3", "", `${frame.function} · ${frame.frameId}`));
      const table = node("table");
      const head = node("tr");
      for (const s of [
        t("features:tracer.variable"),
        t("features:tracer.value"),
        t("features:tracer.change"),
      ])
        head.append(node("th", "", s));
      table.append(head);
      const before =
        events[index - 1]?.stack?.find((f) => f.frameId === frame.frameId)
          ?.locals || {};
      for (const name of new Set([
        ...Object.keys(frame.locals),
        ...Object.keys(before),
      ])) {
        const value = frame.locals[name];
        const change =
          value === undefined
            ? t("features:tracer.removed")
            : !(name in before)
              ? t("features:tracer.new")
              : JSON.stringify(value) !== JSON.stringify(before[name]) ||
                  (value?.ref &&
                    JSON.stringify(event.objects?.[value.ref]) !==
                      JSON.stringify(events[index - 1]?.objects?.[value.ref]))
                ? t("features:tracer.changed")
                : "";
        const row = node("tr");
        row.append(
          node("td", "", name),
          node(
            "td",
            "",
            value === undefined ? "—" : JSON.stringify(traceValue(value)),
          ),
          node("td", "", change),
        );
        table.append(row);
      }
      data.append(table);
      if (frame.truncated)
        data.append(node("p", "", t("features:tracer.variablesTruncated")));
    }
    data.append(
      node("h3", "", t("features:tracer.sharedObjects")),
      node("pre", "", JSON.stringify(traceValue(event.objects), null, 2)),
    );
    if (event.returnValue)
      data.append(
        node("h3", "", t("features:tracer.returnValue")),
        node("pre", "", JSON.stringify(traceValue(event.returnValue))),
      );
    if (event.exception)
      data.append(
        node(
          "p",
          "",
          t("features:tracer.exception", { p1: event.exception.type }) +
            " · " +
            translateMessage(event.exception, event.exception.message || ""),
        ),
      );
  }
  function step(to, evaluate = false) {
    if (evaluate && variable.value && guess.value && events[to]) {
      const actual = events[to].locals?.[variable.value];
      let expected;
      try {
        expected = JSON.parse(guess.value);
      } catch {
        expected = guess.value;
      }
      result.textContent = actual
        ? t("features:tracer.predictionResult", {
            p1:
              JSON.stringify(actual.value) === JSON.stringify(expected)
                ? t("features:tracer.correct")
                : t("features:tracer.compare"),
            p2: variable.value,
            p3: JSON.stringify(actual),
            p4:
              events[to].event === "line"
                ? t("features:tracer.beforeLine")
                : t("features:tracer.atEvent"),
          })
        : t("features:tracer.variableMissing");
    }
    index = Math.max(0, Math.min(events.length - 1, to));
    show();
  }
  previous.onclick = () => {
    pause();
    step(index - 1);
  };
  next.onclick = () => {
    pause();
    step(index + 1, true);
  };
  timeline.oninput = () => {
    pause();
    step(Number(timeline.value) - 1);
  };
  errorButton.onclick = () => {
    pause();
    const errors = events
      .map((e, i) => (e.event === "exception" ? i : -1))
      .filter((i) => i >= 0);
    step(errors.find((i) => i > index) ?? errors[0]);
  };
  play.onclick = () => {
    if (playTimer) return pause();
    play.textContent = t("features:tracer.pause");
    playTimer = setInterval(() => {
      if (index >= events.length - 1) return pause();
      step(index + 1);
    }, 650);
  };
  async function refresh(token = generation) {
    if (!run || token !== generation) return;
    const id = run.traceRunId;
    try {
      const info = await api(`${base}/traces/${id}`);
      if (token !== generation || run.traceRunId !== id) return;
      run = info;
      output.textContent = run.output || "";
      if (run.programError)
        output.textContent += `\n${run.programError.type}: ${translateMessage(run.programError, run.programError.message)}`;
      if (run.error || run.errorKey)
        output.textContent += `\n${translateMessage({ messageKey: run.errorKey, params: run.errorParams }, run.error)}`;
      while (events.length < run.eventCount) {
        const page = await api(
          `${base}/traces/${id}/events?fromStep=${events.length + 1}&limit=50`,
        );
        if (token !== generation || run.traceRunId !== id) return;
        if (!page.events.length) break;
        events.push(...page.events);
      }
      status.textContent =
        run.status === "expired"
          ? t("features:tracer.expired")
          : t("features:tracer.runDetails", {
              count: events.length,
              p1: active()
                ? t("features:tracer.recording")
                : reasons[run.reason] || run.reason || run.status,
              p2: formatNumber(events.length),
              p3: run.complete ? "" : t("features:tracer.incompleteSuffix"),
              p4: new Date(run.createdAt).toLocaleString(getFormatLocale()),
            });
      stop.disabled = !active();
      show();
    } catch (e) {
      if (token === generation)
        status.textContent = t("features:tracer.reconnecting", {
          p1: e.message,
        });
    }
    if (token === generation && active())
      pollTimer = setTimeout(() => refresh(token), 500);
  }
  async function select(id) {
    clearTimeout(pollTimer);
    pause();
    generation++;
    events = [];
    index = 0;
    run = { traceRunId: id, status: "starting" };
    await refresh();
  }
  history.onchange = () => {
    if (history.value) return select(history.value);
  };
  discuss.onclick = () => {
    if (!run?.traceRunId) return;
    const input = document.getElementById("chat-input");
    input.value = t("features:tracer.discussPrompt", {
      lng: state.session?.tutorLocale || getLocale(),
      p1: run.traceRunId,
    });
    input.dispatchEvent(new Event("input", { bubbles: true }));
    dialog.close();
    input.focus();
  };
  stop.onclick = async () => {
    try {
      await api(`${base}/traces/${run.traceRunId}/cancel`, {
        method: "POST",
        body: {},
      });
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  start.onclick = async () => {
    const token = generation;
    start.disabled = true;
    try {
      await flush();
      const entry = currentFile();
      if (!entry?.endsWith(".py"))
        throw new Error(t("features:tracer.openPython"));
      const expectedVersions = {};
      const selected = [...files.querySelectorAll("input:checked")].map(
        (i) => i.value,
      );
      for (const p of new Set([entry, ...selected]))
        expectedVersions[p] = (
          await api(`${base}/files/content?path=${encodeURIComponent(p)}`)
        ).version;
      const body = { entry, expectedVersions, stdin: stdin.value };
      const key = JSON.stringify(body);
      if (intent?.key !== key) intent = { key, operationId: randomUUID() };
      const created = await api(`${base}/traces`, {
        method: "POST",
        body: { ...body, operationId: intent.operationId },
      });
      intent = null;
      if (token !== generation || session !== state.session?.id || !dialog.open)
        return;
      const option = node(
        "option",
        "",
        `${created.snapshot.entry} · ${new Date(created.createdAt).toLocaleTimeString(getFormatLocale())}`,
      );
      option.value = created.traceRunId;
      historyLabel.hidden = false;
      history.prepend(option);
      history.value = created.traceRunId;
      await select(created.traceRunId);
    } catch (e) {
      if (token === generation) {
        status.textContent = e.message;
        toast(e.message, "error");
      }
    } finally {
      start.disabled = false;
    }
  };
  document.getElementById("trace-open").onclick = async () => {
    if (!state.session) return toast(t("features:shared.openSession"));
    if (!currentFile()?.endsWith(".py")) return;
    session = state.session.id;
    observedTraceSessions.add(session);
    base = workspaceURL(session);
    run = null;
    events = [];
    index = 0;
    intent = null;
    output.textContent = "";
    result.textContent = "";
    entryLabel.textContent = t("features:tracer.file", { p1: currentFile() });
    advanced.open = false;
    limitations.open = false;
    historyLabel.hidden = true;
    show();
    dialog.showModal();
    const token = ++generation;
    status.textContent = t("features:tracer.loading");
    viewer = monaco.editor.create(source, {
      readOnly: true,
      automaticLayout: true,
      theme: "sterra",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    try {
      const [tree, runs] = await Promise.all([
        api(`${base}/files`),
        api(`${base}/traces`),
      ]);
      if (token !== generation) return;
      files.replaceChildren();
      history.replaceChildren(
        node("option", "", t("features:tracer.selectRun")),
      );
      const walk = (items) => {
        for (const item of items) {
          if (item.children) walk(item.children);
          else if (item.path.endsWith(".py")) {
            const label = node("label");
            const check = node("input");
            check.type = "checkbox";
            check.value = item.path;
            check.checked = item.path === currentFile();
            label.append(check, document.createTextNode(item.path));
            files.append(label);
          }
        }
      };
      walk(tree);
      for (const r of runs) {
        const option = node(
          "option",
          "",
          `${r.entry} · ${new Date(r.createdAt).toLocaleString(getFormatLocale())}`,
        );
        option.value = r.traceRunId;
        history.append(option);
      }
      historyLabel.hidden = !runs.length;
      if (runs.length) {
        history.value = runs[0].traceRunId;
        await select(runs[0].traceRunId);
      } else {
        status.textContent = t("features:tracer.ready");
        show();
      }
    } catch (e) {
      status.textContent = e.message;
    }
  };
}
