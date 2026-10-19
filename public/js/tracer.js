import { api, workspaceURL } from "./api.js";
import { state, on, emit } from "./state.js";
import { flush, currentFile } from "./editor.js";
import { node, toast } from "./ui.js";
import { randomUUID } from "./uuid.js";

export function initTracer() {
  const dialog = node("dialog", "trace-dialog");
  dialog.setAttribute("aria-labelledby", "trace-title");
  const title = node("h2", "", "Python Schritt für Schritt");
  title.id = "trace-title";
  const close = node("button", "", "Schließen");
  close.type = "button";
  const status = node("p");
  status.setAttribute("role", "status");
  const help = node(
    "p",
    "",
    "Sieh, welche Codezeile als Nächstes ausgeführt wird und wie sich Variablen verändern. Dafür wird deine Python-Datei einmal ausgeführt und der Lauf aufgezeichnet. Danach kannst du ihn in deinem Tempo durchgehen – auch rückwärts.",
  );
  const limitations = node("details");
  limitations.append(
    node("summary", "", "Was wird aufgezeichnet?"),
    node(
      "p",
      "",
      "Die Ansicht zeigt den aufgezeichneten Python-Hauptthread. Rückwärts zeigt frühere Zustände, macht aber keine Dateiänderungen rückgängig. Native Bibliotheken, Threads und asynchrone Abläufe werden nicht vollständig beobachtet.",
    ),
  );
  const setup = node("fieldset");
  setup.append(node("legend", "", "Python-Datei aufzeichnen"));
  const entryLabel = node("p");
  const advanced = node("details");
  advanced.append(node("summary", "", "Zusätzliche Dateien und Eingaben"));
  const files = node("div", "trace-files");
  const stdinLabel = node(
    "label",
    "",
    "Programmeingabe (falls dein Code input() verwendet)",
  );
  const stdin = node("textarea");
  stdin.rows = 2;
  stdin.maxLength = 65536;
  stdinLabel.append(stdin);
  const start = node("button", "", "Python-Datei aufzeichnen");
  start.type = "button";
  advanced.append(files, stdinLabel);
  setup.append(entryLabel, advanced, start);
  const historyLabel = node("label", "", "Gespeicherte Läufe");
  const history = node("select");
  historyLabel.append(history);
  const stop = node("button", "", "Lauf stoppen");
  const discuss = node("button", "", "Trace im Chat vorbereiten");
  discuss.type = "button";
  stop.type = "button";
  stop.disabled = true;
  const controls = node("div", "trace-controls");
  const previous = node("button", "", "Schritt zurück"),
    play = node("button", "", "Wiedergabe"),
    next = node("button", "", "Schritt vor"),
    errorButton = node("button", "", "Zum Fehler");
  const timeline = node("input");
  timeline.type = "range";
  timeline.min = "1";
  timeline.max = "1";
  timeline.value = "1";
  timeline.setAttribute("aria-label", "Trace-Schritt");
  controls.append(previous, play, next, errorButton, timeline);
  const caption = node("p", "trace-caption");
  caption.setAttribute("aria-live", "polite");
  const prediction = node("fieldset");
  prediction.append(
    node("legend", "", "Freiwillige Vorhersage für den nächsten Schritt"),
  );
  const variable = node("input");
  variable.placeholder = "Variablenname";
  variable.setAttribute("aria-label", "Variable vorhersagen");
  const guess = node("input");
  guess.placeholder = "Erwarteter Wert (JSON)";
  guess.setAttribute("aria-label", "Erwarteter Wert");
  const result = node("p");
  prediction.append(variable, guess, result);
  const columns = node("div", "trace-columns");
  const playback = node("section");
  playback.hidden = true;
  const output = node("pre", "trace-output");
  output.setAttribute("aria-label", "Programmausgabe");
  const source = node("div", "trace-source");
  source.setAttribute("aria-label", "Unveränderlicher Quellstand");
  const data = node("div", "trace-data");
  columns.append(source, data);
  playback.append(controls, caption, prediction, columns);
  const programOutput = node("section");
  programOutput.hidden = true;
  programOutput.append(node("h3", "", "Programmausgabe"), output);
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
    completed: "Vollständig beendet",
    program_error: "Unbehandelter Programmfehler",
    event_limit: "Ereignislimit erreicht",
    trace_size_limit: "Datengrenze erreicht",
    timeout: "Zeitlimit erreicht",
    stopped: "Gestoppt",
    incomplete_trace: "Aufzeichnung unvollständig",
    invalid_trace: "Ungültige oder teilweise geschriebene Aufzeichnung",
    process_unavailable: "Prozess nach Neustart nicht verfügbar",
    runner_restarted: "Runner neu gestartet",
  };
  const active = () => run && ["starting", "running"].includes(run.status);
  function pause() {
    clearInterval(playTimer);
    playTimer = null;
    play.textContent = "Wiedergabe";
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
      caption.textContent = "Noch keine Ereignisse aufgezeichnet.";
      data.replaceChildren();
      return;
    }
    caption.textContent = `Schritt ${event.step}/${events.length} · ${event.event === "line" ? "Als Nächstes" : event.event} · ${event.file}: Zeile ${event.line}${event.event === "exception" ? " · Ausnahme aufgetreten; sie kann abgefangen werden." : ""}`;
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
    data.replaceChildren(node("h3", "", "Aufrufstack"));
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
      data.append(node("p", "", "Stack gekürzt (maximal 30 Frames)."));
    for (const frame of event.stack || []) {
      data.append(node("h3", "", `${frame.function} · ${frame.frameId}`));
      const table = node("table");
      const head = node("tr");
      for (const s of ["Variable", "Wert", "Änderung"])
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
            ? "entfernt"
            : !(name in before)
              ? "neu"
              : JSON.stringify(value) !== JSON.stringify(before[name]) ||
                  (value?.ref &&
                    JSON.stringify(event.objects?.[value.ref]) !==
                      JSON.stringify(events[index - 1]?.objects?.[value.ref]))
                ? "geändert"
                : "";
        const row = node("tr");
        row.append(
          node("td", "", name),
          node("td", "", value === undefined ? "—" : JSON.stringify(value)),
          node("td", "", change),
        );
        table.append(row);
      }
      data.append(table);
      if (frame.truncated)
        data.append(node("p", "", "Variablenansicht gekürzt."));
    }
    data.append(
      node(
        "h3",
        "",
        "Gemeinsame Objekte (gleiche Objekt-ID = gleiche Referenz)",
      ),
      node("pre", "", JSON.stringify(event.objects, null, 2)),
    );
    if (event.returnValue)
      data.append(
        node("h3", "", "Rückgabewert"),
        node("pre", "", JSON.stringify(event.returnValue)),
      );
    if (event.exception)
      data.append(node("p", "", `Ausnahme: ${event.exception.type}`));
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
        ? `${JSON.stringify(actual.value) === JSON.stringify(expected) ? "Richtig" : "Vergleiche"}: ${variable.value} = ${JSON.stringify(actual)}. Das ist der gespeicherte Zustand ${events[to].event === "line" ? "vor dieser Zeile" : "an diesem Ereignis"}.`
        : "Diese Variable ist im nächsten aktuellen Frame nicht sichtbar.";
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
    play.textContent = "Pause";
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
        output.textContent += `\n${run.programError.type}: ${run.programError.message}`;
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
          ? "Trace-Artefakt abgelaufen. Der Vorgangsbeleg und das Dateimanifest bleiben erhalten; dieser Lauf wird nicht erneut ausgeführt."
          : `${active() ? "Aufzeichnung läuft" : reasons[run.reason] || run.reason || run.status} · ${events.length} Schritte${run.complete ? "" : " · unvollständig"}. Original-Snapshot vom ${new Date(run.createdAt).toLocaleString("de-DE")}; der aktuelle Editor kann abweichen. Maximal 1.000 Ereignisse / 2 MiB / 10 Sekunden.`;
      stop.disabled = !active();
      show();
    } catch (e) {
      if (token === generation)
        status.textContent = `Verbindung unterbrochen: ${e.message} Gespeicherter Lauf wird erneut gelesen.`;
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
    input.value = `Bitte erkläre mir den gespeicherten Python-Trace ${run.traceRunId}. Lies zuerst die Zusammenfassung mit inspect_execution_trace und anschließend bei Bedarf wenige Ereignisse. Der Trace gehört zum ursprünglichen Snapshot.`;
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
        throw new Error("Bitte eine Python-Einstiegsdatei im Editor öffnen.");
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
        `${created.snapshot.entry} · ${new Date(created.createdAt).toLocaleTimeString("de-DE")}`,
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
    if (!state.session) return toast("Bitte zuerst eine Session öffnen.");
    if (!currentFile()?.endsWith(".py")) return;
    session = state.session.id;
    base = workspaceURL(session);
    run = null;
    events = [];
    index = 0;
    intent = null;
    output.textContent = "";
    result.textContent = "";
    entryLabel.textContent = `Datei: ${currentFile()}`;
    advanced.open = false;
    limitations.open = false;
    historyLabel.hidden = true;
    show();
    dialog.showModal();
    const token = ++generation;
    status.textContent = "Quelldateien und gespeicherte Läufe laden …";
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
      history.replaceChildren(node("option", "", "Lauf auswählen"));
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
          `${r.entry} · ${new Date(r.createdAt).toLocaleString("de-DE")}`,
        );
        option.value = r.traceRunId;
        history.append(option);
      }
      historyLabel.hidden = !runs.length;
      if (runs.length) {
        history.value = runs[0].traceRunId;
        await select(runs[0].traceRunId);
      } else {
        status.textContent =
          "Bereit. Einstieg ist die aktuelle Python-Datei. Weitere lokale Python-Dateien ausdrücklich auswählen.";
        show();
      }
    } catch (e) {
      status.textContent = e.message;
    }
  };
}
