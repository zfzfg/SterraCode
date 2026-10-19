// This function is serialized into the isolated document; keep it self-contained.
export function previewBridge(config) {
  const sendMessage = parent.postMessage.bind(parent);
  let count = 0,
    bytes = 0,
    windowStart = Date.now(),
    rate = 0,
    suppressed = false;
  function send(level, text, file = "", line = 0) {
    if (Date.now() - windowStart > 1000) {
      windowStart = Date.now();
      rate = 0;
    }
    text = String(text).slice(0, 2000);
    if (++count > 200 || (bytes += text.length * 2) > 262144 || ++rate > 40) {
      if (!suppressed) {
        suppressed = true;
        sendMessage(
          {
            type: "preview-log",
            previewRunId: config.previewRunId,
            renderId: config.renderId,
            level: "warn",
            text: "Weitere Meldungen zusammengefasst",
            file: "",
            line: 0,
          },
          config.origin,
        );
      }
      return;
    }
    sendMessage(
      {
        type: "preview-log",
        previewRunId: config.previewRunId,
        renderId: config.renderId,
        level,
        text,
        file,
        line,
      },
      config.origin,
    );
  }
  function locationOf(stack = "") {
    for (const source of config.sources) {
      const marker = `sterra-preview/${encodeURIComponent(source.file)}:`;
      const tail = String(stack).split(marker)[1];
      if (tail)
        return { file: source.file, line: Number(tail.split(":")[0]) || 0 };
    }
    return { file: "", line: 0 };
  }
  for (const level of ["log", "info", "warn", "error"]) {
    console[level] = (...args) => {
      const where = locationOf(new Error().stack);
      const text = args
        .slice(0, 20)
        .map((value) => {
          try {
            return typeof value === "string" ? value : JSON.stringify(value);
          } catch {
            return "[Nicht darstellbar]";
          }
        })
        .join(" ");
      send(level, text, where.file, where.line);
    };
  }
  addEventListener("error", (event) => {
    const source = config.sources.find((s) => s.url === event.filename);
    const where = source
      ? { file: source.file, line: event.lineno }
      : locationOf(event.error?.stack);
    send(
      "error",
      event.message || "Ressource konnte nicht geladen werden",
      where.file,
      where.line,
    );
  });
  addEventListener("unhandledrejection", (event) => {
    const where = locationOf(event.reason?.stack);
    send(
      "error",
      String(event.reason?.message || event.reason),
      where.file,
      where.line,
    );
  });
  addEventListener("securitypolicyviolation", (event) =>
    send("warn", `Vorschau-Policy blockiert: ${event.violatedDirective}`),
  );
  addEventListener(
    "click",
    (event) => {
      const link = event.target.closest?.("a, area");
      if (link && !link.getAttribute("href")?.startsWith("#")) {
        event.preventDefault();
        send("warn", "Navigation ist in der Vorschau nicht unterstützt.");
      }
    },
    true,
  );
}
