import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseHTML } from "parse5";
import * as cssTree from "css-tree";
import { parsers as yamlParsers } from "prettier/plugins/yaml";
import { position, technicalShape } from "./model.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
function output(ctx, index, channel, description) {
  const literal = ctx.literals[index];
  const sink = {
    id: `S-${ctx.sinks.length + 1}`,
    file: literal.file,
    line: literal.line,
    column: literal.column,
    channel,
    description,
    origins: [literal.id],
    resolution: "static",
  };
  ctx.sinks.push(sink);
  ctx.direct(index, channel, {
    sinkId: sink.id,
    file: literal.file,
    line: literal.line,
    description,
    certainty: "syntactic-output",
  });
}
function add(ctx, input, text, start, end, extra = {}) {
  return ctx.literal({
    file: input.file,
    ...position(input.source, start),
    endLine: position(input.source, end).line,
    start,
    end,
    kind: "string",
    role: "value",
    text,
    ...extra,
  });
}
export function html(ctx, input) {
  const recovery = [];
  const document = parseHTML(input.source, {
    sourceCodeLocationInfo: true,
    onParseError: (error) =>
      recovery.push({ code: error.code, line: error.startLine }),
  });
  const embedded = [];
  const visit = (node, parent) => {
    const loc = node.sourceCodeLocation;
    if (node.nodeName === "#comment" && loc)
      add(ctx, input, node.data, loc.startOffset, loc.endOffset, {
        kind: "html-comment",
        role: "comment",
      });
    if (node.nodeName === "#text" && loc && node.value.trim()) {
      if (["script", "style"].includes(parent?.tagName)) {
        const scriptType = parent.attrs?.find(
          (attr) => attr.name === "type",
        )?.value;
        embedded.push({
          file: `${input.file}::inline-${parent.tagName}-${loc.startLine}${parent.tagName === "style" ? ".css" : scriptType === "application/json" ? ".json" : ".js"}`,
          source: node.value,
          originalFile: input.originalFile || input.file,
          originalLine: input.originalFile ? input.originalLine : loc.startLine,
        });
      } else {
        const index = add(
          ctx,
          input,
          node.value,
          loc.startOffset,
          loc.endOffset,
          { kind: "html-text", owner: parent?.tagName || "" },
        );
        const binding = parent?.attrs?.find(
          (attr) => attr.name === "data-i18n",
        );
        if (binding) {
          ctx.literals[index].disposition = "localized-html-default";
          ctx.keyReferences.push({
            file: input.file,
            line: loc.startLine,
            column: loc.startCol,
            key: binding.value,
            dynamic: false,
            htmlDefault: node.value,
          });
        } else
          output(
            ctx,
            index,
            "html",
            `text in ${parent?.tagName || "document"}`,
          );
      }
    }
    for (const attr of node.attrs || []) {
      const location = loc?.attrs?.[attr.name];
      if (!location) continue;
      const textAttribute =
        ctx.config.textAttributes.includes(attr.name) ||
        (attr.name === "value" &&
          node.tagName === "input" &&
          ["button", "submit", "reset"].includes(
            node.attrs.find((value) => value.name === "type")?.value,
          ));
      const index = add(
        ctx,
        input,
        attr.value,
        location.startOffset,
        location.endOffset,
        {
          kind: "html-attribute",
          role: textAttribute ? "value" : "attribute-token",
          owner: `${node.tagName}.${attr.name}`,
        },
      );
      if (textAttribute) {
        if (node.attrs.some((value) => value.name === `data-i18n-${attr.name}`))
          ctx.literals[index].disposition = "localized-html-default";
        else output(ctx, index, "accessibility", `HTML ${attr.name}`);
      } else ctx.literals[index].disposition = "structural";
      if (attr.name.startsWith("data-i18n") && attr.value)
        ctx.keyReferences.push({
          file: input.file,
          line: location.startLine,
          column: location.startCol,
          key: attr.value,
          dynamic: false,
        });
      if (attr.name === "lang")
        ctx.finding("FIXED_LOCALE", index, {
          channel: "formatting",
          severity: "warning",
          message:
            "Feste Dokumentensprache; beim Erzeugen/Start kontrolliert setzen.",
        });
    }
    for (const child of node.childNodes || []) visit(child, node);
    if (node.content) visit(node.content, node);
  };
  visit(document);
  return {
    embedded,
    recovery: recovery.filter((error) => error.code !== "missing-doctype"),
  };
}
export function css(ctx, input) {
  const ast = cssTree.parse(input.source, {
    positions: true,
    parseCustomProperty: true,
  });
  cssTree.walk(ast, {
    enter(node) {
      if (node.type !== "String") return;
      const property = this.declaration?.property || "";
      const index = add(
        ctx,
        input,
        node.value,
        node.loc.start.offset,
        node.loc.end.offset,
        { kind: "css-string", owner: property },
      );
      if (property === "content")
        output(ctx, index, "ui", "CSS generated content");
      else {
        ctx.literals[index].disposition = "technical-shape-review";
        ctx.literals[index].technicalShape = `css-${property || "token"}`;
      }
    },
  });
  return {};
}
export function json(ctx, input) {
  const tokens = [
    ...input.source.matchAll(
      /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null/gi,
    ),
  ].map((match) => ({
    raw: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const data = JSON.parse(input.source);
  let cursor = 0;
  const value = (parts = []) => {
    const token = tokens[cursor++];
    if (!token) return;
    if (token.raw === "{") {
      const keys = new Set();
      while (tokens[cursor]?.raw !== "}") {
        const key = tokens[cursor++];
        const name = JSON.parse(key.raw);
        const keyIndex = add(ctx, input, name, key.start, key.end, {
          kind: "json-key",
          role: "syntax-key",
          owner: parts.join("."),
        });
        ctx.literals[keyIndex].disposition = "structural";
        if (keys.has(name))
          ctx.finding("DUPLICATE_KEY", keyIndex, {
            severity: "critical",
            channel: "catalog",
            message: "Doppelter JSON-Schlüssel wird beim Laden überschrieben.",
          });
        keys.add(name);
        cursor++;
        value([...parts, name]);
        if (tokens[cursor]?.raw !== ",") break;
        cursor++;
      }
      cursor++;
    } else if (token.raw === "[") {
      let index = 0;
      while (tokens[cursor]?.raw !== "]") {
        value([...parts, String(index++)]);
        if (tokens[cursor]?.raw !== ",") break;
        cursor++;
      }
      cursor++;
    } else if (token.raw.startsWith('"')) {
      const index = add(
        ctx,
        input,
        JSON.parse(token.raw),
        token.start,
        token.end,
        { kind: "json-string", owner: parts.join(".") },
      );
      if (ctx.config.textProperties.includes(parts.at(-1)))
        output(ctx, index, "schema-field", `JSON field ${parts.join(".")}`);
    }
  };
  value();
  return { data };
}
export async function yaml(ctx, input) {
  const ast = await yamlParsers.yaml.parse(input.source);
  const visit = (node, parent, names = []) => {
    if (!node || typeof node !== "object") return;
    let parts = names;
    if (node.type === "mappingItem") {
      const key = node.children?.[0]?.children?.[0]?.value;
      if (typeof key === "string") parts = [...names, key];
    }
    if (typeof node.value === "string" && node.position) {
      const key = parent?.type === "mappingKey";
      const index = add(
        ctx,
        input,
        node.value,
        node.position.start.offset,
        node.position.end.offset,
        {
          kind: "yaml-string",
          role: key ? "syntax-key" : "value",
          owner: parts.join("."),
        },
      );
      if (key) ctx.literals[index].disposition = "structural";
      else if (ctx.config.textProperties.includes(parts.at(-1)))
        output(ctx, index, "schema-field", `YAML ${parts.join(".")}`);
      else if (node.value.includes("${"))
        ctx.finding("CONFIG_INTERPOLATION", index, {
          channel: "operations",
          severity: "info",
          message:
            "Konfigurationsinterpolation kann eine feste Betreiberfehlermeldung enthalten.",
        });
    }
    for (const child of node.children || []) visit(child, node, parts);
  };
  visit(ast);
  return {};
}

// Quote-aware fallback for shell/C/batch/directives. It retains every quoted
// token, including short/lowercase values, and reports its weaker coverage.
export function lexical(ctx, input, mode = "shell") {
  const source = input.source;
  const embedded = [];
  const comments = [];
  const here = [];
  if (mode === "shell")
    for (const match of source.matchAll(
      /<<(-)?\s*(['"]?)([A-Za-z_]\w*)\2[^\n]*\n/g,
    )) {
      const bodyStart = match.index + match[0].length;
      const delimiter = match[3];
      const endPattern = new RegExp(
        `^${match[1] ? "\\t*" : ""}${delimiter}\\r?$`,
        "m",
      );
      const tail = source.slice(bodyStart);
      const end = endPattern.exec(tail);
      if (!end) throw new Error(`Unterminated shell heredoc ${delimiter}`);
      const stop = bodyStart + end.index;
      here.push({ start: bodyStart, end: stop + end[0].length });
      const index = add(
        ctx,
        input,
        source.slice(bodyStart, stop),
        bodyStart,
        stop,
        { kind: "shell-heredoc", role: "generated-source", owner: delimiter },
      );
      output(ctx, index, "operations", "shell heredoc output/content");
    }
  function commandAt(offset) {
    const start =
      Math.max(
        source.lastIndexOf("\n", offset),
        source.lastIndexOf(";", offset),
        source.lastIndexOf("{", offset),
        source.lastIndexOf("|", offset),
        source.lastIndexOf("&", offset),
      ) + 1;
    return source.slice(start, offset).trim();
  }
  function readQuote(start) {
    const quote = source[start];
    let i = start + 1;
    let text = "";
    while (i < source.length) {
      if (source[i] === quote) return { end: i + 1, text };
      if (
        source[i] === "\\" &&
        (quote !== "'" || mode === "c" || source[start - 1] === "$")
      ) {
        const next = source[i + 1] || "";
        const unicode = source
          .slice(i)
          .match(/^\\(?:u([\da-f]{4})|x([\da-f]{2}))/i);
        if (unicode && (mode === "c" || source[start - 1] === "$")) {
          text += String.fromCodePoint(parseInt(unicode[1] || unicode[2], 16));
          i += unicode[0].length;
          continue;
        }
        text +=
          { n: "\n", r: "\r", t: "\t" }[next] &&
          (mode === "c" || source[start - 1] === "$")
            ? { n: "\n", r: "\r", t: "\t" }[next]
            : next;
        i += 2;
        continue;
      }
      if (mode === "shell" && quote === '"' && source.startsWith("$(", i)) {
        const begin = i;
        let depth = 1;
        i += 2;
        while (i < source.length && depth) {
          if (["'", '"', "`"].includes(source[i])) {
            const nested = readQuote(i);
            emit(i, nested);
            i = nested.end;
          } else {
            if (source[i] === "(") depth++;
            if (source[i] === ")") depth--;
            i++;
          }
        }
        text += source.slice(begin, i);
        continue;
      }
      text += source[i++];
    }
    throw new Error(
      `Unterminated ${mode} quote at ${position(source, start).line}`,
    );
  }
  function emit(start, parsed) {
    const context = commandAt(start);
    let staticText = parsed.text;
    if (mode === "shell" && source[start] === '"')
      staticText = staticText.replace(
        /\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][\w:]*/g,
        "",
      );
    if (/\bprintf\b/.test(context))
      staticText = staticText.replace(
        /%(?:[-+ 0#]|\d|\.|\*)*[sdifFeEgGouxXcb%]/g,
        "",
      );
    const index = add(ctx, input, parsed.text, start, parsed.end, {
      kind: `${mode}-string`,
      owner: context.slice(0, 100),
      staticText,
    });
    if (
      /\b(?:echo|printf|read\s+[^\n]*-p|die|fatal|fail|warn|log)\b/i.test(
        context,
      )
    )
      output(ctx, index, "operations", `${mode} output/prompt`);
    if (
      /\b(?:console\.|require\(|import\s+\{|const\s+|let\s+)/.test(
        parsed.text,
      ) &&
      /-e\b|--eval\b/.test(context)
    ) {
      ctx.literals[index].role = "generated-source";
      embedded.push({
        file: `${input.file}::eval-${position(source, start).line}.js`,
        source: parsed.text,
        originalFile: input.file,
        originalLine: position(source, start).line,
      });
    }
  }
  for (let i = 0; i < source.length;) {
    const body = here.find((range) => i >= range.start && i < range.end);
    if (body) {
      i = body.end;
      continue;
    }
    const lineComment =
      mode === "shell"
        ? source[i] === "#" && (i === 0 || /[\s;]/.test(source[i - 1]))
        : source.startsWith("//", i);
    if (lineComment || (mode === "c" && source.startsWith("/*", i))) {
      const end = source.startsWith("/*", i)
        ? source.indexOf("*/", i + 2)
        : source.indexOf("\n", i);
      const stop =
        end < 0 ? source.length : end + (source.startsWith("/*", i) ? 2 : 0);
      comments.push(
        add(ctx, input, source.slice(i, stop), i, stop, {
          kind: `${mode}-comment`,
          role: "comment",
        }),
      );
      i = stop;
    } else if (["'", '"'].includes(source[i])) {
      const parsed = readQuote(i);
      emit(i, parsed);
      i = parsed.end;
    } else i++;
  }
  // Unquoted echo/read labels are strings too; excluding them was a common
  // blind spot of line/quote-only scans. Preserve the complete output operand.
  if (["shell", "batch"].includes(mode))
    for (const match of source.matchAll(
      /(?:^|[;{}|&]\s*|\n)\s*@?(echo|printf)\s+([^\r\n;{}|&]+)/g,
    )) {
      const text = match[2].trim();
      if (!text || /['"]/.test(text) || /^(?:off|on)$/i.test(text)) continue;
      const start = match.index + match[0].indexOf(match[2]);
      const index = add(ctx, input, text, start, start + match[2].length, {
        kind: `${mode}-unquoted-output`,
      });
      output(ctx, index, "operations", `${mode} unquoted ${match[1]}`);
    }
  return {
    embedded,
    coverageNote: `${mode}-lexer; no complete language dataflow or syntax validation`,
  };
}
export function nativeParse(ctx, inputs, language) {
  if (!inputs.length) return [];
  const helper =
    language === "python" ? "extract-python.py" : "extract-powershell.ps1";
  const commands =
    language === "python"
      ? [
          ["python", ["-X", "utf8", path.join(directory, helper)]],
          ["python3", [path.join(directory, helper)]],
        ]
      : [
          [
            "pwsh",
            [
              "-NoProfile",
              "-NonInteractive",
              "-File",
              path.join(directory, helper),
            ],
          ],
          [
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-File",
              path.join(directory, helper),
            ],
          ],
        ];
  let result;
  for (const [command, args] of commands) {
    result = spawnSync(command, args, {
      input: JSON.stringify(inputs),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    if (!result.error && result.status === 0) break;
  }
  if (result.error || result.status !== 0)
    throw new Error(
      `${language} parser unavailable/failed: ${result.error?.message || result.stderr}`,
    );
  const results = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
  for (const entry of results) {
    for (const record of entry.records || []) {
      if (record.kind === "powershell-template")
        record.staticText = record.text.replace(
          /\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][\w:]*/g,
          "",
        );
      const index = ctx.literal({ file: entry.file, ...record });
      const outputCall =
        language === "python"
          ? /^(?:print|sys\.(?:stdout|stderr)\.write|.*(?:Error|Exception))$/.test(
              record.context,
            )
          : /^(?:Write-(?:Host|Output|Warning|Error|Information|Verbose)|Read-Host|throw)$/i.test(
              record.context,
            );
      if (record.role === "comment")
        ctx.literals[index].disposition = "comment";
      else if (
        ["syntax-key", "command-name"].includes(record.role) ||
        (record.role === "bareword" && !outputCall)
      )
        ctx.literals[index].disposition = "structural";
      else if (
        outputCall ||
        ctx.config.textProperties.includes(record.field) ||
        record.field === "value"
      )
        output(
          ctx,
          index,
          language === "python" ? "runner-content" : "operations",
          `${language}: ${record.context || record.field}`,
        );
      else if (technicalShape(record.text))
        ctx.literals[index].disposition = "technical-shape-review";
    }
  }
  return results;
}
