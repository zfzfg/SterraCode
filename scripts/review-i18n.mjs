import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parsers } from "prettier/plugins/babel.mjs";
import { parse as parseHTML } from "parse5";

// This is a review ledger, never an audit baseline. It does not change an
// auditor finding, exception, severity, fingerprint or exit status.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const inputFiles = ["befunde", "coverage", "literale"].map(
  (name) => `docs/i18n/deep/${name}.json`,
);
const [audit, coverage, inventory] = inputFiles.map((file) =>
  JSON.parse(read(file)),
);
const categories = {
  catalog: "Übersetzungskatalog",
  fallback: "gebundener Katalogtext oder Kompatibilitätsfallback",
  technical: "technischer Vertrag",
  original: "Originaldaten",
  prompt: "internes Promptmaterial",
  fixture: "Testfixture",
  operations: "optionale Betriebsstufe",
};
const models = new Map();
const sourceChecks = [];
const propertyName = (node) =>
  node?.type === "Identifier" ? node.name : node?.value;
const properties = (node) =>
  node?.type === "ObjectExpression"
    ? new Map(
        node.properties
          .filter((p) => p.type === "ObjectProperty")
          .map((p) => [propertyName(p.key), p]),
      )
    : new Map();
function allProperties(node) {
  const result = properties(node);
  for (const item of node?.properties || []) {
    if (item.type !== "SpreadElement") continue;
    const branches =
      item.argument.type === "ConditionalExpression"
        ? [item.argument.consequent, item.argument.alternate]
        : [item.argument];
    for (const branch of branches)
      for (const [key, value] of allProperties(branch))
        if (!result.has(key)) result.set(key, value);
  }
  return result;
}
function walk(node, fn, parent = null, key = "") {
  if (!node || typeof node !== "object") return;
  fn(node, parent, key);
  for (const [name, value] of Object.entries(node)) {
    if (["tokens", "comments", "loc", "extra"].includes(name)) continue;
    if (Array.isArray(value))
      value.forEach((item) => walk(item, fn, node, name));
    else if (value && typeof value === "object") walk(value, fn, node, name);
  }
}
function modelFor(file) {
  if (models.has(file)) return models.get(file);
  const entry = coverage.coverage.find((row) => row.file === file);
  const physical = entry?.originalFile || file.split("::")[0];
  let source;
  try {
    source = read(physical);
  } catch {
    models.set(file, null);
    return null;
  }
  const originalEntry = coverage.coverage.find((row) => row.file === physical);
  const hash = digest(source);
  const model = {
    file,
    physical,
    source,
    hash,
    fresh: !originalEntry?.sha256 || originalEntry.sha256 === hash,
    parents: new WeakMap(),
    nodes: [],
    bindings: new Map(),
    statements: [],
  };
  models.set(file, model);
  if (entry?.embedded) return model;
  if (/\.[cm]?js$/.test(file)) {
    const ast = parsers.babel.parse(source);
    model.ast = ast;
    walk(ast, (node, parent, key) => {
      if (parent) model.parents.set(node, { parent, key });
      if (Number.isInteger(node.start)) model.nodes.push(node);
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
        const values = model.bindings.get(node.id.name) || [];
        values.push(node.init);
        model.bindings.set(node.id.name, values);
      }
      if (node.type === "ExpressionStatement") model.statements.push(node);
    });
  } else if (/\.html$/.test(file))
    model.html = parseHTML(source, { sourceCodeLocationInfo: true });
  return model;
}
function resolve(node, model, depth = 0) {
  if (depth > 5) return node;
  if (node?.type === "Identifier") {
    const values = model.bindings.get(node.name);
    if (values?.length === 1) return resolve(values[0], model, depth + 1);
  }
  return node;
}
function staticStrings(node, model) {
  node = resolve(node, model);
  if (!node) return [];
  if (node.type === "StringLiteral") return [node.value];
  if (node.type === "ConditionalExpression")
    return [
      ...staticStrings(node.consequent, model),
      ...staticStrings(node.alternate, model),
    ];
  if (node.type === "ArrayExpression")
    return node.elements.flatMap((item) => staticStrings(item, model));
  return [];
}
function descriptor(node, model) {
  node = resolve(node, model);
  if (node?.type === "ConditionalExpression")
    return (
      descriptor(node.consequent, model) || descriptor(node.alternate, model)
    );
  const props = properties(node);
  return props.get("messageKey")?.value || props.get("key")?.value;
}
function bindingRecord(kind, node, keyNode, model) {
  const keys = staticStrings(keyNode, model).filter((value) =>
    /^[A-Za-z][\w-]*:[\w.-]+$/.test(value),
  );
  return {
    kind,
    file: model.file,
    line: model.source.slice(0, node.start).split("\n").length,
    expression: model.source.slice(node.start, node.end).slice(0, 500),
    messageKeys: [...new Set(keys)],
    ...(keys.length
      ? {}
      : {
          dynamicKeySource: model.source.slice(keyNode.start, keyNode.end),
          contract: "C-descriptors",
        }),
  };
}
function astBinding(literal, model) {
  if (!model?.ast || !model.fresh) return null;
  const nodes = model.nodes
    .filter((node) => node.start <= literal.start && node.end >= literal.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start));
  for (const node of nodes) {
    if (node.type === "CallExpression") {
      const callee = model.source.slice(node.callee.start, node.callee.end);
      if (
        /^(?:error|fail|warn|send|this\.phase|newError|validationError)$/.test(
          callee,
        )
      ) {
        for (const argument of node.arguments) {
          const key = descriptor(argument, model);
          if (
            !key ||
            (argument.start <= literal.start && argument.end >= literal.end)
          )
            continue;
          return bindingRecord(
            `explicit-helper-${callee}-descriptor-argument`,
            node,
            key,
            model,
          );
        }
      }
    }
    if (
      node.type === "NewExpression" &&
      ["AppError", "RunnerError"].includes(node.callee?.name) &&
      node.arguments.length >= 4
    ) {
      const first = node.arguments[0];
      if (first.start <= literal.start && first.end >= literal.end) {
        const key = descriptor(node.arguments[3], model);
        if (key)
          return bindingRecord(
            "error-constructor-fourth-argument",
            node,
            key,
            model,
          );
      }
    }
    if (node.type === "ObjectProperty") {
      const owner = model.parents.get(node)?.parent;
      if (
        owner?.type !== "ObjectExpression" ||
        literal.start < node.value.start ||
        literal.end > node.value.end
      )
        continue;
      const name = propertyName(node.key);
      if (
        ![
          "error",
          "message",
          "text",
          "reason",
          "summary",
          "limitations",
          "description",
          "progress",
          "value",
        ].includes(name)
      )
        continue;
      const props = allProperties(owner);
      const key =
        props.get(`${name}Key`)?.value ||
        (["error", "message", "text"].includes(name)
          ? props.get("messageKey")?.value
          : null);
      const envelope = props.get(`${name}Message`)?.value;
      const nestedKey = envelope ? descriptor(envelope, model) : null;
      if (key || nestedKey)
        return bindingRecord(
          `object-${name}-descriptor`,
          owner,
          key || nestedKey,
          model,
        );
    }
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression"
    ) {
      const field = propertyName(node.left.property);
      if (!["error", "message", "reason", "progress"].includes(field)) continue;
      const target = model.source.slice(
        node.left.object.start,
        node.left.object.end,
      );
      const keyName = field === "message" ? "messageKey" : `${field}Key`;
      for (const statement of model.statements) {
        if (statement.start < node.end || statement.start - node.end > 500)
          continue;
        const next = statement.expression;
        if (
          next?.type !== "AssignmentExpression" ||
          next.left.type !== "MemberExpression"
        )
          continue;
        if (
          model.source.slice(next.left.object.start, next.left.object.end) !==
            target ||
          propertyName(next.left.property) !== keyName
        )
          continue;
        const originalStatement = nodes.find(
          (parent) => parent.type === "ExpressionStatement",
        );
        if (
          !originalStatement ||
          model.parents.get(originalStatement)?.parent !==
            model.parents.get(statement)?.parent
        )
          continue;
        return bindingRecord(
          "paired-assignment-same-block",
          node,
          next.right,
          model,
        );
      }
    }
  }
  return null;
}
const pythonReview = String.raw`
import ast,json,sys
s=sys.stdin.buffer.read().decode('utf8'); tree=ast.parse(s); lines=s.splitlines(keepends=True); offsets=[0]
for line in lines: offsets.append(offsets[-1]+len(line))
def pos(n,end=False):
 row=n.end_lineno if end else n.lineno; col=n.end_col_offset if end else n.col_offset
 return offsets[row-1]+len(lines[row-1].encode('utf8')[:col].decode('utf8'))
def text(n): return ast.get_source_segment(s,n) or ''
def descriptor(n):
 if isinstance(n,ast.Dict):
  values={k.value:v for k,v in zip(n.keys,n.values) if isinstance(k,ast.Constant) and isinstance(k.value,str)}
  return values.get('messageKey',values.get('key'))
 return None
out=[]
def record(n,key,kind):
 out.append({'start':pos(n),'end':pos(n,True),'kind':kind,'line':n.lineno,'key':text(key)})
for n in ast.walk(tree):
 if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='ResultValueError' and len(n.args)>=2:
  record(n.args[0],n.args[1],'python-typed-ResultValueError')
 if isinstance(n,ast.Dict):
  values={k.value:v for k,v in zip(n.keys,n.values) if isinstance(k,ast.Constant) and isinstance(k.value,str)}
  for field in ['message','value']:
   key=values.get('messageKey') if field=='message' else descriptor(values.get('valueMessage'))
   if field in values and key is not None: record(values[field],key,'python-dict-'+field+'-descriptor')
  if 'message' in values:
   for candidate in ast.walk(tree):
    if isinstance(candidate,ast.Call) and isinstance(candidate.func,ast.Attribute) and candidate.func.attr=='update' and candidate.lineno>n.end_lineno and candidate.lineno<=n.end_lineno+3 and candidate.args:
     key=descriptor(candidate.args[0])
     if key is not None: record(values['message'],key,'python-adjacent-error-dict-update')
 # Encoder result dictionaries add a descriptor in the immediately following
 # guarded assignment; recognise that exact result[field] target.
 if isinstance(n,ast.Assign) and isinstance(n.value,ast.Dict):
  values={k.value:v for k,v in zip(n.value.keys,n.value.values) if isinstance(k,ast.Constant)}
  if 'value' not in values: continue
  names=[t.id for t in n.targets if isinstance(t,ast.Name)]
  for candidate in ast.walk(tree):
   if not isinstance(candidate,ast.Assign) or candidate.lineno<=n.lineno or candidate.lineno>n.end_lineno+3: continue
   for target in candidate.targets:
    if isinstance(target,ast.Subscript) and isinstance(target.value,ast.Name) and target.value.id in names and isinstance(target.slice,ast.Constant) and target.slice.value=='valueMessage':
     key=descriptor(candidate.value)
     if key is not None: record(values['value'],key,'python-encoder-paired-valueMessage')
parents={child:parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
for n in ast.walk(tree):
 if not isinstance(n,ast.Constant) or not isinstance(n.value,str): continue
 parent=parents.get(n); reason=None
 if isinstance(parent,ast.Subscript) and parent.slice is n: reason='python-schema-subscript'
 if isinstance(parent,ast.Compare) or isinstance(parent,(ast.Tuple,ast.List)) and isinstance(parents.get(parent),ast.Compare): reason='python-typed-enum-comparison'
 if isinstance(parent,ast.Dict):
  for key,value in zip(parent.keys,parent.values):
   if value is n and isinstance(key,ast.Constant) and key.value in ['kind','type','phase']: reason='python-typed-record-field'
 if isinstance(parent,ast.Call):
  name=text(parent.func)
  if name=='open' or name.endswith(('.encode','.decode','.endswith','.replace','.spec_from_file_location')) or name=='finish' and parent.args and parent.args[0] is n: reason='python-io-or-state-call-'+name
 if isinstance(parent,ast.keyword) and parent.arg=='encoding': reason='python-encoding-keyword'
 if n.value in ['object-','frame-','__main__']: reason='python-encoder-identity-or-entry-contract'
 if reason: out.append({'start':pos(n),'end':pos(n,True),'kind':reason,'line':n.lineno,'technical':True})
print(json.dumps(out))
`;
function pythonBinding(literal, model) {
  if (!model?.fresh || !model.physical.endsWith(".py")) return null;
  if (!model.python)
    model.python = JSON.parse(
      execFileSync("python", ["-c", pythonReview], {
        input: model.source,
        encoding: "utf8",
      }),
    );
  let start = literal.start,
    end = literal.end;
  if (!Number.isInteger(start)) {
    const lines = model.source.split(/(?<=\n)/);
    const line = lines[literal.line - 1] || "";
    const prefix = lines.slice(0, literal.line - 1).join("").length;
    const expected = Buffer.from(line)
      .subarray(0, literal.column - 1)
      .toString("utf8").length;
    const offset = literal.source
      ? line.indexOf(literal.source, Math.max(0, expected - 1))
      : expected;
    start = prefix + Math.max(0, offset);
    end = start + (literal.source || literal.text).length;
  }
  const found = model.python.find(
    (row) => row.start <= start && row.end >= end,
  );
  return found
    ? {
        kind: found.kind,
        file: model.file,
        line: found.line,
        ...(found.technical
          ? { technical: true }
          : { messageKeys: [found.key.replace(/^['"]|['"]$/g, "")] }),
        expression: model.source.slice(found.start, found.end).slice(0, 400),
      }
    : null;
}
function htmlBinding(literal, model) {
  if (!model?.html || !model.fresh) return null;
  let result;
  function visit(node, parent) {
    const attrs = Object.fromEntries(
      (node.attrs || []).map((item) => [item.name, item.value]),
    );
    const location = node.sourceCodeLocation;
    if (
      location &&
      location.startOffset <= literal.start &&
      location.endOffset >= literal.end
    ) {
      if (literal.kind === "html-text" && node.nodeName === "#text") {
        const key = parent?.attrs?.find(
          (item) => item.name === "data-i18n",
        )?.value;
        if (key)
          result = {
            kind: "html-data-i18n-owner",
            file: model.file,
            line: literal.line,
            messageKeys: [key],
          };
      } else if (literal.kind === "html-attribute") {
        const attribute = literal.owner.split(".").at(-1);
        const key = attrs[`data-i18n-${attribute}`];
        if (key)
          result = {
            kind: "html-data-i18n-attribute-owner",
            file: model.file,
            line: literal.line,
            messageKeys: [key],
          };
      }
    }
    for (const child of node.childNodes || []) visit(child, node);
    if (node.content) visit(node.content, node);
  }
  visit(model.html);
  return result;
}
const invariants = new Set([
  "SterraCode",
  "OpenAI",
  "OpenAI API",
  "LM Studio",
  "Python",
  "JavaScript",
  "Bash",
  "Go",
  "Rust",
  "C++",
  "C#",
  "Lua",
  "Java",
  "HTML",
  "CSS",
  "JSON",
  "UTF-8",
  "Solarized",
  "None",
  "True",
  "False",
  "MiB",
  "Docker",
  "Node.js",
  "Copyright",
]);
const syntaxRoles = new Set([
  "syntax-key",
  "module-specifier",
  "event-name",
  "structural-argument",
  "css-class",
  "member-selector",
  "attribute-token",
  "command-name",
  "bareword",
]);
const technicalFields = new Set([
  "id",
  "type",
  "status",
  "state",
  "language",
  "provider",
  "code",
  "method",
  "action",
  "schema",
  "format",
  "kind",
  "role",
  "encoding",
  "extension",
  "path",
  "entry",
  "function",
  "mode",
  "algorithm",
  "comparison",
  "actor",
  "source",
  "visibility",
  "command",
  "shell",
  "timeout",
  "component",
  "reason",
  "operationId",
]);
for (const field of [
  "theme",
  "cache",
  "year",
  "month",
  "day",
  "style",
  "fallbackLng",
  "defaultNS",
  "monaco",
  "fontFamily",
  "contextMenuGroupId",
  "wordWrap",
  "base",
  "stdio",
  "flags",
  "accessibilitySupport",
  "referrerPolicy",
  "nodeName",
  "Permissions-Policy",
  "Cache-Control",
  "Referrer-Policy",
  "Authorization",
  "LANG",
  "LC_ALL",
  "DEBIAN_FRONTEND",
])
  technicalFields.add(field);
for (const field of [
  "level",
  "sameSite",
  "difficulty",
  "questionType",
  "timeZone",
  "harnessVersion",
  "acceptedBy",
  "origin",
  "contextOverflowPolicy",
  "toolNaming",
  "stopReason",
  "template",
])
  technicalFields.add(field);
let registries;
function knownRegistries() {
  if (registries) return registries;
  registries = {
    ids: new Set(),
    settings: new Set(),
    icons: new Set(),
    classes: new Set(),
    locales: new Set(["de", "en", "es"]),
    machine: new Map(),
  };
  const html = parseHTML(read("public/index.html"));
  function visit(node) {
    for (const attr of node.attrs || []) {
      if (attr.name === "id") registries.ids.add(attr.value);
      if (attr.name === "class")
        attr.value
          .split(/\s+/)
          .forEach((value) => registries.classes.add(value));
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(html);
  const icons = modelFor("public/js/icons.js");
  for (const node of icons.nodes)
    if (node.type === "VariableDeclarator" && node.id.name === "names")
      walk(node.init, (value) => {
        if (value.type === "StringLiteral") registries.icons.add(value.value);
      });
  for (const file of [
    "server/services/storage.js",
    "server/services/context/settings.js",
  ]) {
    const model = modelFor(file);
    for (const node of model.nodes) {
      if (
        (node.type === "FunctionDeclaration" &&
          node.id.name === "defaultSettings") ||
        (node.type === "VariableDeclarator" &&
          node.id.name === "CONTEXT_DEFAULTS")
      )
        walk(node, (value) => {
          if (value.type === "ObjectProperty")
            registries.settings.add(propertyName(value.key));
        });
    }
  }
  const css = read("public/style.css");
  for (const match of css.matchAll(/\.([a-z][\w-]*)/g))
    registries.classes.add(match[1]);
  for (const row of coverage.coverage.filter(
    (item) =>
      item.sha256 &&
      /\.[cm]?js$/.test(item.file) &&
      /^(?:public|server|runner|shared)\//.test(item.file),
  )) {
    const model = modelFor(row.file);
    for (const node of model.nodes) {
      if (node.type === "ObjectProperty") {
        const value = propertyName(node.key);
        if (
          typeof value === "string" &&
          /^[a-z][\w.-]*$/.test(value) &&
          !registries.machine.has(value)
        )
          registries.machine.set(value, {
            file: row.file,
            line: model.source.slice(0, node.start).split("\n").length,
            kind: "declared-object-schema-key",
          });
      }
      if (node.type !== "StringLiteral" || /\s|[äöüß]/.test(node.value))
        continue;
      const parent = model.parents.get(node)?.parent;
      if (
        (parent?.type === "BinaryExpression" &&
          ["===", "!=="].includes(parent.operator)) ||
        parent?.type === "SwitchCase" ||
        (parent?.type === "ObjectProperty" &&
          technicalFields.has(propertyName(parent.key)))
      )
        if (!registries.machine.has(node.value))
          registries.machine.set(node.value, {
            file: row.file,
            line: model.source.slice(0, node.start).split("\n").length,
            kind: parent.type,
          });
    }
  }
  return registries;
}
function catalogMapBinding(literal, model) {
  if (model?.physical !== "runner/catalog.js" || !model.fresh) return null;
  const row = model.nodes.find(
    (node) =>
      node.type === "ObjectExpression" &&
      node.start < literal.start &&
      node.end > literal.end &&
      properties(node).has("id") &&
      properties(node).has("description"),
  );
  if (!row) return null;
  const props = properties(row);
  if (
    literal.start < props.get("description").value.start ||
    literal.end > props.get("description").value.end
  )
    return null;
  const programs = model.nodes.find(
    (node) => node.type === "VariableDeclarator" && node.id.name === "PROGRAMS",
  );
  const keyProperty = model.nodes.find(
    (node) =>
      node.type === "ObjectProperty" &&
      propertyName(node.key) === "descriptionKey" &&
      node.start > row.end,
  );
  if (
    !programs ||
    !keyProperty ||
    keyProperty.value.type !== "TemplateLiteral" ||
    keyProperty.value.quasis[0].value.cooked !== "runner:catalog."
  )
    return null;
  const id = props.get("id").value.value;
  return {
    kind: "explicit-PROGRAMS-array-map-descriptionKey",
    file: model.file,
    line: literal.line,
    messageKeys: [`runner:catalog.${id}`],
    expression: model.source.slice(keyProperty.start, keyProperty.end),
  };
}
function technicalBinding(literal, model) {
  if (!model?.ast || !model.fresh) return null;
  const nodes = model.nodes
    .filter((node) => node.start <= literal.start && node.end >= literal.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start));
  for (const node of nodes) {
    if (
      node.type === "ForOfStatement" &&
      model.file === "runner/jobs.js" &&
      node.right.type === "ArrayExpression" &&
      node.right.start <= literal.start &&
      node.right.end >= literal.end
    ) {
      const variable = node.left.declarations?.[0]?.id?.name;
      let target,
        createsTarget = false;
      walk(node.body, (item) => {
        if (
          item.type === "VariableDeclarator" &&
          item.init?.type === "TemplateLiteral" &&
          item.init.quasis[0]?.value.cooked === "/proc/self/fd/" &&
          item.init.expressions.some(
            (part) => part.type === "Identifier" && part.name === variable,
          )
        )
          target = item.id.name;
      });
      if (target)
        walk(node.body, (item) => {
          if (
            item.type === "CallExpression" &&
            model.source.slice(item.callee.start, item.callee.end) ===
              "fs.mkdir" &&
            item.arguments[0]?.name === target
          )
            createsTarget = true;
        });
      if (createsTarget)
        return "AST-for-of-Tabelle fließt über den geprüften Cache-Dateideskriptor in /proc/self/fd/... und fs.mkdir(target); technische Werkzeugcache-Unterverzeichnisse.";
    }
    if (
      node.type === "VariableDeclarator" &&
      node.init?.type === "NewExpression" &&
      node.init.callee.name === "Set"
    ) {
      const name = node.id.name;
      const usedAsPredicate = model.nodes.some(
        (item) =>
          item.type === "CallExpression" &&
          item.callee.type === "MemberExpression" &&
          item.callee.object.name === name &&
          propertyName(item.callee.property) === "has",
      );
      if (usedAsPredicate)
        return `AST-Setdeklaration ${name}, tatsächlich als ${name}.has(...) für Status-/Mengenlogik verwendet.`;
    }
    if (
      node.type === "TemplateLiteral" &&
      node.quasis.every((part) => !/\p{L}/u.test(part.value.cooked))
    )
      return "Template enthält ausschließlich dynamische Original-/Übersetzungswerte und Trennzeichen.";
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression" &&
      ["className", "type", "id", "method", "autocomplete"].includes(
        propertyName(node.left.property),
      )
    )
      return `AST-DOM-Vertrag ${propertyName(node.left.property)}`;
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression" &&
      propertyName(node.left.property) === "state" &&
      !/[äöüß]|\p{L}{2,}\s+\p{L}{2,}/u.test(literal.text)
    )
      return "AST-Zuweisung eines maschinellen state-Enums, getrennt von error/message-Anzeigefeldern.";
    if (node.type === "ObjectProperty") {
      const props = properties(model.parents.get(node)?.parent);
      const key = propertyName(node.key);
      if (
        (key === "name" && props.has("label")) ||
        (key === "value" &&
          props.has("label") &&
          !/[äöüß]|\s/.test(literal.text))
      )
        return `AST-Formularvertrag ${key}, eigener label-Coowner`;
      if (
        ["autocomplete", "Content-Type", "Content-Security-Policy"].includes(
          key,
        )
      )
        return `AST-Protokoll-/Formularfeld ${key}`;
    }
    if (
      node.type === "ObjectProperty" &&
      technicalFields.has(propertyName(node.key)) &&
      !/\s/.test(literal.text.trim())
    )
      return `AST-Vertragsfeld ${propertyName(node.key)}`;
    if (
      node.type === "BinaryExpression" &&
      ["===", "!==", "==", "!="].includes(node.operator)
    )
      return `AST-Vergleich ${node.operator}; fester Vergleichswert`;
    if (
      node.type === "SwitchCase" &&
      node.test?.start <= literal.start &&
      node.test.end >= literal.end
    )
      return "AST-Switchkennung";
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const callee = model.source.slice(node.callee.start, node.callee.end);
      if (
        callee === "app.disable" &&
        model.bindings
          .get("app")
          ?.some(
            (init) =>
              init?.type === "CallExpression" && init.callee.name === "express",
          )
      )
        return "AST-Express-Featureflag: app=express(), app.disable(...).";
      if (callee === "express.json")
        return "AST-Konfiguration des Express-JSONparsers, insbesondere limit; kein Produkttext.";
      if (
        callee === "this.launch" &&
        node.arguments[2]?.type === "ArrayExpression" &&
        node.arguments[2].start <= literal.start &&
        node.arguments[2].end >= literal.end
      )
        return "AST-argv-Array des Runnerlaunchers (einschließlich Bash -c), getrennt vom Befehls-/Ausgabetext.";
      if (
        [
          "spawn",
          "execFile",
          "StringDecoder",
          "TextDecoder",
          "TextEncoder",
          "this.run",
          "this.apt",
          "this.probe",
          "probe",
          "probeFn",
          "window.require",
          "window.require.config",
          "monaco.editor.defineTheme",
          "monaco.editor.setTheme",
          "monaco.Uri.parse",
          "css.parse",
          "new URL",
        ].includes(callee)
      )
        return `AST-Runtime-/Modul-/Compiler-/Encoding-/Monaco-Aufruf ${callee}`;
      if (
        /^(?:JSON\.|Object\.|new RegExp|RegExp$|Buffer\.|path\.|fs\.|crypto\.|createHash$|require$)/.test(
          callee,
        ) ||
        /\.(?:replace|replaceAll|split|join|includes|startsWith|endsWith|match|matchAll|test|get|set|has|delete|emit|on|once|addEventListener|removeEventListener|querySelector|querySelectorAll|getElementById|getAttribute|setAttribute|classList\..+|digest|toString|readFile|writeFile|createHash|goToDiff|matchMedia)$/.test(
          callee,
        )
      )
        return `AST-technischer Aufruf ${callee}`;
      if (
        ["AppError", "RunnerError"].includes(callee) &&
        node.arguments[2]?.start <= literal.start &&
        node.arguments[2]?.end >= literal.end
      )
        return "Unveränderter maschineller Fehlercode";
    }
  }
  const registry = knownRegistries();
  if (registry.ids.has(literal.text))
    return "ID ist in public/index.html tatsächlich als Element-ID deklariert.";
  if (
    registry.settings.has(literal.text) &&
    !nodes.some(
      (node) =>
        node.type === "ObjectProperty" &&
        ["label", "title", "message", "description"].includes(
          propertyName(node.key),
        ),
    )
  )
    return "Exakter technischer Einstellungsname aus defaultSettings/CONTEXT_DEFAULTS; kein gleichlautender Katalogtext.";
  if (
    registry.icons.has(literal.text) &&
    (literal.owner.includes("typeInfo") ||
      nodes.some(
        (node) =>
          node.type === "CallExpression" &&
          ["button", "createIcon", "setIcon"].includes(node.callee.name),
      ))
  )
    return "Exakte Icon-ID aus public/js/icons.js im Icon-/Buttonargument oder Typentableau.";
  if (model.file === "public/js/icons.js" && literal.owner === "names")
    return "Deklaration der expliziten SVG-Icon-ID-Registry.";
  if (
    registry.classes.has(literal.text.trim()) &&
    !nodes.some(
      (node) =>
        node.type === "ObjectProperty" &&
        ["label", "title", "message", "description"].includes(
          propertyName(node.key),
        ),
    )
  )
    return "Exakte CSS-Klasse aus public/style.css/HTML, im geprüften DOM-/Zustandscode.";
  if (
    /^[A-Za-z][\w-]*:[\w.-]+$/.test(literal.text) ||
    (/^[A-Za-z][\w-]*:[\w.${}-]+$/.test(literal.text) &&
      literal.text.includes("${"))
  )
    return "Explizite Namespace-/Schlüsselsyntax, einschließlich endlicher/dokumentierter dynamischer Pfade.";
  if (
    registry.machine.has(literal.text) &&
    !nodes.some(
      (node) =>
        node.type === "ObjectProperty" &&
        [
          "label",
          "title",
          "message",
          "text",
          "description",
          "question",
        ].includes(propertyName(node.key)),
    )
  ) {
    const declaration = registry.machine.get(literal.text);
    return `Maschineller Schema-/Vergleichs-/Enumwert, AST-Deklaration ${declaration.file}:${declaration.line} (${declaration.kind}); kein eigener Textfeld-Coowner.`;
  }
  return null;
}
const ownerContracts = {
  "public/app.js": [
    [
      /^initLayout(?:\.|$)/,
      "Layoutansichten und Seitenleisten-IDs; DOM-Handler und data-view-Zustände.",
    ],
    [/^applyLayout(?:\.|$)/, "CSS-Abmessungen in px und Resizerattribute."],
  ],
  "public/js/editor.js": [
    [/^languages(?:\.|$)/, "Monaco-Dateiendungs-/Sprach-ID-Tabelle."],
    [/^fileLanguage/, "Monaco-Fallback-Sprach-ID."],
    [/^draftKey/, "Originlokaler technischer Draftspeicherschlüssel."],
    [/^updateEditorTheme/, "Monaco-Theme-/Farbvertrag."],
  ],
  "public/js/chat.js": [
    [
      /^applicationQuestion\.(?:template|ids)/,
      "Endliche Anwendungsschablonen und Optionskennungen; sichtbare Texte stammen aus learningContent.",
    ],
    [/^restoreChatDrafts/, "Felder der temporären Draftstruktur."],
    [
      /^(?:continueTask|renderTask|sendMessage)/,
      "Fortsetzungs-/Kontextaktionskennungen, keine sichtbaren Labels.",
    ],
  ],
  "public/js/profile.js": [
    [
      /^openProfile$/,
      "Explizite Wiederholungs-/Selbsteinschätzungsaktionskennungen; Labels separat übersetzt.",
    ],
  ],
  "public/js/i18n.js": [
    [
      /^(?:translateDOM|storageKey|locale|preloadLocale|initResources)/,
      "Eigene data-i18n-Attribute, Ressourcen-/Speicherschlüssel und Registrylocale.",
    ],
  ],
  "public/js/localeSwitch.js": [
    [
      /^(?:recoveryKey|historyRecoveryKey)/,
      "Versionierter temporärer Wiederherstellungs-Schlüssel.",
    ],
  ],
  "public/js/sessions.js": [
    [
      /^languageOptions/,
      "Programmiersprachen-IDs und invariante Eigenbezeichnungen.",
    ],
  ],
  "public/js/ui.js": [
    [
      /^(?:inline|markdown)/,
      "Explizit erzeugte Markdown-HTML-Tags; Textinhalte bleiben getrennte Parameter.",
    ],
  ],
  "public/js/setup.js": [
    [
      /^authenticate\.(?:key|password|confirmation)/,
      "HTML-Formularnamen und autocomplete-Vertrag.",
    ],
  ],
  "runner/runtime.js": [
    [
      /^(?:SPECS|childEnvironment|probe|runtimes|runFile)/,
      "Geprüfter Sprachwerkzeug-/Prozess-/Compilervertrag; argv, Umgebungswerte und neue Projektdateisyntax.",
    ],
  ],
  "server/services/localProcesses.js": [
    [
      /^(?:specs|probe|killTree|launch|runCode|sourceFiles)/,
      "Lokaler Prozessadapter: argv, stdio, Kodierungen, Compiler- und Dateisyntax.",
    ],
  ],
  "server/services/previews.js": [
    [
      /^(?:dataURL|previewHeaders|previewDocument|visit)/,
      "HTML/CSS-Parserattribute, CSP-/Ressourcen-/URL-/Bridgeprotokoll; sichtbare Diagnoseprosa braucht eigene Schlüssel.",
    ],
  ],
  "server/services/storage.js": [
    [/^ensureDataDirs/, "Explizite interne Datenverzeichnisse."],
    [/^getSettings$/, "Serialisierungs-/Kontextmigrationkennungen."],
  ],
  "server/services/context/results.js": [
    [/^retainedKeys/, "Explizite Projektion technischer Toolresultatfelder."],
  ],
  "server/services/modelUsage.js": [
    [/^fields/, "SDK-Zählerfeld-IDs für Nutzungsaggregation."],
  ],
  "server/services/sessions.js": [
    [
      /^(?:extension|entryFile)/,
      "Stabile Dateiendungs-/Einstiegsnamen-Tabelle.",
    ],
  ],
  "server/services/applicationQuestions.js": [
    [
      /^templates/,
      "Endliche zulässige Optionskennungen der Anwendungsschablonen.",
    ],
  ],
  "runner/catalog.js": [
    [
      /^PROGRAMS\.packages/,
      "Stabile Paketmanagerpaketnamen, getrennt von description/title.",
    ],
  ],
  "runner/grading/adapter.js": [
    [/^runTests/, "Isolierter Python-Harnessstart und argv-Optionen."],
  ],
  "runner/tracer/adapter.js": [
    [/^runTrace/, "Isolierter Python-Tracerstart und argv-Optionen."],
  ],
  "server/services/auth.js": [[/^SESSION_COOKIE/, "Technischer Cookie-Name."]],
  "server/services/previewBridge.js": [
    [
      /^previewBridge$/,
      "Feste native console-Levelkennungen; Nutzerconsoletexte bleiben getrennt.",
    ],
  ],
  "server/services/shutdown.js": [
    [/^drainServer/, "Interne Shutdown-/Lifecyclekennungen."],
  ],
};
function reviewedOwner(literal, model) {
  if (
    !model?.fresh ||
    !model.ast ||
    /[äöüß]|\p{L}{2,}\s+\p{L}{2,}/u.test(literal.text)
  )
    return null;
  const rules = ownerContracts[model.physical] || [];
  return (
    rules.find(([pattern]) => pattern.test(literal.owner || ""))?.[1] || null
  );
}
function reviewedProvenance(literal, model) {
  const file = model?.physical;
  const owner = literal.owner || "";
  if (!model?.fresh) return null;
  if (
    file === "public/js/i18n.js" &&
    /^Translation (?:catalog|manifest) unavailable/.test(literal.text)
  )
    return {
      category: "fallback",
      basis:
        "Nur vor Initialisierung wirksame Kataloglade-Diagnose; initialized-Catch übersetzt common:locale.loadFailed, Bootstrap zeigt dreisprachigen Warntext.",
      contract: "C-browser",
    };
  if (
    file === "server/services/context/index.js" &&
    ["initialize", "summaryText", "prepareView.rootPrefix"].includes(owner)
  )
    return {
      category: "prompt",
      basis:
        "Konkreter interner Probe-/Zusammenfassungs-/Originalauftragwrapper im Modellprompt, nicht als Oberfläche gerendert.",
      contract: "C-original-history",
    };
  if (
    ["server/services/lmStudio.js", "server/services/openAI.js"].includes(
      file,
    ) &&
    /^test(?:LMStudio|OpenAI)Connection/.test(owner) &&
    literal.text === "SterraCode Verbindungstest"
  )
    return {
      category: "prompt",
      basis:
        "Expliziter kurzer Provider-Verbindungstestinput; keine sichtbare Produktbeschriftung.",
    };
  if (file === "server/services/lmStudio.js" && owner === "lmStudioWarning")
    return {
      category: "fallback",
      basis:
        "Exportierter Containeradresswarnungs-Helfer; die Routes models/provider/server verwenden warningKey bzw explizit req.t(serverFeature:lmStudio.containerAddress).",
      binding: {
        kind: "reviewed-export-helper-consumer",
        file,
        line: literal.line,
        messageKeys: ["serverFeature:lmStudio.containerAddress"],
        consumers: [
          "server/routes/models.js",
          "server/routes/provider.js",
          "server/routes/server.js",
          "server/services/lmStudio.js",
        ],
      },
    };
  if (
    file === "server/services/sessions.js" &&
    owner === "createSession.title" &&
    literal.text === "Neue Session"
  )
    return {
      category: "fallback",
      basis:
        "Historischer direkter Service-Default; POST /sessions ergänzt fehlenden Titel ausdrücklich über req.t(sessions:new.title), Browserdefault separat aus sessions:new.defaultTitle.",
      binding: {
        kind: "reviewed-createSession-default-consumer",
        file,
        line: literal.line,
        messageKeys: ["sessions:new.title", "sessions:new.defaultTitle"],
        consumers: ["server/routes/sessions.js", "public/js/sessions.js"],
      },
    };
  if (file === "server/services/teacher.js" && owner === "abortAllTurns")
    return {
      category: "technical",
      basis:
        "Interne DOMException/AbortError-Grundangabe. Der sichtbare Turn-Abbruch hat separat learningContent:tutor.aborted; kein fremder Verlaufsinhalt wird geändert.",
    };
  if (
    file === "server/services/auth.js" &&
    owner === "createAuthService" &&
    literal.text === "Auth benötigt ein Datenverzeichnis."
  )
    return {
      category: "operations",
      basis:
        "Konstruktorvorbedingung der Serverinitialisierung, kein Fehler aus einer Nutzeranmeldung.",
    };
  if (
    (file === "server/services/applicationQuestions.js" &&
      literal.text === "Unknown application question template") ||
    (file === "shared/i18n/messages.js" &&
      /^Invalid message /.test(literal.text))
  )
    return {
      category: "technical",
      basis:
        "Interne Typ-/Vertragsvorbedingung. Nicht als eigener übersetzbarer Nutzerauftrag vorgesehen; unbekannte interne HTTP-Fehler bleiben generisch.",
    };
  if (
    ["server/app.js", "runner/index.js", "runner/jobs.js"].includes(file) &&
    /^(?:Interner Serverfehler|Runner initialization failed|Runner shutdown failed|Runner journal failure|Der Docker-Runner benötigt|SterraCode Runner protocol)/.test(
      literal.text,
    )
  )
    return {
      category: "operations",
      basis:
        "Konkreter console-/CLI-Initialisierungs-/Shutdown-/Journaldiagnosetext des Betreibers; HTTP-/Runnerantwort separat strukturiert.",
    };
  if (
    /^(?:Java JDK \d+|\.NET SDK(?: \d+)?|JDK \(java, javac\)|Cascadia Code|Python \d+|Lua \d+\.\d+|C\/C\+\+|Git|CC0-1\.0)$/.test(
      literal.text,
    )
  )
    return {
      category: "technical",
      basis:
        "Explizit geprüfter Produkt-/Werkzeug-/Font-/Lizenzname oder versionierte Toolbezeichnung.",
    };
  if (file === "runner/catalog/versions.lock")
    return {
      category: "technical",
      basis:
        "Versionierter Runner-Lockvertrag: Distribution, Architektur, Paket-/Archivpfade, Versionen und Prüfsummen.",
    };
  if (file === "public/style.css") {
    const line = model.source.split(/\r?\n/)[literal.line - 1] || "";
    if (/\[[^\]]+=/.test(line) || literal.owner === "--mono")
      return {
        category: "technical",
        basis:
          "Tatsächlicher CSS-Attributselektor beziehungsweise --mono-Fontdeklaration; kein content-Anzeigetext.",
      };
  }
  if (file === "public/js/bootstrap.js" && literal.text === "i18n bootstrap")
    return {
      category: "operations",
      basis:
        "console.error-Diagnosekennung des Bootstraps; sichtbarer Katalogfehler ist der getrennte dreisprachige Text.",
    };
  if (
    file === "public/app.js" &&
    owner === "showServer.fields.value" &&
    literal.text === ".env / Compose"
  )
    return {
      category: "technical",
      basis:
        "Invariante Herkunftsbezeichnung der Betreiberkonfiguration, kein übersetzbarer Satz.",
    };
  if (
    file === "public/js/workspace.js" &&
    owner === "createFile.data.fields.placeholder"
  )
    return {
      category: "technical",
      basis:
        "Explizites relatives Pfadbeispiel src bzw src/beispiel.py; Dateinamens-/Pfadsyntax bleibt stabil.",
    };
  if (file === "server/services/lmStudio.js" && owner === "abort.abort")
    return {
      category: "technical",
      basis:
        "Interner AbortError-Grund; sichtbarer Abbruch wird anhand AbortError separat lokalisiert.",
    };
  if (
    file === "runner/runtime.js" &&
    owner === "runFile" &&
    literal.text.startsWith("<Project Sdk=")
  )
    return {
      category: "technical",
      basis:
        "Generierte .NET-Projektdateisyntax für den Compiler; kein UI-Text.",
    };
  if (
    file === "server/services/previews.js" &&
    owner === "previewDocument.script"
  )
    return {
      category: "technical",
      basis:
        "Generiertes HTML-script-Element mit Daten-URL für die isolierte Vorschau, keine Beschriftung.",
    };
  if (file === "server/routes/chat.js" && owner.includes("heartbeat"))
    return {
      category: "technical",
      basis: "SSE-Kommentarframe als verbindungserhaltender Protokollmarker.",
    };
  if (file === "public/js/preview.js" && literal.text === "warn")
    return {
      category: "technical",
      basis:
        "Native console-Levelkennung warn für gespeicherte Previewdiagnosen.",
    };
  if (
    /^sterracode-(?:lernprofil|projekt)\.json$/.test(literal.text) &&
    ["public/js/profile.js", "public/js/projects.js"].includes(file)
  )
    return {
      category: "technical",
      basis:
        "Stabiler technischer Exportdateiname; Paketinhalt und UIbeschriftung sind separat behandelt.",
    };
  if (
    file === "server/services/testRunner.js" &&
    owner === "anonymous.run.runtime.version"
  )
    return {
      category: "fallback",
      basis:
        "Expliziter versionKey aus bedingtem Objektspread; HTTP localizeRun übersetzt serverFeature:tests.runtimeInOutput.",
      binding: {
        kind: "reviewed-conditional-versionKey-coowner",
        file,
        line: literal.line,
        messageKeys: ["serverFeature:tests.runtimeInOutput"],
        consumers: ["server/services/messageOutput.js"],
      },
    };
  if (file === "runner/launch.c")
    return {
      category:
        literal.text.includes("requires root") || owner.startsWith("perror")
          ? "original"
          : "technical",
      basis:
        "Natives privilegiertes POSIX-Launcherprotokoll: /proc-/argv-/stdio-Syntax beziehungsweise originale perror-/Bootstrapdiagnose auf Subprozess-stderr. Kein strukturierter übersetzter HTTPtext; Grenze ausdrücklich dokumentiert.",
      contract: "C-runner-output",
    };
  const exactContracts = [
    [
      "public/js/diffInspector.js",
      "inspectDiff.media",
      "(min-width: 900px)",
      "CSS-Mediaquery der Diffansicht, kein Beschriftungstext.",
    ],
    [
      "server/services/i18n.js",
      "localeMiddleware",
      "Accept-Language",
      "HTTP-Headername für Request-Locale.",
    ],
    [
      "server/services/learningReviews.js",
      "startReview",
      "review-start",
      "Globale Serialisierungsqueue für den Wiederholungsstart.",
    ],
    [
      "server/services/localProcesses.js",
      "anonymous.prefix",
      "-3",
      "Python-Launcherargument unter Windows.",
    ],
    [
      "server/services/localProcesses.js",
      "anonymous.prefix",
      "-X",
      "Python-Interpreteroption im Runtime-argv-Präfix; utf8 legt die zum Prozessdecoder passende Pipekodierung fest.",
    ],
    [
      "server/services/openAI.js",
      "responsePayload.response.body.include",
      "reasoning.encrypted_content",
      "OpenAI-Responses-Feld zur unveränderten Weitergabe verschlüsselten Reasonings.",
    ],
    [
      "server/services/openAI.js",
      "runOpenAIModelPass.capped",
      "rounds",
      "Maschineller Stop-/Rundenlimitmarker.",
    ],
    [
      "server/services/previews.js",
      "anonymous",
      "declarationList",
      "css-tree-Parserkontext einer CSS-Deklarationsliste.",
    ],
    [
      "server/services/profileManager.js",
      "validateProfile",
      "sessionCount",
      "Validierter Zählerfeldname historischer Profildaten.",
    ],
    [
      "server/services/projectTemplates.js",
      "anonymous.template",
      "templates",
      "Expliziter Namespace für getCatalogValue, kein übersetzbarer Titel.",
    ],
    [
      "server/services/providerCredentials.js",
      "updateProviderCredentials",
      "provider-credentials",
      "Serialisierungsqueuename des Credentialstores.",
    ],
    [
      "server/services/sessions.js",
      "migrate",
      "txt",
      "Fallback-Dateiendung der alten Editorwiederherstellung.",
    ],
    [
      "server/services/sessions.js",
      "anonymous.phase",
      "backing-up",
      "Persistierte Löschjournalphase, nicht anzuzeigende Aktionsbeschriftung.",
    ],
    [
      "server/services/workspace.js",
      "existing",
      "binary",
      "Maschinelle Binärdateikennung nach UTF8-Dekodierungsprüfung.",
    ],
  ];
  const exact = exactContracts.find(
    ([source, actualOwner, text]) =>
      source === file && actualOwner === owner && text === literal.text,
  );
  if (exact)
    return {
      category: "technical",
      basis: `Einzeln gelesener Quellvertrag: ${exact[3]}`,
    };
  if (
    file === "runner/tracer/python_tracer.py" &&
    ["before", "at", "locals", "exec"].includes(literal.text)
  )
    return {
      category: "technical",
      basis:
        "Einzeln gelesener nativer Tracevertrag: phase before/at, lokaler Snapshotfeldname locals beziehungsweise compile()-Modus exec.",
    };
  if (
    file === "server/services/concepts.js" &&
    owner === "anonymous.CONCEPTS.title" &&
    literal.text === "de"
  )
    return {
      category: "technical",
      basis:
        "Expliziter deutscher kanonischer Ausgangstitel der Konzeptregistry; Anzeigetitel werden pro Request abgeleitet.",
    };
  if (
    file === "server/services/lmStudio.js" &&
    owner === "clientFor" &&
    ["ws:", "wss:"].includes(literal.text)
  )
    return {
      category: "technical",
      basis:
        "WebSocket-Protokollwahl aus dem validierten HTTP(S)-Modellserverorigin.",
    };
  if (
    ["server/services/openAI.js", "server/services/runnerClient.js"].includes(
      file,
    ) &&
    owner.endsWith("headers.Authorization")
  )
    return {
      category: "technical",
      basis:
        "HTTP-Authorization-Bearerhülle; nur variabler Laufzeitwert, kein gespeichertes Geheimnis und kein Anzeigetext.",
    };
  if (
    file === "server/services/openAI.js" &&
    owner === "connectOpenAIModel.prefix"
  )
    return {
      category: "technical",
      basis: "Zufälliger interner Provider-/Toolcall-Namensraummarker.",
    };
  if (
    file === "server/services/previewBridge.js" &&
    owner === "locationOf.marker"
  )
    return {
      category: "technical",
      basis: "SourceURL-Zuordnungsmarker für bestätigte Vorschauquellpfade.",
    };
  if (
    file === "server/services/profileManager.js" &&
    ["addDays.d", "deriveProfile.passedKey"].includes(owner)
  )
    return {
      category: "technical",
      basis:
        "ISO-Datums-/Deduplizierungsschlüssel der unveränderten Wiederholungsplanung.",
    };
  if (
    [
      "server/services/projectTemplates.js",
      "server/services/proposals.js",
    ].includes(file) &&
    /(?:cases|hunks)\.id$/.test(owner)
  )
    return {
      category: "technical",
      basis:
        "Deterministische technische Testfall-/Hunk-ID, getrennt vom lokalisierten Namen/summary.",
    };
  if (file === "runner/programs.js" && owner === "installUpstream.manifest")
    return {
      category: "technical",
      basis: "Versionsgebundener Rust-Manifestdateiname im Downloadcache.",
    };
  if (
    file === "server/services/sessions.js" &&
    owner === "migrate" &&
    literal.text.startsWith("recovered-editor-")
  )
    return {
      category: "technical",
      basis:
        "Kollisionsfreier technischer Dateiname bei historischer Workspace-Migration.",
    };
  if (
    file === "server/services/sessions.js" &&
    owner === "anonymous" &&
    ["proposals", "traces", "test-runs"].includes(literal.text)
  )
    return {
      category: "technical",
      basis:
        "Liste tatsächlich gesicherter interner Artefaktverzeichnisse beim Löschen.",
    };
  if (
    file === "server/services/teacher.js" &&
    ["anonymous", "anonymous.session"].includes(owner) &&
    literal.text === "aborted"
  )
    return {
      category: "technical",
      basis:
        "Persistierter maschineller Turnstatus, eigene Anzeige wird getrennt lokalisiert.",
    };
  if (
    file === "server/services/toolExecutor.js" &&
    ["title", "description"].includes(literal.text) &&
    /^(?:executeTool\.task|executeTool\.title)/.test(owner)
  )
    return {
      category: "technical",
      basis:
        "short()-Validierungsfeldname des stabilen Toolschemas; keine Übersetzung von Werkzeug-JSON-Feldnamen.",
    };
  if (file === "server/routes/workspaces.js" && literal.text === "apply")
    return {
      category: "technical",
      basis: "Maschinelle Vorschlagsentscheidung im apply-Handler.",
    };
  return null;
}
function classify(literal) {
  const file = literal.file;
  const physical = file.split("::")[0];
  const model = modelFor(file);
  const decision = (category, basis, extra = {}) => ({
    category,
    basis,
    ...extra,
  });
  if (/^tests\//.test(physical))
    return decision(
      "fixture",
      "Quellpfad ist Teil der versionierten Test-/Browser-/Providerfixtures; keine Produktübersetzung.",
    );
  if (
    /^(?:scripts|docker|tools)\//.test(physical) ||
    /\.(?:sh|ps1|bat)$/.test(physical)
  )
    return decision(
      "operations",
      "Explizit optionale Betreiber-/Installations-/Diagnose- oder Auditstufe, siehe Umstellungsplan Etappe 7.",
    );
  if (
    /^(?:Dockerfile|compose|\.env\.example|Caddyfile|package\.json|.*\.config\.js)/.test(
      physical,
    )
  )
    return decision(
      "technical",
      "Deployment-/Paket-/Werkzeugkonfiguration; kein wechselnder Produkttext.",
    );
  if (/^(?:shared\/i18n\/locales|public\/locales|locales)\//.test(physical))
    return decision(
      literal.role === "syntax-key" ? "technical" : "catalog",
      literal.role === "syntax-key"
        ? "JSON-Katalogpfad und Ressourcenstruktur."
        : "Wert einer versionierten Produktressource; originaler Namespace-/Locale-Pfad ist der Beleg.",
    );
  const binding =
    astBinding(literal, model) ||
    htmlBinding(literal, model) ||
    pythonBinding(literal, model) ||
    catalogMapBinding(literal, model);
  if (binding)
    return decision(
      binding.technical ? "technical" : "fallback",
      binding.technical
        ? "Native Python-AST-Bindung an IO-/Schema-/Enumvertrag."
        : "Explizite strukturelle Bindung an Übersetzungsmetadaten; nicht aus Textgleichheit abgeleitet.",
      { binding },
    );
  const reviewed = reviewedProvenance(literal, model);
  if (reviewed) return reviewed;
  if (literal.role === "translation-key")
    return decision(
      "technical",
      "Statischer Übersetzungsschlüssel; seine Katalogexistenz prüft der Auditor separat.",
    );
  if (syntaxRoles.has(literal.role))
    return decision(
      "technical",
      `Parserrolle ${literal.role}: Syntax-/Selektor-/Ereignis-/Modulvertrag.`,
    );
  if (literal.role === "comment")
    return decision(
      "technical",
      "Quellkommentar; wird nicht als Produktinhalt ausgeführt. Eventuelle separate erzeugte Quellinhalte haben eigene Inventareinträge.",
    );
  if (
    literal.role === "prompt" ||
    /^(?:server\/prompts\/|server\/services\/tools\.js$|server\/services\/context\/(?:history|workflow|prompt|core\/.*)\.js$)/.test(
      physical,
    )
  )
    return decision(
      "prompt",
      "Geprüfter interner Tool-/Kontext-/Snapshot-/Wiederherstellungsvertrag, siehe INHALTE.md; kein nachträgliches Umschreiben kanonischer Historie.",
    );
  if (
    physical === "server/services/storage.js" &&
    /^DEFAULT_SYSTEM_PROMPT/.test(literal.owner || "")
  )
    return decision(
      "prompt",
      "Historischer editierbarer deutscher Tutorgrundprompt; explizites sprachabhängiges Zurücksetzen erfolgt über server/prompts/tutor.js.",
    );
  if (
    physical === "server/services/profileManager.js" &&
    literal.owner === "profileToPromptText"
  )
    return decision(
      "prompt",
      "Kanonischer interner Profilprompt; sichtbare Fassung separat displayProfileContext().",
    );
  if (["server/index.js", "server/config.js"].includes(physical))
    return decision(
      "operations",
      "Start-/Konfigurationsdiagnose vor einem HTTP-Sprachkontext, siehe SERVER-TEXTFLUESSE.md.",
    );
  if (
    physical === "public/js/bootstrap.js" &&
    literal.text.includes("Language files could not be loaded")
  )
    return decision(
      "fallback",
      "Expliziter dreisprachiger Fehler vor verfügbarer Kataloginitialisierung; Bootstrapausnahme.",
    );
  if (invariants.has(literal.text))
    return decision(
      "technical",
      "Explizit überprüfter Produkt-/Sprach-/Formatname; sprachlich invariant, kein übersetzbarer Satz.",
    );
  const technical = technicalBinding(literal, model);
  if (technical?.startsWith("Template enthält"))
    return decision("original", technical, { contract: "C-browser" });
  if (technical) return decision("technical", technical);
  const ownerProof = reviewedOwner(literal, model);
  if (ownerProof) return decision("technical", ownerProof);
  if (/^[A-Za-z][\w-]*:[\w.-]+$/.test(literal.text))
    return decision(
      "technical",
      "Explizite Namespace-/Protokollschlüsselsyntax.",
    );
  if (
    literal.kind === "js-template" &&
    /^(?:\$\{[^}]+\}(?:\/|\.\w)|(?:[\w+.-]+:|#|<Project|<script)|.*(?:\/|\.json|\.tmp|\.part|\.py|\.csproj|\.events|\.sources|\.tar\.gz|px)$)/s.test(
      literal.text,
    ) &&
    !/[äöüß]|\p{L}{2,}\s+\p{L}{2,}/u.test(literal.text)
  )
    return decision(
      "technical",
      "Template baut anhand tatsächlicher Pfad-/URI-/Dateisuffixe eine APIadresse, Datei, Selektor oder Größenangabe; dynamische Bestandteile bleiben Daten.",
    );
  if (
    literal.kind === "js-template" &&
    /^(?:public\/js\/sessions\.js)$/.test(physical) &&
    /\$\{(?:session|updated)\.title\}/.test(literal.text)
  )
    return decision(
      "original",
      "Originaler Nutzersessiontitel plus invariante Produktbezeichnung; keine Übersetzung des gespeicherten Titels.",
      { contract: "C-browser" },
    );
  if (
    !/[\p{L}\p{N}]/u.test(literal.text) ||
    /^\s*\d+(?:\.\d+)*\s*$/.test(literal.text)
  )
    return decision(
      "technical",
      "Leeres Literal, Trenn-/Formatzeichen oder feste numerische Syntax.",
    );
  if (
    /^[A-Z][A-Z0-9_]+$/.test(literal.text) ||
    /^(?:https?:\/\/|[./]|--)[^\s]*$/.test(literal.text)
  )
    return decision(
      "technical",
      "Explizit maschinelle Code-/Pfad-/URL-/CLI-Syntax.",
    );
  if (
    physical === "server/services/concepts.js" &&
    /^(?:exercises|definitions)/.test(literal.owner || "")
  )
    return decision(
      "technical",
      "Stabile Konzept-/Alias-/Übungsverträge; Beispieldaten/Erwartungen werden unverändert materialisiert, siehe INHALTE.md.",
    );
  if (
    physical === "server/services/projectTemplates.js" &&
    /^(?:contracts|TEMPLATE_IDS)/.test(literal.owner || "")
  )
    return decision(
      "technical",
      "Versionierter Vorlagen-/Testsuitevertrag; absichtlich unveränderte Returnliterale und Eingaben, siehe INHALTE.md.",
    );
  return decision(
    null,
    !model?.fresh
      ? "Quellhash seit Audit verändert; aktuelle AST-Bindung darf nicht auf alte Offsets angewandt werden."
      : "Keine hinreichende Zuordnung aus Syntax/Herkunft/Metadaten; manuelle Quellprüfung erforderlich.",
  );
}

const literalAssignments = inventory.literals.map((literal) => ({
  literalId: literal.id,
  file: literal.file,
  line: literal.line,
  column: literal.column,
  role: literal.role,
  owner: literal.owner || "",
  excerpt: literal.text.slice(0, 220),
  ...classify(literal),
}));
const byId = new Map(literalAssignments.map((item) => [item.literalId, item]));
function dynamicKeyReview(finding) {
  const text = finding.text;
  let basis;
  let sources;
  if (/questions\.\$\{template\}/.test(text)) {
    basis =
      "Endliche Anwendungsschablonen onboarding/plan-completed und ihre vier jeweils zugehörigen Optionskennungen. UI erkennt nur application.version=1 oder eindeutiges onboarding:true; Server validiert Kennungsantworten gegen die gespeicherte Frage.";
    sources = [
      "server/services/applicationQuestions.js",
      "public/js/chat.js",
      "tests/i18n-content.test.js",
    ];
  } else if (finding.file === "server/services/concepts.js") {
    basis =
      "Sechs geprüfte Konzeptschlüssel variables/conditions/loops/lists/functions/strings aus der stabilen ID-/Definitionsregistry. reviewExercise verwirft unbekannte IDs statt neue Schlüssel zu raten.";
    sources = [
      "server/services/concepts.js",
      "docs/i18n/INHALTE.md",
      "tests/i18n-content.test.js",
    ];
  } else if (/element\.(?:dataset|getAttribute)/.test(text)) {
    basis =
      "Eigene HTML-/Setupdaten data-i18n und die endliche Attributliste title/aria-label/aria-description/aria-valuetext/placeholder/alt. Der Auditor prüft die statisch deklarierten HTML-Schlüssel separat; dynamisch fremder DOM-Inhalt ist kein neuer Übersetzungsvertrag.";
    sources = [
      "public/index.html",
      "public/js/setup.js",
      "public/js/i18n.js",
      "tests/e2e/i18n.spec.js",
    ];
  } else if (finding.file === "public/js/chat.js") {
    basis =
      "tutorText-Helfer: konkrete Aufrufer verwenden die statischen features:chat-Schlüssel für Fortsetzung und Codeerklärung; lng kommt aus session.tutorLocale oder der UIlocale. Nutzer-/Codeparameter werden als Daten interpoliert.";
    sources = [
      "public/js/chat.js",
      "public/js/i18n.js",
      "tests/e2e/i18n.spec.js",
    ];
  } else if (finding.file === "server/services/previews.js") {
    basis =
      "Endliche vorgeladene Bridge-Texte suppressed/resourceFailed/policyBlocked/navigationUnsupported; serialisierte Bridge braucht keine Imports. Parentseite validiert die bekannten Keys und Datenparameter, Nutzerconsole bleibt Original.";
    sources = [
      "server/services/previews.js",
      "server/services/previewBridge.js",
      "public/js/preview.js",
      "docs/i18n/SERVER-TEXTFLUESSE.md",
    ];
  } else if (/progressMessage/.test(text)) {
    basis =
      "Expliziter Runnerfortschrittsdescriptor aus ProgramManager.phase. Fachlicher Jobzustand, Stage und unveränderte Paketlogs sind getrennt; historische Jobs ohne Descriptor behalten Klartext.";
    sources = [
      "runner/programs.js",
      "server/services/messageOutput.js",
      "public/js/programs.js",
      "tests/i18n-runner-messages.test.js",
    ];
  } else if (/valueMessage/.test(text)) {
    basis =
      "Typisierter Tracer-Encodermarker valueMessage an bekannten Snapshotwerten, kein Vergleich des Wertestrings. Original value bleibt gespeichert; Anzeige darf displayValue hinzufügen.";
    sources = [
      "runner/tracer/python_tracer.py",
      "server/services/messageOutput.js",
      "public/js/tracer.js",
      "tests/i18n-api.test.js",
    ];
  } else if (/programError|exception\.messageKey/.test(text)) {
    basis =
      "Explizite eigene Trace-Ausnahmemarker mit messageKey/params; echte Programmausnahmen ohne diese Herkunft bleiben Original. Nur abgeleitete displayMessage wird hinzugefügt.";
    sources = [
      "runner/tracer/python_tracer.py",
      "server/services/traces.js",
      "server/services/messageOutput.js",
      "tests/i18n-api.test.js",
    ];
  } else if (/runtime\.versionKey/.test(text)) {
    basis =
      "Eigenes Runtime-Anzeigefeld mit versionKey/versionParams. Gemessene Runtimeversionen selbst bleiben unverändert; nur der eigene Nicht-gemessen-Hinweis ist übersetzt.";
    sources = [
      "server/services/testRunner.js",
      "server/services/messageOutput.js",
      "tests/i18n-api.test.js",
    ];
  } else {
    basis =
      "Expliziter Meldungs-/Requestübersetzer: aufrufender Featurepfad muss messageKey/key und sichere skalare Parameter liefern. Existenzprüfung hat generischen Fallback; rohe historische Inhalte ohne Metadaten werden nicht über Textgleichheit erkannt. Diese generische Schnittstelle allein beweist keine Übersetzung beliebiger zukünftiger fremder Keys.";
    sources = [
      "shared/i18n/messages.js",
      "server/services/i18n.js",
      "server/services/messageOutput.js",
      "public/js/i18n.js",
      "tests/i18n-api.test.js",
    ];
  }
  return {
    category: "technical",
    basis,
    sourceReferences: sources,
    contract: "C-dynamic-keys",
    runtimeProof: false,
  };
}
const findingAssignments = audit.findings.map((finding) => {
  const literal = byId.get(finding.literalId);
  if (literal)
    return {
      id: finding.id,
      fingerprint: finding.fingerprint,
      literalId: finding.literalId,
      rule: finding.rule,
      severity: finding.severity,
      auditStatus: finding.status,
      category: literal.category,
      basis:
        "Zuordnung der referenzierten Literalquelle; gleicher Text an anderer Stelle ist kein Beleg.",
    };
  const dynamic = finding.rule === "DYNAMIC_KEY";
  return {
    id: finding.id,
    fingerprint: finding.fingerprint,
    file: finding.file,
    line: finding.line,
    excerpt: finding.text.slice(0, 300),
    rule: finding.rule,
    severity: finding.severity,
    auditStatus: finding.status,
    category: finding.rule === "POSSIBLY_UNUSED_KEY" ? "catalog" : null,
    basis:
      finding.rule === "POSSIBLY_UNUSED_KEY"
        ? "Ressourcenschlüssel bleibt erhalten; statischer Nichtgebrauch ist keine Löschfreigabe."
        : "Befund ohne Literal benötigt eigenständige Prüfung.",
    ...(dynamic ? dynamicKeyReview(finding) : {}),
  };
});

const contracts = [
  {
    id: "C-descriptors",
    sources: [
      "shared/i18n/messages.js",
      "server/services/storage.js",
      "runner/common.js",
      "server/services/i18n.js",
      "server/services/messageOutput.js",
    ],
    description:
      "Explizite Meldungsmetadaten messageKey/params, sichere Parameter und requestfester Übersetzer. Eigene Felder werden gezielt serialisiert. Fehlende alte Metadaten bleiben Legacy-Original; der Vertrag behauptet keine Metadaten für beliebige fremde Errors.",
    tests: ["tests/i18n-api.test.js", "tests/i18n-runner-messages.test.js"],
  },
  {
    id: "C-dynamic-keys",
    sources: [
      "public/js/i18n.js",
      "public/js/chat.js",
      "server/services/applicationQuestions.js",
      "server/services/concepts.js",
      "server/services/projectTemplates.js",
      "server/services/messageOutput.js",
    ],
    description:
      "Registry/Katalogmanifest, eigene data-i18n-Attribute, explizite Descriptorschlüssel sowie endliche Fragen-/Konzept-/Vorlagen-IDs. Unbekannte Schlüssel geben generischen Text; keine Einordnung allein über gleichen Katalogtext. Endliche Inhaltsmengen sind INHALTE.md dokumentiert.",
    tests: [
      "tests/i18n-core.test.js",
      "tests/i18n-content.test.js",
      "tests/e2e/i18n.spec.js",
    ],
  },
  {
    id: "C-browser",
    sources: [
      "public/js/api.js",
      "public/js/i18n.js",
      "public/js/localeSwitch.js",
      "docs/i18n/INHALTE.md",
    ],
    description:
      "UI-Helfer empfangen sowohl übersetzte Apptexte als auch originale Session-/Datei-/Modell-/Programmdaten. REST und SSE transportieren Locale und Meldungsmetadaten; gerenderte Daten werden nicht in Originalhistorie zurückübersetzt. Generische Helferflüsse sind konservative Call-Unions, kein Beweis gleicher Laufzeitwerte.",
    tests: ["tests/e2e/i18n.spec.js", "tests/learning-support.test.js"],
  },
  {
    id: "C-original-history",
    sources: [
      "server/services/context/history.js",
      "server/services/context/sourceHash.js",
      "server/services/teacher.js",
      "server/services/profileManager.js",
      "docs/i18n/INHALTE.md",
    ],
    description:
      "Modell-/Nutzertexte, Quelldateien, Testwerte, Ereignisse und opaque Providerdaten bleiben kanonisch. Eigene neue Fragen/Offlineaufgaben/Vorlagen besitzen explizite Herkunft und werden beim Erstellen materialisiert. Interne Technikprompts behalten ihre festgelegte Sprache.",
    tests: [
      "tests/i18n-content.test.js",
      "tests/context-integration.test.js",
      "tests/provider-openai.test.js",
    ],
  },
  {
    id: "C-server-output",
    sources: [
      "server/app.js",
      "server/services/messageOutput.js",
      "server/services/processReasons.js",
      "docs/i18n/SERVER-TEXTFLUESSE.md",
    ],
    description:
      "HTTP-/SSE-Grenzen lokalisieren nur bekannte eigene Fehler/Status-/Diagnosefelder. Codes, Revisionen, Pfade, Ausgaben und Modellinhalte werden als Daten bewahrt. Unbekannte interne HTTP-Fehler werden durch sichere generische Meldungen ersetzt.",
    tests: ["tests/i18n-api.test.js", "tests/i18n-runner-messages.test.js"],
  },
  {
    id: "C-runner-output",
    sources: [
      "runner/common.js",
      "runner/programs.js",
      "runner/jobs.js",
      "server/services/messageOutput.js",
      "docs/i18n/SERVER-TEXTFLUESSE.md",
    ],
    description:
      "Runner liefert Descriptormetadaten ohne i18next-Abhängigkeit. systemMessages bleiben vom originalen output getrennt, Fortschritt von Paketlogs. Typisierte Trace-/Gradingmarker besitzen eigene Herkunft; gleichlautende Nutzerwerte bleiben Originaldaten.",
    tests: ["tests/i18n-runner-messages.test.js", "tests/i18n-api.test.js"],
  },
];
function boundaryContract(boundary) {
  const file = boundary.file.split("::")[0];
  if (/^tests\//.test(file))
    return {
      category: "fixture",
      contract: null,
      basis: "Test-/SDK-/Browserfixture mit absichtlich dynamischen Testdaten.",
    };
  if (
    /^(?:scripts|docker|tools)\//.test(file) ||
    /\.(?:sh|ps1|bat)$/.test(file) ||
    ["server/index.js", "server/config.js"].includes(file)
  )
    return {
      category: "operations",
      contract: null,
      basis:
        "Explizite Betreiber-/Audit-/Installationsstufe; keine behauptete Produktübersetzung.",
    };
  if (file.startsWith("public/"))
    return {
      category: "original",
      contract: "C-browser",
      basis:
        "Dynamischer UI-Ausgabewert; originale Daten versus explizite Übersetzungs-/Descriptormetadaten werden am genannten Verbraucher getrennt.",
    };
  if (file.startsWith("runner/"))
    return {
      category: "original",
      contract: "C-runner-output",
      basis:
        "Dynamischer Prozess-/Paket-/Fehlerwert; eigene Ergänzungen benötigen den expliziten Runnerdescriptorvertrag.",
    };
  if (
    /^server\/services\/context\//.test(file) ||
    [
      "server/services/teacher.js",
      "server/services/openAIContext.js",
      "server/services/profileManager.js",
    ].includes(file)
  )
    return {
      category: "original",
      contract: "C-original-history",
      basis:
        "Dynamische Historie/SDK-/Profil-/Kontextdaten; sichtbare eigene Wrapper haben gesonderte Descriptormetadaten.",
    };
  if (file.startsWith("server/"))
    return {
      category: "original",
      contract: "C-server-output",
      basis:
        "Dynamische Anfrage-/Datei-/Providerdaten; Ausgabe-/Herkunftsvertrag des expliziten HTTP-/Featureverbrauchers gilt.",
    };
  return {
    category: null,
    contract: null,
    basis: "Dynamische Grenze ohne überprüften Ausgabe-/Herkunftsvertrag.",
  };
}
const boundaryAssignments = coverage.runtimeBoundaries.map((boundary) => {
  const model = modelFor(boundary.file);
  const line = model?.source.split(/\r?\n/)[boundary.line - 1]?.trim() || "";
  const start =
    model?.source
      .split(/(?<=\n)/)
      .slice(0, boundary.line - 1)
      .join("").length || 0;
  const enclosing = model?.nodes
    ?.filter(
      (node) =>
        /Function|Method/.test(node.type) &&
        node.start <= start &&
        node.end >= start,
    )
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  const consumers = new Set();
  if (enclosing)
    walk(enclosing, (node) => {
      if (node.type !== "CallExpression") return;
      const name = model.source.slice(node.callee.start, node.callee.end);
      if (
        /^(?:t|req\.t|translateMessage|localize\w+|modelHistory|profileToPromptText|displayProfileContext|errorPayload)$/.test(
          name,
        )
      )
        consumers.add(name);
    });
  const dataFields = (boundary.reasons || []).filter((reason) =>
    /runtime property (?:content|title|output|stdout|stderr|value|actual|expected|path|name|command|question|options|origin|file)$/.test(
      reason,
    ),
  );
  return {
    ...boundary,
    sourceExcerpt: line.slice(0, 400),
    enclosingFunction: enclosing
      ? enclosing.id?.name ||
        propertyName(enclosing.key) ||
        "anonymous callback"
      : null,
    observedConsumers: [...consumers].sort(),
    originalDataReasons: dataFields,
    ...boundaryContract(boundary),
    decision: boundary.analysisLimit
      ? "analysis-limit-unresolved"
      : "reviewed-runtime-contract",
    staticCompletenessClaim: false,
  };
});
for (const row of coverage.coverage.filter((item) => item.sha256)) {
  const model = modelFor(row.file);
  sourceChecks.push({
    file: row.file,
    auditSha256: row.sha256,
    currentSha256: model?.hash || null,
    status: model?.fresh ? "current" : "stale-or-missing",
  });
}
const countBy = (rows, key) =>
  Object.fromEntries(
    [...new Set(rows.map((row) => row[key] || "unresolved"))]
      .sort()
      .map((value) => [
        value,
        rows.filter((row) => (row[key] || "unresolved") === value).length,
      ]),
  );
const unresolved = literalAssignments.filter((row) => !row.category);
const output = {
  schemaVersion: 1,
  method:
    "Independent source/AST provenance review; no audit suppression or catalog text equality.",
  inputs: inputFiles.map((file) => ({ file, sha256: digest(read(file)) })),
  categories,
  summary: {
    literals: inventory.literals.length,
    findings: audit.findings.length,
    dynamicBoundaries: boundaryAssignments.length,
    literalCategories: countBy(literalAssignments, "category"),
    findingCategories: countBy(findingAssignments, "category"),
    unresolvedLiterals: unresolved.length,
    staleSources: sourceChecks.filter((row) => row.status !== "current").length,
    auditAcceptedFindings: audit.summary.acceptedFindings,
  },
  sourceChecks,
  contracts,
  literals: literalAssignments,
  findings: findingAssignments,
  runtimeBoundaries: boundaryAssignments,
};
fs.writeFileSync(
  path.join(root, "docs/i18n/zuordnung.json"),
  JSON.stringify(output, null, 2) + "\n",
);
const prose = `# Nachvollziehbare i18n-Inventarzuordnung\n\nDieser Bericht ergänzt den unveränderten Auditor. Er setzt keine \`config.exceptions\`, akzeptiert keine Befunde und behauptet keine statische Vollständigkeit dynamischen Codes. Die Referenzen verweisen auf Literal-IDs und originale Befundfingerprints in den drei Eingabedateien. **Textgleichheit mit einem Katalog ist kein Zuordnungskriterium.**\n\nErneuter Aufruf nach dem finalen Audit: \`node scripts/review-i18n.mjs\`. Die Ausgabe ist bei gleichen Eingaben und Quellen deterministisch. Quellhashabweichungen bleiben sichtbar und dürfen nicht als abgeschlossene aktuelle Quellprüfung ausgegeben werden.\n\n## Ergebnis\n\n- ${inventory.literals.length} Literalquellen, ${audit.findings.length} Befunde und ${boundaryAssignments.length} einzeln referenzierte dynamische Grenzen.\n- ${unresolved.length} Literalquellen ohne hinreichenden Herkunftsbeleg.\n- ${output.summary.staleSources} physische Quellen mit verändertem/fehlendem Quellhash gegenüber dem Audit.\n- Auditorannahmen, offene Befunde und angenommene Ausnahmen bleiben unverändert; akzeptierte Auditbefunde: ${audit.summary.acceptedFindings}.\n\n| Kategorie | Literale | Befunde |\n| --- | ---: | ---: |\n${Object.entries(
  categories,
)
  .map(
    ([id, label]) =>
      `| ${label} | ${output.summary.literalCategories[id] || 0} | ${output.summary.findingCategories[id] || 0} |`,
  )
  .join(
    "\n",
  )}\n| Ungeklärt | ${unresolved.length} | ${output.summary.findingCategories.unresolved || 0} |\n\n## Belegarten\n\nGebundene Fallbacks benötigen einen nachprüfbaren AST-Coowner: \`new AppError/RunnerError(message, status, code, {messageKey, params})\`, ein Objekt mit eigenem Textfeld und zugehörigem Descriptorschlüssel oder benachbarte Zuweisungen an dasselbe Objekt im selben Block. HTML verwendet die tatsächlichen \`data-i18n\`-/Attributbindungen. Statische technische Rollen, Vergleichswerte und explizite Vertragsfelder werden getrennt ausgewiesen. Produktkataloge werden anhand ihres Ressourcenpfads erfasst, nicht anhand gleicher Formulierungen.\n\nDynamische Grenzen behalten pro Senke Quelldatei, Zeile, Ausgabebeschreibung, Ursachenliste, Quellausschnitt und referenzierten Herkunftsvertrag. \`reviewed-runtime-contract\` bedeutet eine überprüfte Laufzeitgrenze, keinen statischen Beweis aller möglichen Werte. Die Grenzen stehen vollständig in [zuordnung.json](zuordnung.json). Generische UI-/API-Helfer dürfen sowohl übersetzte Anwendungstexte als auch Originaldaten transportieren.\n\nDie Inhalts-/Tutorverträge stehen in [INHALTE.md](INHALTE.md), die Server-/Runnerverbraucher in [SERVER-TEXTFLUESSE.md](SERVER-TEXTFLUESSE.md). Interne Prompt-/Snapshot-/Toolschemata werden nicht nachträglich in Modellhistorien übersetzt. Tests und optionale Betreiberstufe sind ausdrücklich getrennte Kategorien, keine stillen Ausnahmen.\n\n## Ungeklärte Quellen\n\nDie folgende Liste ist ein Arbeitsauftrag, keine pauschale Baseline. Für jede Stelle fehlt noch ein hinreichender Herkunfts-/Ausgabebeleg. Alle Einträge stehen mit vollständiger Literalreferenz im JSON.\n\n| Quelle | Literal | Ausschnitt |\n| --- | --- | --- |\n${unresolved
  .slice(0, 300)
  .map(
    (row) =>
      `| ${row.file}:${row.line} | ${row.literalId} | ${row.excerpt.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ").slice(0, 170)} |`,
  )
  .join(
    "\n",
  )}\n${unresolved.length > 300 ? `\nWeitere ${unresolved.length - 300} ungeklärte Quellen sind im JSON ausdrücklich enthalten.\n` : ""}`;
fs.writeFileSync(
  path.join(root, "docs/i18n/ZUORDNUNG.md"),
  `${prose.trimEnd()}\n`,
);
console.log(JSON.stringify(output.summary, null, 2));
if (sourceChecks.some((row) => row.status !== "current")) process.exitCode = 2;
else if (unresolved.length) process.exitCode = 1;
