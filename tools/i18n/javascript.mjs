import path from "node:path";
import { parsers } from "prettier/plugins/babel";
import { area, technicalShape } from "./model.mjs";

const skipped = new Set([
  "loc",
  "extra",
  "comments",
  "tokens",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);
const functionTypes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);
const memberTypes = new Set(["MemberExpression", "OptionalMemberExpression"]);
const callTypes = new Set([
  "CallExpression",
  "OptionalCallExpression",
  "NewExpression",
]);
const keyName = (node) => node?.name ?? node?.value ?? null;
export function callName(node) {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (memberTypes.has(node.type))
    return `${callName(node.object)}.${keyName(node.property) ?? "*"}`;
  if (callTypes.has(node.type)) return `${callName(node.callee)}()`;
  if (node.type === "ThisExpression") return "this";
  return "";
}
function children(node) {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (skipped.has(key)) continue;
    if (Array.isArray(value))
      for (const item of value) {
        if (item?.type) out.push(item);
      }
    else if (value?.type) out.push(value);
  }
  return out;
}
function walk(node, callback, ancestors = []) {
  if (!node?.type) return;
  callback(node, ancestors);
  for (const child of children(node))
    walk(child, callback, [...ancestors, node]);
}
class Scope {
  constructor(parent = null, functionScope = false) {
    this.parent = parent;
    this.functionScope = functionScope;
    this.bindings = new Map();
  }
  find(name) {
    return this.bindings.get(name) ?? this.parent?.find(name);
  }
}

// Conservative, context-insensitive source-to-sink graph. Parameter values at
// different call sites are unioned; reports distinguish a possible static flow
// from execution proof. No audited application module is ever imported/run.
export class JavaScriptAudit {
  constructor(ctx) {
    this.ctx = ctx;
    this.graph = [];
    this.astNodes = new WeakMap();
    this.scopes = new WeakMap();
    this.parents = new WeakMap();
    this.ancestors = new WeakMap();
    this.functions = new Map();
    this.enclosingFunctions = new WeakMap();
    this.modules = new Map();
    this.calls = [];
    this.projections = new Map();
    this.writes = [];
    this.embedded = [];
    this.currentFile = null;
    this.builtModules = new Set();
    this.depthLimitHits = 0;
  }
  node(label, extra = {}) {
    const id = this.graph.length;
    this.graph.push({
      id,
      label,
      deps: new Set(),
      props: new Map(),
      functions: new Set(),
      ...extra,
    });
    return id;
  }
  edge(id, dependency) {
    if (
      dependency === undefined ||
      dependency === null ||
      id === dependency ||
      this.graph[id].deps.has(dependency)
    )
      return false;
    this.graph[id].deps.add(dependency);
    return true;
  }
  expr(ast) {
    if (!ast) return this.node("missing", { unknown: "missing-expression" });
    if (!this.astNodes.has(ast))
      this.astNodes.set(ast, this.node(ast.type, { ast }));
    return this.astNodes.get(ast);
  }
  project(base, key) {
    const cacheKey = `${base}:${key}`;
    if (!this.projections.has(cacheKey))
      this.projections.set(
        cacheKey,
        this.node(`property ${key}`, { access: { base, key: String(key) } }),
      );
    return this.projections.get(cacheKey);
  }
  binding(scope, name) {
    if (!scope.bindings.has(name))
      scope.bindings.set(name, this.node(`binding ${name}`));
    return scope.bindings.get(name);
  }
  declare(pattern, scope) {
    if (!pattern) return;
    if (pattern.type === "Identifier") this.binding(scope, pattern.name);
    else if (pattern.type === "AssignmentPattern")
      this.declare(pattern.left, scope);
    else if (pattern.type === "RestElement")
      this.declare(pattern.argument, scope);
    else if (pattern.type === "ObjectPattern")
      for (const prop of pattern.properties)
        this.declare(prop.value || prop.argument, scope);
    else if (pattern.type === "ArrayPattern")
      for (const item of pattern.elements) this.declare(item, scope);
  }
  assign(pattern, value, scope) {
    if (!pattern) return;
    if (pattern.type === "Identifier")
      this.edge(
        scope.find(pattern.name) ?? this.binding(scope, pattern.name),
        value,
      );
    else if (pattern.type === "AssignmentPattern") {
      this.assign(pattern.left, value, scope);
      this.assign(pattern.left, this.expr(pattern.right), scope);
    } else if (pattern.type === "ObjectPattern") {
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement")
          this.assign(prop.argument, value, scope);
        else
          this.assign(
            prop.value,
            this.project(value, keyName(prop.key) ?? "*"),
            scope,
          );
      }
    } else if (pattern.type === "ArrayPattern") {
      pattern.elements.forEach((item, index) =>
        this.assign(item, this.project(value, String(index)), scope),
      );
    } else if (pattern.type === "RestElement")
      this.assign(pattern.argument, this.project(value, "*"), scope);
    else if (memberTypes.has(pattern.type))
      this.writes.push({
        base: this.expr(pattern.object),
        key:
          !pattern.computed ||
          pattern.property.type === "StringLiteral" ||
          pattern.property.type === "NumericLiteral"
            ? keyName(pattern.property)
            : "*",
        value,
      });
  }
  async parse(input) {
    const ast = await parsers.babel.parse(input.source);
    const module = {
      ...input,
      ast,
      scope: new Scope(null, true),
      exports: new Map(),
      imports: [],
      declarations: [],
    };
    this.modules.set(input.file, module);
    const scan = (node, scope, enclosingFunction = null, ancestors = []) => {
      const parent = ancestors.at(-1);
      if (node.type === "FunctionDeclaration" && node.id)
        this.binding(scope, node.id.name);
      if (node.type === "ClassDeclaration" && node.id)
        this.binding(scope, node.id.name);
      if (functionTypes.has(node.type)) {
        const outer = scope;
        scope = new Scope(scope, true);
        const definition = {
          ast: node,
          file: input.file,
          scope,
          params: [],
          returns: this.node(
            `return ${node.id?.name || keyName(node.key) || "anonymous"}`,
          ),
          name:
            node.id?.name ||
            keyName(node.key) ||
            (parent?.type === "VariableDeclarator" ? parent.id?.name : null) ||
            "anonymous",
        };
        this.functions.set(node, definition);
        this.graph[this.expr(node)].functions.add(node);
        if (node.id)
          this.graph[
            this.binding(
              node.type === "FunctionDeclaration" ? outer : scope,
              node.id.name,
            )
          ].functions.add(node);
        for (const parameter of node.params) {
          this.declare(parameter, scope);
          const root = this.node(`parameter ${definition.name}`, {
            parameter: true,
          });
          definition.params.push(root);
          this.assign(parameter, root, scope);
        }
        enclosingFunction = definition;
      } else if (
        [
          "BlockStatement",
          "CatchClause",
          "ForOfStatement",
          "ForInStatement",
          "ForStatement",
        ].includes(node.type)
      ) {
        scope = new Scope(scope);
        if (node.type === "CatchClause") this.declare(node.param, scope);
      }
      this.scopes.set(node, scope);
      this.parents.set(node, parent);
      this.ancestors.set(node, ancestors);
      this.enclosingFunctions.set(node, enclosingFunction);
      if (node.type === "VariableDeclarator") {
        let target = scope;
        if (parent?.kind === "var")
          while (target.parent && !target.functionScope) target = target.parent;
        this.declare(node.id, target);
      }
      if (node.type === "ImportDeclaration") {
        for (const specifier of node.specifiers) {
          const local = this.binding(scope, specifier.local.name);
          module.imports.push({
            source: node.source.value,
            imported:
              specifier.type === "ImportNamespaceSpecifier"
                ? "*"
                : specifier.type === "ImportDefaultSpecifier"
                  ? "default"
                  : keyName(specifier.imported),
            local,
          });
        }
      }
      module.declarations.push(node);
      for (const child of children(node))
        scan(child, scope, enclosingFunction, [...ancestors, node]);
    };
    scan(ast.program, module.scope);
    for (const statement of ast.program.body) {
      if (statement.type === "ExportNamedDeclaration") {
        const declaration = statement.declaration;
        if (declaration?.id?.name)
          module.exports.set(
            declaration.id.name,
            module.scope.find(declaration.id.name),
          );
        for (const item of declaration?.declarations || []) {
          if (item.id.type === "Identifier")
            module.exports.set(item.id.name, module.scope.find(item.id.name));
        }
        for (const specifier of statement.specifiers || []) {
          const local = keyName(specifier.local);
          if (statement.source) {
            const binding = this.node(`re-export ${local}`);
            module.imports.push({
              source: statement.source.value,
              imported: local,
              local: binding,
            });
            module.exports.set(keyName(specifier.exported), binding);
          } else
            module.exports.set(
              keyName(specifier.exported),
              module.scope.find(local),
            );
        }
      } else if (statement.type === "ExportDefaultDeclaration")
        module.exports.set("default", this.expr(statement.declaration));
    }
    for (const comment of ast.comments || [])
      this.ctx.literal({
        file: input.file,
        line: comment.loc.start.line,
        endLine: comment.loc.end.line,
        column: comment.loc.start.column + 1,
        start: comment.start,
        end: comment.end,
        kind: "js-comment",
        role: "comment",
        text: comment.value,
      });
    return module;
  }
  location(module, ast) {
    return {
      file: module.file,
      line: ast.loc?.start.line || 1,
      column: (ast.loc?.start.column || 0) + 1,
      expression: module.source.slice(ast.start, ast.end).slice(0, 400),
    };
  }
  addSink(module, ast, value, channel, description, fields = false) {
    const sink = {
      id: `S-${this.ctx.sinks.length + 1}`,
      ...this.location(module, ast),
      channel,
      description,
      fields,
      graphNode: value,
    };
    this.ctx.sinks.push(sink);
  }
  literalRole(module, node) {
    const ancestors = this.ancestors.get(node) || [];
    const parent = ancestors.at(-1);
    const propertyNames = ancestors
      .filter((value) => value.type === "ObjectProperty")
      .map((value) => String(keyName(value.key)));
    const declarator = ancestors.findLast(
      (value) => value.type === "VariableDeclarator",
    );
    const fn = this.enclosingFunctions.get(node);
    const owner = [fn?.name, declarator?.id?.name, ...propertyNames]
      .filter(Boolean)
      .join(".");
    let role = "value";
    const call = callTypes.has(parent?.type) ? callName(parent.callee) : "";
    const argument = call ? parent.arguments.indexOf(node) : -1;
    const tail = call.split(".").at(-1);
    const structuralArguments = {
      node: [0, 1],
      button: [1, 3],
      setButton: [0, 2],
      taskSection: [1],
      $: [0],
      "document.createElement": [0],
      "document.createElementNS": [0, 1],
      "document.getElementById": [0],
      createIcon: [0],
    };
    if (
      parent?.type.startsWith("Import") ||
      (parent?.source === node && parent?.type.startsWith("Export"))
    )
      role = "module-specifier";
    else if (
      memberTypes.has(parent?.type) &&
      parent.property === node &&
      parent.computed
    )
      role = "member-selector";
    else if ((structuralArguments[call] || []).includes(argument))
      role = "structural-argument";
    else if (
      [
        "querySelector",
        "querySelectorAll",
        "closest",
        "matches",
        "getAttribute",
        "removeAttribute",
      ].includes(tail) &&
      argument === 0
    )
      role = "structural-argument";
    else if (
      ["addEventListener", "removeEventListener"].includes(tail) &&
      argument === 0
    )
      role = "event-name";
    else if (
      ["on", "emit", "CustomEvent", "Event"].includes(call) &&
      argument === 0
    )
      role = "event-name";
    else if (/\.classList\.(?:add|remove|toggle|contains)$/.test(call))
      role = "css-class";
    else if (
      tail === "setAttribute" &&
      (argument === 0 ||
        (argument === 1 &&
          parent.arguments[0]?.type === "StringLiteral" &&
          !this.ctx.config.textAttributes.includes(parent.arguments[0].value)))
    )
      role = "structural-argument";
    else if (
      (parent?.type === "ObjectProperty" || parent?.type === "ObjectMethod") &&
      parent.key === node &&
      !parent.computed
    )
      role = "syntax-key";
    else if (
      /PROMPT|WRITE_RULE|RETRY_NUDGE|SYSTEM_RULE/i.test(owner) ||
      (module.file.endsWith("/tools.js") &&
        propertyNames.includes("description"))
    )
      role = "prompt";
    else if (propertyNames.some((name) => ["args", "expected"].includes(name)))
      role = "test-data";
    else if (
      propertyNames.at(-1) === "content" &&
      ancestors.some(
        (value) =>
          value.type === "ObjectProperty" && keyName(value.key) === "files",
      )
    )
      role = "generated-source";
    return { role, owner, propertyNames };
  }
  build(module) {
    if (this.builtModules.has(module.file)) return;
    this.builtModules.add(module.file);
    for (const ast of [...module.declarations].reverse()) {
      const graph = this.graph[this.expr(ast)];
      const scope = this.scopes.get(ast);
      const parent = this.parents.get(ast);
      if (["StringLiteral", "TemplateLiteral"].includes(ast.type)) {
        const details = this.literalRole(module, ast);
        const staticText =
          ast.type === "StringLiteral"
            ? ast.value
            : ast.quasis
                .map((part) => part.value.cooked ?? part.value.raw)
                .join("");
        const text =
          ast.type === "StringLiteral"
            ? ast.value
            : ast.quasis
                .map(
                  (part, index) =>
                    (part.value.cooked ?? part.value.raw) +
                    (ast.expressions[index]
                      ? `\${${module.source.slice(ast.expressions[index].start, ast.expressions[index].end)}}`
                      : ""),
                )
                .join("");
        const index = this.ctx.literal({
          ...this.location(module, ast),
          start: ast.start,
          end: ast.end,
          endLine: ast.loc.end.line,
          kind: ast.type === "StringLiteral" ? "js-string" : "js-template",
          text,
          staticText,
          role: details.role,
          owner: details.owner,
        });
        graph.origin = index;
        if (ast.type === "TemplateLiteral")
          for (const expression of ast.expressions)
            this.edge(graph.id, this.expr(expression));
        if (
          [
            "module-specifier",
            "syntax-key",
            "member-selector",
            "structural-argument",
            "event-name",
            "css-class",
          ].includes(details.role)
        )
          this.ctx.literals[index].disposition = "structural";
        if (details.role === "prompt")
          this.ctx.finding("CONTENT", index, {
            channel: "model-content",
            message:
              "Fest eingebauter Prompt-/Werkzeugtext; Sprache und Vertrag ausdrücklich zuordnen.",
          });
        if (
          details.role === "generated-source" ||
          /^\s*(?:<!doctype\s+html|<html\b)/i.test(staticText)
        )
          this.embedded.push({
            module,
            ast,
            index,
            code:
              ast.type === "StringLiteral"
                ? ast.value
                : ast.expressions.length === 0
                  ? staticText
                  : null,
            filename: this.embeddedFilename(ast),
          });
      } else if (ast.type === "Identifier") {
        const binding = scope.find(ast.name);
        if (binding !== undefined) this.edge(graph.id, binding);
        else if (!["undefined", "NaN", "Infinity"].includes(ast.name))
          graph.unknown = `runtime identifier ${ast.name}`;
      } else if (ast.type === "ObjectExpression") {
        const keys = this.node("object keys", { keyAsText: true });
        graph.props.set("@keys", keys);
        for (const property of ast.properties) {
          if (property.type === "SpreadElement")
            this.edge(graph.id, this.expr(property.argument));
          else {
            const key =
              !property.computed ||
              property.key.type === "StringLiteral" ||
              property.key.type === "NumericLiteral"
                ? String(keyName(property.key))
                : "*";
            const value =
              property.type === "ObjectMethod"
                ? this.expr(property)
                : this.expr(property.value);
            if (graph.props.has(key)) this.edge(graph.props.get(key), value);
            else graph.props.set(key, value);
            if (property.key.type === "StringLiteral")
              this.edge(keys, this.expr(property.key));
            else if (!property.computed && property.key.type === "Identifier") {
              const index = this.ctx.literal({
                ...this.location(module, property.key),
                kind: "js-property-name",
                role: "syntax-key",
                text: property.key.name,
                owner: "object-key",
                endLine: property.key.loc.end.line,
              });
              const keyNode = this.node(`key ${property.key.name}`, {
                origin: index,
              });
              this.ctx.literals[index].disposition = "structural";
              this.edge(keys, keyNode);
            }
          }
        }
      } else if (
        ast.type === "ObjectProperty" &&
        this.ctx.config.textProperties.includes(String(keyName(ast.key)))
      ) {
        this.addSink(
          module,
          ast,
          this.expr(ast.value),
          "schema-field",
          `field ${keyName(ast.key)}`,
        );
      } else if (ast.type === "ArrayExpression") {
        graph.array = true;
        const union = this.node("array element");
        graph.props.set("*", union);
        ast.elements.forEach((value, index) => {
          if (!value) return;
          const expression =
            value.type === "SpreadElement"
              ? this.project(this.expr(value.argument), "*")
              : this.expr(value);
          graph.props.set(String(index), expression);
          this.edge(union, expression);
        });
      } else if (memberTypes.has(ast.type)) {
        const key =
          !ast.computed ||
          ["StringLiteral", "NumericLiteral"].includes(ast.property.type)
            ? String(keyName(ast.property))
            : "*";
        this.edge(graph.id, this.project(this.expr(ast.object), key));
      } else if (ast.type === "VariableDeclarator" && ast.init)
        this.assign(ast.id, this.expr(ast.init), scope);
      else if (ast.type === "AssignmentExpression") {
        this.assign(ast.left, this.expr(ast.right), scope);
        this.edge(graph.id, this.expr(ast.right));
        if (ast.operator !== "=") this.edge(graph.id, this.expr(ast.left));
        if (memberTypes.has(ast.left.type)) {
          const property = String(keyName(ast.left.property));
          if (this.ctx.config.textAssignments.includes(property))
            this.addSink(
              module,
              ast,
              this.expr(ast.right),
              "ui",
              `assignment ${property}`,
            );
        }
      } else if (ast.type === "ConditionalExpression") {
        this.edge(graph.id, this.expr(ast.consequent));
        this.edge(graph.id, this.expr(ast.alternate));
      } else if (
        ast.type === "LogicalExpression" ||
        (ast.type === "BinaryExpression" && ast.operator === "+")
      ) {
        this.edge(graph.id, this.expr(ast.left));
        this.edge(graph.id, this.expr(ast.right));
      } else if (
        [
          "AwaitExpression",
          "TSAsExpression",
          "ChainExpression",
          "ParenthesizedExpression",
        ].includes(ast.type)
      )
        this.edge(graph.id, this.expr(ast.argument || ast.expression));
      else if (ast.type === "SequenceExpression")
        this.edge(graph.id, this.expr(ast.expressions.at(-1)));
      else if (ast.type === "ReturnStatement") {
        const fn = this.enclosingFunctions.get(ast);
        if (fn && ast.argument) this.edge(fn.returns, this.expr(ast.argument));
        const fallback =
          ast.argument?.type === "LogicalExpression"
            ? ast.argument.right
            : ast.argument;
        if (
          fn &&
          this.ctx.config.translationCalls.includes(fn.name) &&
          fallback?.type === "Identifier" &&
          fn.ast.params.some(
            (parameter) =>
              parameter.type === "Identifier" &&
              parameter.name === fallback.name,
          )
        )
          this.ctx.finding("KEY_FALLBACK", null, {
            ...this.location(module, ast),
            identity: `${fn.name}:${module.source.slice(ast.start, ast.end)}`,
            channel: "catalog",
            severity: "critical",
            text: module.source.slice(ast.start, ast.end),
            message:
              "Übersetzungshelfer gibt seinen Schlüssel als Anzeigefallback zurück.",
          });
      } else if (
        ast.type === "ForOfStatement" ||
        ast.type === "ForInStatement"
      ) {
        const pattern =
          ast.left.type === "VariableDeclaration"
            ? ast.left.declarations[0].id
            : ast.left;
        this.assign(
          pattern,
          this.project(
            this.expr(ast.right),
            ast.type === "ForOfStatement" ? "*" : "@keys",
          ),
          scope,
        );
      } else if (callTypes.has(ast.type))
        this.calls.push({
          ast,
          module,
          node: graph.id,
          callee: this.expr(ast.callee),
          args: ast.arguments.map((arg) =>
            this.expr(arg.type === "SpreadElement" ? arg.argument : arg),
          ),
          name: callName(ast.callee),
        });
      if (
        ast.type === "ArrowFunctionExpression" &&
        ast.body.type !== "BlockStatement"
      ) {
        const fn = this.functions.get(ast);
        this.edge(fn.returns, this.expr(ast.body));
        const fallback =
          ast.body.type === "LogicalExpression" ? ast.body.right : ast.body;
        if (
          this.ctx.config.translationCalls.includes(fn.name) &&
          fallback.type === "Identifier" &&
          ast.params.some(
            (parameter) =>
              parameter.type === "Identifier" &&
              parameter.name === fallback.name,
          )
        )
          this.ctx.finding("KEY_FALLBACK", null, {
            ...this.location(module, ast),
            identity: `${fn.name}:${module.source.slice(ast.body.start, ast.body.end)}`,
            channel: "catalog",
            severity: "critical",
            text: module.source.slice(ast.body.start, ast.body.end),
            message:
              "Übersetzungshelfer gibt seinen Schlüssel als Anzeigefallback zurück.",
          });
      }
    }
  }
  embeddedFilename(ast) {
    for (const ancestor of [...(this.ancestors.get(ast) || [])].reverse()) {
      if (ancestor.type !== "ObjectExpression") continue;
      const field = ancestor.properties.find(
        (property) =>
          property.type === "ObjectProperty" &&
          keyName(property.key) === "path" &&
          property.value.type === "StringLiteral",
      );
      if (field) return field.value.value;
    }
    return "embedded.html";
  }
  linkImports() {
    for (const module of this.modules.values())
      for (const entry of module.imports) {
        if (!entry.source.startsWith(".")) {
          this.graph[entry.local].unknown = `external import ${entry.source}`;
          continue;
        }
        const base = path.posix.normalize(
          path.posix.join(path.posix.dirname(module.file), entry.source),
        );
        const target = [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`]
          .map((name) => this.modules.get(name))
          .find(Boolean);
        if (!target) {
          this.graph[entry.local].unknown = `unresolved import ${entry.source}`;
          continue;
        }
        if (entry.imported === "*")
          for (const [name, value] of target.exports) {
            if (value !== undefined)
              this.graph[entry.local].props.set(name, value);
          }
        else if (target.exports.has(entry.imported))
          this.edge(entry.local, target.exports.get(entry.imported));
        else
          this.graph[entry.local].unknown =
            `unresolved export ${entry.imported}`;
      }
  }
  shapes(id, seen = new Set(), depth = 0) {
    if (depth > this.ctx.config.maxPropertyDepth) {
      this.depthLimitHits++;
      return [];
    }
    if (seen.has(id)) return [];
    seen.add(id);
    const node = this.graph[id];
    const result = node.props.size ? [node] : [];
    for (const dependency of node.deps)
      result.push(...this.shapes(dependency, seen, depth + 1));
    return result;
  }
  callable(id, seen = new Set(), depth = 0) {
    if (depth > this.ctx.config.maxPropertyDepth) {
      this.depthLimitHits++;
      return new Set();
    }
    if (seen.has(id)) return new Set();
    seen.add(id);
    const result = new Set(this.graph[id].functions);
    for (const dependency of this.graph[id].deps)
      for (const fn of this.callable(dependency, seen, depth + 1))
        result.add(fn);
    return result;
  }
  setupCalls() {
    const cfg = this.ctx.config;
    for (const call of this.calls) {
      const { ast, module, name, args } = call;
      const tail = name.split(".").at(-1);
      if (/(?:^|\.)document\.create(?:Element|ElementNS|TextNode)$/.test(name))
        this.graph[call.node].opaqueDOM = true;
      for (const sink of cfg.sinks)
        if (sink.call === name || (!name.includes(".") && sink.call === tail))
          for (const index of sink.arguments) {
            if (args[index] !== undefined)
              this.addSink(
                module,
                ast,
                args[index],
                sink.channel,
                `${name} argument ${index + 1}`,
                sink.fields,
              );
          }
      if (
        name.startsWith("console.") ||
        /^process\.(?:stdout|stderr)\.write$/.test(name)
      )
        for (const argument of args)
          this.addSink(module, ast, argument, "console", name);
      if (
        tail === "setAttribute" &&
        cfg.textAttributes.includes(ast.arguments[0]?.value) &&
        args[1] !== undefined
      )
        this.addSink(
          module,
          ast,
          args[1],
          "accessibility",
          `attribute ${ast.arguments[0].value}`,
        );
      if (
        [
          "setCustomValidity",
          "insertAdjacentText",
          "insertAdjacentHTML",
        ].includes(tail) &&
        args.at(-1) !== undefined
      )
        this.addSink(module, ast, args.at(-1), "ui", tail);
      if (["append", "prepend", "replaceChildren"].includes(tail))
        for (const argument of args)
          this.addSink(module, ast, argument, "ui", tail);
      if (
        ["json", "send", "end", "write"].includes(tail) &&
        /^(?:res|response)\b/.test(name)
      )
        for (const argument of args)
          this.addSink(module, ast, argument, "api-payload", name, true);
      if (
        ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].includes(
          tail,
        ) ||
        /^Intl\./.test(name)
      ) {
        const locale = ast.arguments[0];
        if (locale?.type === "StringLiteral")
          this.ctx.finding(
            "FIXED_LOCALE",
            this.graph[this.expr(locale)].origin ?? null,
            {
              file: module.file,
              line: ast.loc.start.line,
              channel: "formatting",
              identity: name,
              severity: "warning",
              message:
                "Fest vorgegebene Format-Locale; interne Datumslogik von UI-Formatierung unterscheiden.",
            },
          );
      }
      if (
        cfg.translationCalls.includes(name) ||
        [...this.callable(call.callee)].some((ast) =>
          cfg.translationCalls.includes(this.functions.get(ast)?.name),
        )
      ) {
        call.localized = true;
        this.graph[call.node].localized = true;
        const binding = module.scope.find(name);
        const imported = module.imports.find(
          (entry) => entry.local === binding,
        );
        const importedFile = imported?.source.startsWith(".")
          ? path.posix.normalize(
              path.posix.join(path.posix.dirname(module.file), imported.source),
            )
          : imported?.source;
        const signature = (cfg.translationSignatures || []).find(
          (entry) =>
            entry.module === importedFile &&
            entry.export === imported?.imported,
        );
        const keyIndex = signature?.keyArgument ?? 0;
        const optionsIndex = signature?.optionsArgument ?? 1;
        const key = ast.arguments[keyIndex];
        const options = ast.arguments[optionsIndex];
        const ns =
          options?.type === "ObjectExpression"
            ? options.properties.find(
                (property) => keyName(property.key) === "ns",
              )?.value?.value
            : null;
        this.ctx.keyReferences.push({
          ...this.location(module, ast),
          key: key?.type === "StringLiteral" ? key.value : null,
          dynamic: key?.type !== "StringLiteral",
          namespace: ns,
          context:
            options?.type === "ObjectExpression"
              ? options.properties.find(
                  (property) => keyName(property.key) === "context",
                )?.value?.value
              : null,
          providedParameters: !options
            ? []
            : options.type === "ObjectExpression"
              ? options.properties
                  .filter((property) => property.type === "ObjectProperty")
                  .map((property) => String(keyName(property.key)))
              : null,
          argumentNode: args[keyIndex],
          optionsNode: args[optionsIndex],
        });
        if (key?.type === "StringLiteral") {
          const record = this.ctx.literals[this.graph[this.expr(key)].origin];
          if (record) {
            record.role = "translation-key";
            record.disposition = "localized-key";
          }
        }
        if (args[optionsIndex] !== undefined) {
          for (const field of [
            "defaultValue",
            "defaultValue_one",
            "defaultValue_other",
          ])
            this.edge(call.node, this.project(args[optionsIndex], field));
          if (options?.type === "ObjectExpression")
            for (const property of options.properties) {
              if (
                property.type === "ObjectProperty" &&
                ![
                  "ns",
                  "lng",
                  "count",
                  "ordinal",
                  "context",
                  "defaultValue",
                  "defaultValue_one",
                  "defaultValue_other",
                ].includes(keyName(property.key))
              )
                this.edge(call.node, this.expr(property.value));
            }
        }
      }
      if (["String", "JSON.stringify"].includes(name))
        for (const argument of args) this.edge(call.node, argument);
      if (memberTypes.has(ast.callee.type)) {
        call.base = this.expr(ast.callee.object);
        call.method = tail;
        if (["map", "flatMap"].includes(tail)) {
          this.graph[call.node].array = true;
          this.graph[call.node].props.set(
            "*",
            this.node(`${tail} result element`),
          );
        }
        if (
          [
            "trim",
            "trimStart",
            "trimEnd",
            "slice",
            "substring",
            "toUpperCase",
            "toLowerCase",
            "normalize",
            "toString",
          ].includes(tail)
        )
          this.edge(call.node, call.base);
        if (["replace", "replaceAll"].includes(tail)) {
          this.edge(call.node, call.base);
          if (args[1] !== undefined) this.edge(call.node, args[1]);
        }
        if (tail === "join") {
          this.edge(call.node, this.project(call.base, "*"));
          if (args[0] !== undefined) this.edge(call.node, args[0]);
        }
        if (tail === "concat") {
          this.edge(call.node, call.base);
          for (const argument of args) this.edge(call.node, argument);
        }
      }
      if (
        ast.type === "NewExpression" &&
        /(?:Error|Exception)$/.test(tail) &&
        args[0] !== undefined
      )
        this.graph[call.node].props.set("message", args[0]);
      if (
        ["Object.values", "Object.entries", "Object.keys"].includes(name) &&
        args[0] !== undefined
      ) {
        const element = this.node(`element of ${name}`);
        this.graph[call.node].props.set("*", element);
        if (name === "Object.values")
          this.edge(element, this.project(args[0], "*"));
        else if (name === "Object.keys")
          this.edge(element, this.project(args[0], "@keys"));
        else {
          this.graph[element].props.set("0", this.project(args[0], "@keys"));
          this.graph[element].props.set("1", this.project(args[0], "*"));
        }
      }
    }
  }
  connect() {
    let changed = false;
    for (const call of this.calls) {
      if (call.localized) continue;
      for (const ast of this.callable(call.callee)) {
        const fn = this.functions.get(ast);
        fn.params.forEach((parameter, index) => {
          if (call.args[index] !== undefined)
            changed = this.edge(parameter, call.args[index]) || changed;
        });
        changed = this.edge(call.node, fn.returns) || changed;
      }
      if (
        [
          "map",
          "flatMap",
          "forEach",
          "filter",
          "find",
          "findLast",
          "some",
          "every",
        ].includes(call.method) &&
        call.args[0] !== undefined
      ) {
        for (const ast of this.callable(call.args[0])) {
          const fn = this.functions.get(ast);
          if (fn.params[0] !== undefined)
            changed =
              this.edge(fn.params[0], this.project(call.base, "*")) || changed;
          if (["map", "flatMap"].includes(call.method)) {
            if (!this.graph[call.node].props.has("*")) {
              this.graph[call.node].props.set(
                "*",
                this.node(`${call.method} result element`),
              );
              changed = true;
            }
            const result =
              call.method === "flatMap" &&
              this.shapes(fn.returns).some((shape) => shape.array)
                ? this.project(fn.returns, "*")
                : fn.returns;
            changed =
              this.edge(this.graph[call.node].props.get("*"), result) ||
              changed;
          }
        }
        if (["find", "findLast"].includes(call.method))
          changed =
            this.edge(call.node, this.project(call.base, "*")) || changed;
        if (call.method === "filter")
          changed = this.edge(call.node, call.base) || changed;
      }
      if (
        ["entries", "values", "keys"].includes(call.method) &&
        !this.graph[call.node].props.has("*")
      ) {
        if (call.method === "entries") {
          const element = this.node("iterator entry");
          this.graph[element].props.set("1", this.project(call.base, "*"));
          this.graph[call.node].props.set("*", element);
        } else
          this.graph[call.node].props.set(
            "*",
            this.project(call.base, call.method === "keys" ? "@keys" : "*"),
          );
        changed = true;
      }
    }
    for (const write of this.writes) {
      const targets = this.shapes(write.base);
      for (const target of targets.length
        ? targets
        : [this.graph[write.base]]) {
        const key = String(write.key);
        if (!target.props.has(key)) {
          target.props.set(key, this.node(`written property ${key}`));
          changed = true;
        }
        changed = this.edge(target.props.get(key), write.value) || changed;
      }
    }
    for (const id of this.projections.values()) {
      const node = this.graph[id];
      const shapes = this.shapes(node.access.base);
      node.knownAbsent = shapes.length > 0;
      for (const shape of shapes) {
        if (node.access.key === "*")
          for (const [key, value] of shape.props) {
            if (key !== "@keys") changed = this.edge(id, value) || changed;
          }
        else if (shape.props.has(node.access.key))
          changed = this.edge(id, shape.props.get(node.access.key)) || changed;
        else if (shape.props.has("*"))
          changed = this.edge(id, shape.props.get("*")) || changed;
      }
    }
    return changed;
  }
  isDOM(id) {
    return this.domNodes.has(id);
  }
  trace(start, fields = false) {
    const origins = new Map();
    const dynamic = new Set();
    const seen = new Set();
    const stack = [[start, [], false, false]];
    let limited = false;
    while (stack.length) {
      const [id, chain, inheritedKey, inheritedUnion] = stack.pop();
      const visitKey = `${id}:${inheritedKey}:${inheritedUnion}`;
      if (seen.has(visitKey)) continue;
      seen.add(visitKey);
      if (seen.size > this.ctx.config.maxTraceNodes) {
        limited = true;
        break;
      }
      const node = this.graph[id];
      const callUnion = inheritedUnion || !!node.parameter;
      const keyAsText = inheritedKey || node.keyAsText;
      const next = [...chain.slice(-9), node.label];
      if (node.origin !== undefined) {
        const literal = this.ctx.literals[node.origin];
        if (
          !node.localized &&
          !["module-specifier", "translation-key", "member-selector"].includes(
            literal.role,
          ) &&
          (literal.role !== "syntax-key" || keyAsText) &&
          /\p{L}/u.test(literal.staticText ?? literal.text)
        )
          if (
            !origins.has(node.origin) ||
            (!callUnion && origins.get(node.origin).callUnion)
          )
            origins.set(node.origin, { chain: next, keyAsText, callUnion });
      }
      if (node.unknown) dynamic.add(node.unknown);
      if (node.parameter && !node.deps.size)
        dynamic.add(`runtime ${node.label}`);
      if (node.access && !node.deps.size && !node.knownAbsent)
        dynamic.add(`runtime property ${node.access.key}`);
      for (const dependency of node.deps)
        stack.push([dependency, next, keyAsText, callUnion]);
      if (!this.isDOM(id))
        for (const [key, value] of node.props)
          if (
            key !== "@keys" &&
            (!fields ||
              key === "*" ||
              this.ctx.config.textProperties.includes(key))
          )
            stack.push([value, next, keyAsText, callUnion]);
    }
    return { origins, dynamic, limited, visited: seen.size };
  }
  analyze() {
    this.linkImports();
    for (const module of this.modules.values()) this.build(module);
    this.setupCalls();
    let pass = 0;
    let converged = false;
    while (pass < this.ctx.config.maxGraphPasses) {
      pass++;
      if (!this.connect()) {
        converged = true;
        break;
      }
    }
    if (!converged)
      this.ctx.errors.push({
        type: "analysis-budget",
        message:
          "Dataflow graph did not converge within the configured pass limit.",
      });
    for (const call of this.calls) {
      const node = this.graph[call.node];
      if (
        !call.localized &&
        !node.deps.size &&
        !node.props.size &&
        !node.opaqueDOM
      )
        node.unknown = `unresolved call ${call.name || "computed callee"}`;
    }
    this.domNodes = new Set(
      this.graph.filter((node) => node.opaqueDOM).map((node) => node.id),
    );
    const reverse = new Map();
    for (const node of this.graph)
      for (const dep of node.deps) {
        if (!reverse.has(dep)) reverse.set(dep, []);
        reverse.get(dep).push(node.id);
      }
    const queue = [...this.domNodes];
    for (let index = 0; index < queue.length; index++)
      for (const dependent of reverse.get(queue[index]) || [])
        if (!this.domNodes.has(dependent)) {
          this.domNodes.add(dependent);
          queue.push(dependent);
        }
    for (const sink of this.ctx.sinks.filter(
      (value) => value.graphNode !== undefined,
    )) {
      const result = this.trace(sink.graphNode, sink.fields);
      sink.origins = [...result.origins.keys()].map(
        (index) => this.ctx.literals[index].id,
      );
      sink.resolution = result.limited
        ? "analysis-limit"
        : result.dynamic.size
          ? "partial-or-runtime-data"
          : "static";
      if (result.dynamic.size || result.limited)
        this.ctx.boundaries.push({
          sinkId: sink.id,
          file: sink.file,
          line: sink.line,
          description: sink.description,
          reasons: [...result.dynamic].sort(),
          analysisLimit: result.limited,
        });
      if (result.limited)
        this.ctx.errors.push({
          type: "analysis-budget",
          file: sink.file,
          line: sink.line,
          message: "Source trace exceeded configured node budget.",
        });
      for (const [origin, trace] of result.origins)
        this.ctx.direct(origin, sink.channel, {
          sinkId: sink.id,
          file: sink.file,
          line: sink.line,
          description: sink.description,
          keyUsedAsText: !!trace.keyAsText,
          certainty: trace.callUnion ? "possible-call-union" : "static-flow",
          chain: trace.chain.reverse(),
        });
      delete sink.graphNode;
    }
    for (const fn of this.functions.values()) {
      const outputSinks = this.ctx.sinks.filter(
        (sink) =>
          sink.file === fn.file &&
          sink.line >= fn.ast.loc.start.line &&
          sink.line <= fn.ast.loc.end.line &&
          sink.origins?.length,
      );
      if (outputSinks.length)
        this.ctx.helpers.push({
          file: fn.file,
          line: fn.ast.loc.start.line,
          name: fn.name,
          sinkCount: outputSinks.length,
          parameters: fn.ast.params.map(
            (parameter) => callName(parameter) || parameter.type,
          ),
        });
    }
    for (const literal of this.ctx.literals) {
      if (
        !literal.kind.startsWith("js-") ||
        literal.role === "comment" ||
        literal.disposition !== "unclassified-review"
      )
        continue;
      const technical = technicalShape(literal.staticText ?? literal.text);
      literal.disposition = technical
        ? "technical-shape-review"
        : "unresolved-literal-review";
      literal.technicalShape = technical;
    }
    if (this.depthLimitHits)
      this.ctx.errors.push({
        type: "analysis-budget",
        message: `Property/function resolution exceeded its depth budget (${this.depthLimitHits} hits).`,
      });
    return {
      passes: pass,
      graphNodes: this.graph.length,
      functions: this.functions.size,
      modules: this.modules.size,
      projections: this.projections.size,
      depthLimitHits: this.depthLimitHits,
    };
  }
}
