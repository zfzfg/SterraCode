import { t } from "./i18n.js";
const catalog = () => ({
  IndexError: [
    t("features:errorCatalog.indexTitle"),
    t("features:errorCatalog.indexHelp"),
  ],
  KeyError: [
    t("features:errorCatalog.keyTitle"),
    t("features:errorCatalog.keyHelp"),
  ],
  NameError: [
    t("features:errorCatalog.nameTitle"),
    t("features:errorCatalog.nameHelp"),
  ],
  ReferenceError: [
    t("features:errorCatalog.referenceTitle"),
    t("features:errorCatalog.referenceHelp"),
  ],
  TypeError: [
    t("features:errorCatalog.typeTitle"),
    t("features:errorCatalog.typeHelp"),
  ],
  ValueError: [
    t("features:errorCatalog.valueTitle"),
    t("features:errorCatalog.valueHelp"),
  ],
  ZeroDivisionError: [
    t("features:errorCatalog.divisionTitle"),
    t("features:errorCatalog.divisionHelp"),
  ],
  SyntaxError: [
    t("features:errorCatalog.syntaxTitle"),
    t("features:errorCatalog.syntaxHelp"),
  ],
  IndentationError: [
    t("features:errorCatalog.indentTitle"),
    t("features:errorCatalog.indentHelp"),
  ],
  TabError: [
    t("features:errorCatalog.tabTitle"),
    t("features:errorCatalog.tabHelp"),
  ],
});

export function explainError({ message = "", kind, reason } = {}) {
  if (kind === "serialization_error")
    return {
      category: t("features:errorCatalog.returnCategory"),
      title: t("features:errorCatalog.serializationTitle"),
      explanation: t("features:errorCatalog.serializationHelp"),
    };
  if (kind === "return")
    return {
      category: t("features:errorCatalog.resultCategory"),
      title: t("features:errorCatalog.returnTitle"),
      explanation: t("features:errorCatalog.returnHelp"),
    };
  if (
    [
      "timeout",
      "output_limit",
      "stopped",
      "not_run",
      "invalid_result",
    ].includes(kind) ||
    reason
  )
    return {
      category: t("features:errorCatalog.execution"),
      title:
        kind === "timeout" || reason === "timeout"
          ? t("features:shared.timeout")
          : t("features:shared.inconclusive"),
      explanation: t("features:errorCatalog.executionHelp"),
    };
  const match = String(message).match(
    /(?:^|\n)(?:Uncaught\s+)?(IndexError|KeyError|NameError|ReferenceError|TypeError|ValueError|ZeroDivisionError|SyntaxError|IndentationError|TabError):/,
  );
  if (!match)
    return {
      category: t("features:errorCatalog.unknown"),
      title: t("features:errorCatalog.originalTitle"),
      explanation: t("features:errorCatalog.originalHelp"),
    };
  const type = match[1];
  return {
    category: ["SyntaxError", "IndentationError", "TabError"].includes(type)
      ? t("features:errorCatalog.syntaxCategory")
      : t("features:errorCatalog.runtimeCategory"),
    title: catalog()[type][0],
    explanation: catalog()[type][1],
  };
}

// Only navigate to a file confirmed by the current workspace listing. Absolute
// library frames must include this workspace's UUID, never just a basename.
export function errorLocation(output, paths, sessionId) {
  const text = String(output)
    .slice(-65536)
    .replace(/\u001b\[[0-9;]*m/g, "");
  const frames = [
    ...text.matchAll(
      /File "([^"]+)", line (\d+)|(?:file:\/\/\/)?([^\s()]+\.(?:[cm]?js|html)):(\d+)(?::\d+)?/g,
    ),
  ];
  const matches = frames
    .map((m) => {
      let source = (m[1] || m[3]).replace(/\\/g, "/");
      try {
        source = decodeURIComponent(source);
      } catch {
        return null;
      }
      const file = paths.find(
        (p) =>
          source === p ||
          source === `./${p}` ||
          source.endsWith(`/${sessionId}/${p}`),
      );
      const line = Number(m[2] || m[4]);
      return file && Number.isSafeInteger(line) && line > 0 && line <= 1000000
        ? { file, line }
        : null;
    })
    .filter(Boolean);
  return matches.at(-1) || null;
}
