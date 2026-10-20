import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { auditProject, loadConfig } from "../tools/i18n/core.mjs";
import { writeReports } from "../tools/i18n/report.mjs";

const projects = [];
const hasPython = ["python", "python3"].some(
  (command) =>
    spawnSync(command, ["--version"], { timeout: 5000 }).status === 0,
);
const hasPowerShell = ["pwsh", "powershell.exe"].some(
  (command) =>
    spawnSync(
      command,
      ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
      { timeout: 5000 },
    ).status === 0,
);
async function project(files, options = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "sterracode-i18n-audit-"),
  );
  projects.push(root);
  for (const [file, source] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), source, "utf8");
  }
  const config = await loadConfig();
  Object.assign(config, options);
  return { root, config, scan: () => auditProject(root, { config }) };
}
afterEach(async () => {
  for (const root of projects.splice(0)) {
    if (
      path.dirname(root) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith("sterracode-i18n-audit-")
    )
      throw new Error("Unexpected temporary project path");
    await fs.rm(root, { recursive: true, force: true });
  }
});
const outputTexts = (report) =>
  new Set(
    report.findings
      .filter((finding) => finding.rule === "HARDCODED")
      .map((finding) => finding.text),
  );

describe("deep i18n source inventory and text flows", () => {
  it("resolves the imported server translator's explicit locale argument", async () => {
    const fixture = await project({
      "server/services/i18n.js":
        "export function t(locale,key,params){return key;}",
      "server/routes/example.js":
        'import {t} from "../services/i18n.js"; res.json({message:t("de","common:hello",{name:"Ada"})});',
      "shared/i18n/locales/de/common.json": '{"hello":"Hallo {{name}}"}',
      "shared/i18n/locales/en/common.json": '{"hello":"Hello {{name}}"}',
      "shared/i18n/locales/es/common.json": '{"hello":"Hola {{name}}"}',
    });
    const result = await fixture.scan();
    expect(result.keyReferences).toContainEqual(
      expect.objectContaining({
        file: "server/routes/example.js",
        key: "common:hello",
        providedParameters: ["name"],
      }),
    );
    expect(
      result.findings.filter((finding) =>
        ["MISSING_KEY", "CALL_PLACEHOLDERS"].includes(finding.rule),
      ),
    ).toEqual([]);
  });
  it("retains lowercase, one-character, empty, escaped and technical literals without a language filter", async () => {
    const fixture = await project({
      "public/app.js":
        'const a="x", b="", c="lowercase", d="SCHEMA_VALUE", e="Gr\\u00fcße"; /* Deutscher Kommentar */',
    });
    const result = await fixture.scan();
    expect(result.literals.map((literal) => literal.text)).toEqual(
      expect.arrayContaining([
        "x",
        "",
        "lowercase",
        "SCHEMA_VALUE",
        "Grüße",
        " Deutscher Kommentar ",
      ]),
    );
    expect(outputTexts(result).has(" Deutscher Kommentar ")).toBe(false);
    expect(result.summary.parseOrAnalysisErrors).toBe(0);
  });

  it("finds short lower-case UI words, both confirm arguments, and setButton's label argument", async () => {
    const fixture = await project({
      "public/app.js":
        'node("div","primary","go"); confirmDialog("Weiter", "Wirklich fortsetzen?"); setButton("save-btn","save", "save");',
    });
    const result = await fixture.scan();
    expect(outputTexts(result)).toEqual(
      new Set(["go", "Weiter", "Wirklich fortsetzen?", "save"]),
    );
    expect(outputTexts(result).has("save-btn")).toBe(false);
  });
  it("classifies known DOM selectors, tags, classes and event names structurally while retaining them", async () => {
    const fixture = await project({
      "public/app.js":
        'node("div","primary","Anzeige");el.addEventListener("click",handler);document.querySelector("button");el.classList.add("muted");',
    });
    const result = await fixture.scan();
    for (const text of ["div", "primary", "click", "button", "muted"]) {
      expect(
        result.literals.some(
          (literal) =>
            literal.text === text && literal.disposition === "structural",
        ),
      ).toBe(true);
      expect(
        result.findings.some(
          (finding) =>
            ["LITERAL_REVIEW", "PROSE_REVIEW"].includes(finding.rule) &&
            finding.text === text,
        ),
      ).toBe(false);
    }
    expect(outputTexts(result).has("Anzeige")).toBe(true);
  });

  it("does not clear an entire statement because one part uses a translation", async () => {
    const fixture = await project({
      "public/app.js": 'node("span", "", t("common:save") + " ohne Änderung");',
    });
    const result = await fixture.scan();
    expect(outputTexts(result).has(" ohne Änderung")).toBe(true);
    expect(outputTexts(result).has("common:save")).toBe(false);
  });

  it("traces aliases, imports, wrapper chains and local variables with evidence", async () => {
    const fixture = await project({
      "public/ui.js":
        "export function show(label) { element.textContent = label; }",
      "public/app.js":
        'import {show as say} from "./ui.js"; function wrap(value) { say(value); } const title="Guten Morgen"; wrap(title);',
    });
    const result = await fixture.scan();
    const finding = result.findings.find(
      (entry) => entry.text === "Guten Morgen" && entry.rule === "HARDCODED",
    );
    expect(
      finding?.evidence.some(
        (entry) =>
          entry.file === "public/ui.js" &&
          entry.certainty === "possible-call-union",
      ),
    ).toBe(true);
    expect(result.helpers.some((helper) => helper.name === "show")).toBe(true);
  });

  it("respects lexical shadowing instead of joining identically named variables", async () => {
    const fixture = await project({
      "public/app.js":
        'const label="Nicht angezeigt"; function show(){const label="Sichtbar"; element.textContent=label;} show();',
    });
    const result = await fixture.scan();
    expect(outputTexts(result).has("Sichtbar")).toBe(true);
    expect(outputTexts(result).has("Nicht angezeigt")).toBe(false);
  });

  it("selects label fields through array map, destructuring and for-of loops", async () => {
    const fixture = await project({
      "public/app.js":
        'const options=[["queued","Wartet"],["done","Listo"]].map(([value,label])=>({value,label}));for(const option of options){element.textContent=option.label;}',
    });
    const result = await fixture.scan();
    expect(outputTexts(result).has("Wartet")).toBe(true);
    expect(outputTexts(result).has("Listo")).toBe(true);
    expect(outputTexts(result).has("queued")).toBe(false);
    expect(outputTexts(result).has("done")).toBe(false);
  });
  it("includes all possible map callbacks rather than keeping only the first return", async () => {
    const fixture = await project({
      "public/app.js":
        'const callback=flag?()=>"Erste Beschriftung":()=>"Zweite Beschriftung";for(const label of [1].map(callback))el.textContent=label;',
    });
    const result = await fixture.scan();
    expect(outputTexts(result).has("Erste Beschriftung")).toBe(true);
    expect(outputTexts(result).has("Zweite Beschriftung")).toBe(true);
  });
  it("keeps flatMap row properties separate instead of flattening every field into an id", async () => {
    const fixture = await project({
      "public/app.js":
        'const rows=[["identifier","Überschrift","metadata"]];const entries=["python"].flatMap(language=>rows.map(([id,title,other])=>({id,title,other})));for(const entry of entries)el.textContent=entry.title;',
    });
    const result = await fixture.scan();
    expect(outputTexts(result).has("Überschrift")).toBe(true);
    expect(outputTexts(result).has("identifier")).toBe(false);
    expect(outputTexts(result).has("metadata")).toBe(false);
  });

  it("finds every branch of dynamic status maps and finite object key output", async () => {
    const fixture = await project({
      "public/app.js":
        'const labels={queued:"Wartet",done:"Listo"};element.textContent=labels[state];Object.keys({Speichern:1}).forEach(key=>other.textContent=key);',
    });
    const result = await fixture.scan();
    for (const text of ["Wartet", "Listo", "Speichern"])
      expect(outputTexts(result).has(text)).toBe(true);
  });

  it("does not confuse DOM tags/classes with the text of a DOM helper", async () => {
    const fixture = await project({
      "public/app.js":
        'function make(tag,cls,text){const element=document.createElement(tag);element.className=cls;element.textContent=text;return element;} host.append(make("span","muted","Fertig"));',
    });
    const result = await fixture.scan();
    expect(outputTexts(result).has("Fertig")).toBe(true);
    expect(outputTexts(result).has("muted")).toBe(false);
    expect(outputTexts(result).has("span")).toBe(false);
  });

  it("keeps both application and generic exception messages instead of excluding Error constructors", async () => {
    const fixture = await project({
      "server/test.js":
        'throw new AppError("Session fehlt."); throw new Error("Konfiguration beschädigt.");',
    });
    const result = await fixture.scan();
    expect(outputTexts(result).has("Session fehlt.")).toBe(true);
    expect(outputTexts(result).has("Konfiguration beschädigt.")).toBe(true);
  });

  it("finds template branches, concatenations, defaults and accessible attributes", async () => {
    const fixture = await project({
      "public/app.js":
        'function show({label="Standard"}={}){node("p","",label);} show({}); const value=`Status: ${ready ? "bereit" : "wartet"}`; el["textContent"]=value; el.setAttribute("aria-label","Schließen");',
    });
    const result = await fixture.scan();
    for (const text of ["Standard", "bereit", "wartet", "Schließen"])
      expect(outputTexts(result).has(text)).toBe(true);
    expect(outputTexts(result).has("aria-label")).toBe(false);
    expect(outputTexts(result).has("textContent")).toBe(false);
  });

  it("reports runtime boundaries and fixed formatting separately", async () => {
    const fixture = await project({
      "public/app.js":
        'el.textContent = await fetchValue(); date.toLocaleString("de-DE");',
    });
    const result = await fixture.scan();
    expect(
      result.findings.some(
        (entry) => entry.rule === "FIXED_LOCALE" && entry.text === "de-DE",
      ),
    ).toBe(true);
    expect(result.runtimeBoundaries.length).toBeGreaterThan(0);
  });

  it("keeps invariant branding visible with an explicit classification", async () => {
    const fixture = await project({
      "public/app.js": 'node("p","","OpenAI");node("p","","SPEICHERN");',
    });
    const result = await fixture.scan();
    expect(
      result.findings.some(
        (finding) =>
          finding.rule === "INVARIANT_DISPLAY" && finding.text === "OpenAI",
      ),
    ).toBe(true);
    expect(outputTexts(result).has("SPEICHERN")).toBe(true);
  });

  it("finds schema fields outside known UI calls without claiming a proven UI flow", async () => {
    const fixture = await project({
      "server/dataSource.js":
        'export const descriptor={help: enabled ? "Hilfe anzeigen" : "Keine Hilfe"};',
    });
    const result = await fixture.scan();
    expect(
      result.findings.some(
        (finding) =>
          finding.rule === "SCHEMA_TEXT" && finding.text === "Keine Hilfe",
      ),
    ).toBe(true);
    expect(outputTexts(result).has("Keine Hilfe")).toBe(false);
  });

  it("parses HTML, style content, inline JavaScript and bound defaults separately", async () => {
    const fixture = await project({
      "public/index.html":
        '<!doctype html><html lang="de"><body><!-- kein Text --><button aria-label="Öffnen">ok</button><p data-i18n="common:bound">Standard</p><style>.tip::after{content:"bitte warten"}</style><script>el.textContent="Inline-Ausgabe";</script></body></html>',
    });
    const result = await fixture.scan();
    for (const text of ["Öffnen", "ok", "bitte warten", "Inline-Ausgabe"])
      expect(outputTexts(result).has(text)).toBe(true);
    expect(outputTexts(result).has("Standard")).toBe(false);
    expect(outputTexts(result).has(" kein Text ")).toBe(false);
    expect(
      result.literals.some(
        (literal) =>
          literal.text === "Standard" &&
          literal.disposition === "localized-html-default",
      ),
    ).toBe(true);
  });

  it("parses materialized generated HTML templates without evaluating their module", async () => {
    const fixture = await project({
      "server/templates.js":
        'throw new Error("Do not execute");export const files=[{path:"index.html",content:"<!doctype html><html><body><button>Vorlagenknopf</button></body></html>"}];',
    });
    const result = await fixture.scan();
    expect(
      result.literals.some(
        (literal) =>
          literal.file.includes("::") && literal.text === "Vorlagenknopf",
      ),
    ).toBe(true);
    expect(
      result.coverage.some(
        (entry) =>
          entry.embedded && entry.originalFile === "server/templates.js",
      ),
    ).toBe(true);
  });
  it("parses static multiline template strings and records dynamic templates as an open boundary", async () => {
    const fixture = await project({
      "server/templates.js":
        'const files=[{path:"index.html",content:`<!doctype html>\n<html><body>Statische Vorlage</body></html>`},{path:"dynamic.html",content:`<html>${value}</html>`}];',
    });
    const result = await fixture.scan();
    expect(
      result.literals.some(
        (literal) =>
          literal.file.includes("::") && literal.text === "Statische Vorlage",
      ),
    ).toBe(true);
    expect(
      result.coverage.some(
        (entry) => entry.status === "dynamic-embedded-content",
      ),
    ).toBe(true);
  });

  it("uses a real YAML parser for block scalars and preserves JSON duplicate keys", async () => {
    const fixture = await project({
      "compose.yaml":
        "description: |\n  Erste Zeile\n  Zweite Zeile\n# nur Kommentar\n",
      "public/config.json": '{"title":"Erster Titel","title":"Zweiter Titel"}',
    });
    const result = await fixture.scan();
    expect(
      result.literals.some(
        (literal) => literal.text === "Erste Zeile\nZweite Zeile\n",
      ),
    ).toBe(true);
    expect(
      result.findings.some((finding) => finding.rule === "DUPLICATE_KEY"),
    ).toBe(true);
  });

  it("extracts shell multiline strings, unquoted output, heredocs and nested node -e source", async () => {
    const fixture = await project({
      "install.sh":
        "#!/usr/bin/env bash\necho fertig\nprintf 'Mehrzeilig\\nweiter'\nnode -e 'console.error(\"Eingebetteter Fehler\")'\ncat <<'HELP'\nHier steht die Hilfe\nHELP\n",
    });
    const result = await fixture.scan();
    expect(outputTexts(result).has("fertig")).toBe(true);
    expect(
      result.literals.some(
        (literal) =>
          literal.file.includes("::") &&
          literal.text === "Eingebetteter Fehler",
      ),
    ).toBe(true);
    expect(result.summary.lexicalFiles).toBe(1);
    expect(
      result.coverage.some((entry) =>
        entry.coverageNote?.includes("no complete language dataflow"),
      ),
    ).toBe(true);
  });
  it("does not call shell interpolation names or printf placeholders hardcoded prose", async () => {
    const fixture = await project({
      "install.sh":
        'echo "$variable"\nprintf "%s" "$other"\necho "Hallo $name"\n',
    });
    const result = await fixture.scan();
    expect(outputTexts(result).has("$variable")).toBe(false);
    expect(outputTexts(result).has("%s")).toBe(false);
    expect(outputTexts(result).has("Hallo $name")).toBe(true);
  });

  it.skipIf(!hasPython)(
    "uses the Python AST without executing supplied source",
    async () => {
      const fixture = await project({
        "runner/probe.py": 'raise ValueError("Python-Fehlermeldung")\n',
      });
      const result = await fixture.scan();
      expect(result.summary.parseOrAnalysisErrors).toBe(0);
      expect(outputTexts(result).has("Python-Fehlermeldung")).toBe(true);
    },
  );
  it.skipIf(!hasPowerShell)(
    "uses the PowerShell AST without executing supplied source",
    async () => {
      const fixture = await project({
        "install.ps1":
          'throw "PowerShell-Fehlermeldung"\nWrite-Host @"\nMehrzeilige Hilfe\n"@\n',
      });
      const result = await fixture.scan();
      expect(result.summary.parseOrAnalysisErrors).toBe(0);
      expect(outputTexts(result).has("PowerShell-Fehlermeldung")).toBe(true);
      expect(
        result.literals.some((literal) =>
          literal.text.includes("Mehrzeilige Hilfe"),
        ),
      ).toBe(true);
      expect(outputTexts(result).has("Write-Host")).toBe(false);
      expect(JSON.stringify((await fixture.scan()).literals)).toBe(
        JSON.stringify(result.literals),
      );
    },
  );

  it("scans safe untracked files but never data, .env, dependencies or secrets", async () => {
    const fixture = await project({
      "public/new.js": 'el.textContent="Neue Datei";',
      "server/data/private.js": '"PRIVATE_SECRET"',
      "node_modules/dependency/index.js": '"DEPENDENCY_SECRET"',
      ".env": "TOKEN=ENV_SECRET",
      "secrets/token.json": '"TOKEN_SECRET"',
    });
    const result = await fixture.scan();
    expect(outputTexts(result).has("Neue Datei")).toBe(true);
    expect(JSON.stringify(result.literals)).not.toMatch(
      /PRIVATE_SECRET|ENV_SECRET|TOKEN_SECRET|DEPENDENCY_SECRET/,
    );
  });

  it("reports malformed source and analysis budgets instead of silently falling back", async () => {
    const fixture = await project({
      "public/broken.js": 'const = "unvollständig"',
    });
    const result = await fixture.scan();
    expect(result.summary.parseOrAnalysisErrors).toBeGreaterThan(0);
    expect(
      result.coverage.find((entry) => entry.file === "public/broken.js").status,
    ).toBe("error");
    const limited = await project(
      { "public/large.js": 'const text="Hallo"; el.textContent=text;' },
      { maxTraceNodes: 1 },
    );
    expect(
      (await limited.scan()).errors.some(
        (entry) => entry.type === "analysis-budget",
      ),
    ).toBe(true);
  });
  it("allows convergence on the last configured graph pass and exposes property-depth exhaustion", async () => {
    const simple = await project(
      { "public/app.js": 'node("p","","Hallo");' },
      { maxGraphPasses: 1 },
    );
    expect((await simple.scan()).summary.parseOrAnalysisErrors).toBe(0);
    const deep = await project(
      {
        "public/app.js":
          'const a={label:"Hallo"};const b=a;const c=b;el.textContent=c.label;',
      },
      { maxPropertyDepth: 1 },
    );
    expect(
      (await deep.scan()).errors.some(
        (entry) => entry.type === "analysis-budget",
      ),
    ).toBe(true);
  });

  it("uses full-text, line-independent fingerprints and requires reasons for exceptions", async () => {
    const first = await project({
      "public/app.js": 'el.textContent="Stabiler Text";',
    });
    const before = await first.scan();
    await fs.writeFile(
      path.join(first.root, "public/app.js"),
      '\n\n// Kommentar\nel.textContent="Stabiler Text";',
      "utf8",
    );
    const after = await first.scan();
    const previous = before.findings.find(
      (entry) => entry.rule === "HARDCODED",
    );
    const current = after.findings.find((entry) => entry.rule === "HARDCODED");
    expect(current.fingerprint).toBe(previous.fingerprint);
    first.config.exceptions = [
      {
        fingerprint: current.fingerprint,
        reason: "Explicit diagnostic exception for this fixture",
      },
    ];
    expect(
      (await first.scan()).findings.find((entry) => entry.rule === "HARDCODED")
        .status,
    ).toBe("accepted");
    const configPath = path.join(first.root, "invalid-config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        ...first.config,
        exceptions: [{ fingerprint: current.fingerprint }],
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow("reason");
  });
  it("does not collide fingerprints for long texts sharing their first 120 characters", async () => {
    const prefix = "Langer gemeinsamer Text ".repeat(10);
    const fixture = await project({
      "public/app.js": `el.textContent=${JSON.stringify(prefix + "A")}; other.textContent=${JSON.stringify(prefix + "B")};`,
    });
    const result = await fixture.scan();
    const fingerprints = result.findings
      .filter((entry) => entry.rule === "HARDCODED")
      .map((entry) => entry.fingerprint);
    expect(new Set(fingerprints).size).toBe(2);
  });
  it("does not read source or write reports through directory links", async () => {
    const fixture = await project({
      "public/app.js": 'el.textContent="Sichtbarer Text";',
    });
    const outside = await project({ "private.js": '"LINK_TARGET_SECRET"' });
    await fs.symlink(
      outside.root,
      path.join(fixture.root, "server"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await fixture.scan();
    expect(JSON.stringify(result.literals)).not.toContain("LINK_TARGET_SECRET");
    expect(
      result.coverage.some((entry) => entry.reason === "symlink-not-followed"),
    ).toBe(true);
    await fs.symlink(
      outside.root,
      path.join(fixture.root, "linked-reports"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      writeReports(fixture.root, "linked-reports", result, null),
    ).rejects.toThrow("links");
    expect(await fs.readdir(outside.root)).toEqual(["private.js"]);
  });

  it("preserves findings and inventories in deterministic reports and protects output boundaries", async () => {
    const fixture = await project({
      "public/app.js": 'el.textContent="Prüfbericht \\n";',
    });
    const result = await fixture.scan();
    await writeReports(fixture.root, "reports/i18n", result, null);
    const first = await fs.readFile(
      path.join(fixture.root, "reports/i18n/literale.json"),
      "utf8",
    );
    expect(
      JSON.parse(first).literals.some(
        (literal) => literal.text === "Prüfbericht \n",
      ),
    ).toBe(true);
    const markdown = await fs.readFile(
      path.join(fixture.root, "reports/i18n/BERICHT.md"),
      "utf8",
    );
    expect(markdown).not.toMatch(/[ \t]+$/m);
    expect(markdown).toContain("␠");
    await writeReports(
      fixture.root,
      "reports/i18n",
      await fixture.scan(),
      null,
    );
    expect(
      await fs.readFile(
        path.join(fixture.root, "reports/i18n/literale.json"),
        "utf8",
      ),
    ).toBe(first);
    await expect(
      writeReports(fixture.root, "../outside", result, null),
    ).rejects.toThrow("inside");
  });
});

describe("catalog integrity and CLI gates", () => {
  async function catalogs(extra = {}) {
    return project({
      "public/app.js": 'el.textContent=t("common:save");',
      "public/locales/de/common.json":
        '{"save":"Speichern","files_one":"{{count}} Datei","files_other":"{{count}} Dateien"}',
      "public/locales/en/common.json":
        '{"save":"Save","files_one":"{{count}} file","files_other":"{{count}} files"}',
      "public/locales/es/common.json":
        '{"save":"Guardar","files_one":"{{count}} archivo","files_many":"{{count}} de archivos","files_other":"{{count}} archivos"}',
      ...extra,
    });
  }
  it("does not claim a parity pass before catalogs exist", async () => {
    const result = await (
      await project({ "public/app.js": 'node("p","","Hallo");' })
    ).scan();
    expect(result.catalogs.status).toBe("not-present");
  });
  it("does not treat translation-like test helpers or embedded test fixtures as live application consumers", async () => {
    const fixture = await project({
      "tests/helpers.js": 'const t=(value)=>value;t("fixture-data");',
      "public/app.js": 'node("p","","Hallo");',
    });
    const result = await fixture.scan();
    expect(result.catalogs.status).toBe("not-present");
    expect(
      result.findings.some((entry) => entry.rule === "CATALOGS_ABSENT"),
    ).toBe(false);
  });
  it("checks locale-specific plural forms without demanding identical key sets", async () => {
    const result = await (await catalogs()).scan();
    expect(
      result.findings.filter((entry) => entry.severity === "critical"),
    ).toEqual([]);
    expect(result.catalogs.status).toBe("checked");
  });
  it("treats catalog title/message values as resources and preserves category-specific placeholders", async () => {
    const fixture = await catalogs({
      "public/app.js": 'el.textContent=t("common:files", {count: 1});',
      "public/locales/de/common.json":
        '{"title":"Titel","files_one":"Eine Datei","files_other":"{{count}} Dateien"}',
      "public/locales/en/common.json":
        '{"title":"Title","files_one":"One file","files_other":"{{count}} files"}',
      "public/locales/es/common.json":
        '{"title":"Título","files_one":"Un archivo","files_many":"{{count}} de archivos","files_other":"{{count}} archivos"}',
    });
    const result = await fixture.scan();
    expect(
      result.findings.some((entry) =>
        ["CATALOG_PLACEHOLDERS", "SCHEMA_TEXT"].includes(entry.rule),
      ),
    ).toBe(false);
  });
  it("detects missing count and interpolation arguments at a translation call", async () => {
    const fixture = await catalogs({
      "public/app.js": 'el.textContent=t("common:files");',
    });
    const result = await fixture.scan();
    expect(
      result.findings.some((entry) => entry.rule === "PLURAL_COUNT_MISSING"),
    ).toBe(true);
    expect(
      result.findings.some((entry) => entry.rule === "CALL_PLACEHOLDERS"),
    ).toBe(true);
  });
  it("recognizes imported translation aliases while still detecting an inline default", async () => {
    const fixture = await catalogs({
      "public/i18n.js": "export function t(key){return translations[key];}",
      "public/app.js":
        'import {t as translate} from "./i18n.js";el.textContent=translate("common:save",{defaultValue:"Notfalltext"});',
    });
    const result = await fixture.scan();
    expect(outputTexts(result).has("common:save")).toBe(false);
    expect(outputTexts(result).has("Notfalltext")).toBe(true);
  });
  it("finds missing keys, missing Spanish many, placeholders and duplicated translations", async () => {
    const fixture = await catalogs({
      "public/locales/es/common.json":
        '{"save":"Save","files_one":"{{n}} archivo","files_other":"{{count}} archivos"}',
      "public/app.js": 'el.textContent=t("common:missing");',
    });
    const result = await fixture.scan();
    for (const rule of [
      "MISSING_KEY",
      "CATALOG_MISSING_KEY",
      "CATALOG_PLACEHOLDERS",
    ])
      expect(result.findings.some((entry) => entry.rule === rule)).toBe(true);
    expect(
      result.findings.some(
        (entry) =>
          entry.rule === "CATALOG_MISSING_KEY" && entry.text === "files_many",
      ),
    ).toBe(true);
  });
  it("does not prove keys unused in the presence of dynamic calls", async () => {
    const fixture = await catalogs({
      "public/app.js": "el.textContent=t(`common:${kind}`);",
    });
    const result = await fixture.scan();
    expect(result.findings.some((entry) => entry.rule === "DYNAMIC_KEY")).toBe(
      true,
    );
    expect(
      result.findings.find((entry) => entry.rule === "POSSIBLY_UNUSED_KEY")
        .message,
    ).toContain("dynamische");
  });
  it("reports helpers returning a raw key as fallback", async () => {
    const fixture = await catalogs({
      "public/app.js":
        'function t(key){return messages[key] || key;}el.textContent=t("common:save");',
    });
    expect(
      (await fixture.scan()).findings.some(
        (entry) => entry.rule === "KEY_FALLBACK",
      ),
    ).toBe(true);
  });
  it("also detects a key fallback in a named arrow helper", async () => {
    const fixture = await catalogs({
      "public/app.js":
        'const t=(key)=>messages[key] || key;el.textContent=t("common:save");',
    });
    expect(
      (await fixture.scan()).findings.some(
        (entry) => entry.rule === "KEY_FALLBACK",
      ),
    ).toBe(true);
  });
  it("uses distinct CLI exit codes for debt, parse failure and bad arguments", async () => {
    const fixture = await project({
      "public/app.js": 'el.textContent="Noch fest eingebaut";',
    });
    const cli = path.resolve("tools/i18n/audit.mjs");
    const run = (...args) =>
      spawnSync(
        process.execPath,
        [cli, "--root", fixture.root, "--no-report", ...args],
        { encoding: "utf8" },
      );
    expect(run().status).toBe(0);
    expect(run("--strict").status).toBe(1);
    expect(run("--only", "invalid-rule").status).toBe(2);
    await fs.writeFile(path.join(fixture.root, "public/app.js"), "const =");
    expect(run("--strict").status).toBe(2);
  });
});
