import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse, parseFragment, serialize } from "parse5";
import * as css from "css-tree";
import {
  AppError,
  DATA_DIR,
  getWorkspacePath,
  serial,
  readJSON,
  writeJSON,
  validateSessionId,
  assertSessionWritable,
} from "./storage.js";
import { normalizePath, readFile } from "./workspace.js";
import { previewBridge } from "./previewBridge.js";
import { t } from "./i18n.js";

const TTL = 30 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const dataURL = (type, text) =>
  `data:${type};base64,${Buffer.from(text).toString("base64")}`;
const fail = (message, metadata = {}) => {
  throw new AppError(message, 400, "PREVIEW_UNSUPPORTED", metadata);
};
function localPath(from, reference) {
  let ref;
  try {
    ref = decodeURIComponent(reference);
  } catch {
    fail("Ungültige Ressourcenadresse.", {
      messageKey: "serverFeature:preview.invalidResource",
      params: {},
    });
  }
  if (
    !ref ||
    /[\\:#?\x00-\x20]/.test(ref) ||
    ref.startsWith("/") ||
    ref.split("/").includes("..")
  )
    fail(`Nur relative Ressourcen ohne Traversal sind erlaubt: ${reference}`, {
      messageKey: "serverFeature:preview.relativeResources",
      params: { reference },
    });
  return normalizePath(path.posix.join(path.posix.dirname(from), ref));
}
function imageURL(value) {
  return (
    /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;base64)?,/i.test(value) ||
    /^#[\w-]+$/.test(value)
  );
}

export async function buildPreview(entry, load) {
  const document = parse((await load(entry)).content, {
    sourceCodeLocationInfo: true,
  });
  const diagnostics = [],
    sources = [];
  const warn = (file, node, message, metadata = {}) => {
    if (diagnostics.length >= 200) return;
    diagnostics.push({
      file,
      line: node.sourceCodeLocation?.startLine || 1,
      message,
      ...metadata,
    });
  };
  function styles(text, file, context = "stylesheet") {
    let ast;
    try {
      ast = css.parse(text, {
        context,
        onParseError: (error) => {
          throw error;
        },
      });
    } catch {
      fail(`CSS konnte nicht aufbereitet werden: ${file}`, {
        messageKey: "serverFeature:preview.cssInvalid",
        params: { file },
      });
    }
    css.walk(ast, (node) => {
      if (node.type === "Atrule" && node.name.toLowerCase() === "import")
        fail(
          `CSS-@import wird nicht unterstützt: ${file}. Bitte mehrere lokale Stylesheets verlinken.`,
          { messageKey: "serverFeature:preview.cssImport", params: { file } },
        );
      if (node.type === "Url" && !imageURL(node.value))
        fail(
          `CSS-url() benötigt eine Bild-Daten-URL oder lokale SVG-ID: ${file}`,
          { messageKey: "serverFeature:preview.cssUrl", params: { file } },
        );
    });
    return css.generate(ast);
  }
  let nodeCount = 0;
  async function visit(parent, depth = 0) {
    if (depth > 100)
      fail("HTML-Verschachtelung zu tief (maximal 100 Ebenen).", {
        messageKey: "serverFeature:preview.htmlDepth",
        params: {},
      });
    for (const node of [...(parent.childNodes || [])]) {
      if (++nodeCount > 10000)
        fail("Zu viele HTML-Knoten (maximal 10.000).", {
          messageKey: "serverFeature:preview.htmlNodes",
          params: {},
        });
      const tag = node.tagName;
      if (!tag) continue;
      const attr = (name) => node.attrs?.find((a) => a.name === name)?.value;
      if (
        [
          "base",
          "iframe",
          "frame",
          "frameset",
          "object",
          "embed",
          "portal",
        ].includes(tag) ||
        (tag === "meta" && attr("http-equiv"))
      ) {
        warn(entry, node, `${tag} wird in der Vorschau entfernt.`, {
          messageKey: "serverFeature:preview.removedElement",
          params: { tag },
        });
        parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
        continue;
      }
      if (tag === "script") {
        if (sources.length >= 100)
          fail("Zu viele Skripte (maximal 100).", {
            messageKey: "serverFeature:preview.tooManyScripts",
            params: {},
          });
        if (
          attr("type") &&
          !["text/javascript", "application/javascript"].includes(
            attr("type").toLowerCase(),
          )
        )
          fail(
            "Nur klassische JavaScript-Skripte werden unterstützt; Module und Importmaps nicht.",
            { messageKey: "serverFeature:preview.classicScripts", params: {} },
          );
        const file = attr("src") ? localPath(entry, attr("src")) : entry;
        if (attr("src") && !/\.js$/i.test(file))
          fail("Lokale Skripte müssen .js-Dateien sein.", {
            messageKey: "serverFeature:preview.scriptExtension",
            params: {},
          });
        const line = attr("src")
          ? 1
          : node.sourceCodeLocation?.startTag?.endLine || 1;
        const code = attr("src")
          ? (await load(file)).content
          : node.childNodes.map((n) => n.value || "").join("");
        const url = dataURL(
          "text/javascript",
          `${"\n".repeat(line - 1)}${code}\n//# sourceURL=sterra-preview/${encodeURIComponent(file)}\n`,
        );
        sources.push({ file, url });
        node.attrs = [
          { name: "src", value: url },
          ...node.attrs.filter((a) => ["defer", "async"].includes(a.name)),
        ];
        node.childNodes = [];
      } else if (tag === "link") {
        if (attr("rel")?.toLowerCase() !== "stylesheet") {
          warn(entry, node, "Nur Stylesheet-Links werden unterstützt.", {
            messageKey: "serverFeature:preview.stylesheetLinks",
            params: {},
          });
          parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
          continue;
        }
        const file = localPath(entry, attr("href") || "");
        if (!/\.css$/i.test(file))
          fail("Stylesheets müssen .css-Dateien sein.", {
            messageKey: "serverFeature:preview.stylesheetExtension",
            params: {},
          });
        const text = styles((await load(file)).content, file);
        node.attrs = [
          { name: "rel", value: "stylesheet" },
          { name: "href", value: dataURL("text/css", text) },
          ...node.attrs.filter((a) => a.name === "media"),
        ];
      } else if (tag === "style") {
        const text = styles(
          node.childNodes.map((n) => n.value || "").join(""),
          entry,
        );
        // Serialization of raw-text elements must never introduce a closing tag.
        node.childNodes = [
          {
            nodeName: "#text",
            value: text.replace(/</g, "\\3c "),
            parentNode: node,
          },
        ];
      }
      node.attrs = (node.attrs || []).filter((a) => {
        if (
          a.name.startsWith("on") ||
          [
            "srcdoc",
            "srcset",
            "ping",
            "action",
            "formaction",
            "target",
            "download",
            "nonce",
            "integrity",
          ].includes(a.name)
        ) {
          warn(
            entry,
            node,
            `Attribut ${a.name} wird nicht unterstützt; DOM-Ereignisse mit addEventListener anbinden.`,
            {
              messageKey: "serverFeature:preview.unsupportedAttribute",
              params: { name: a.name },
            },
          );
          return false;
        }
        if (a.name === "style")
          a.value = styles(a.value, entry, "declarationList");
        if (
          ["src", "href", "poster", "data", "background"].includes(a.name) &&
          !["script", "link"].includes(tag)
        ) {
          if (!imageURL(a.value)) {
            warn(
              entry,
              node,
              `Ressource/Navigation entfernt: ${a.value.slice(0, 120)}. Unterstützt werden Bild-Daten-URLs und SVG-IDs.`,
              {
                messageKey: "serverFeature:preview.removedResource",
                params: { reference: a.value.slice(0, 120) },
              },
            );
            return false;
          }
        }
        return true;
      });
      await visit(node, depth + 1);
      if (node.content) await visit(node.content, depth + 1);
    }
  }
  await visit(document);
  return { html: serialize(document), sources, diagnostics };
}

function directory(sessionId) {
  return path.join(DATA_DIR, "previews", validateSessionId(sessionId));
}
function publicRun(run) {
  return {
    previewRunId: run.previewRunId,
    renderId: run.renderId,
    entry: run.entry,
    createdAt: run.createdAt,
    expiresAt: run.expiresAt,
    status: Date.now() >= run.expiresAt ? "expired" : "ready",
    manifest: run.manifest,
    diagnostics: run.diagnostics,
  };
}
export async function startPreview(sessionId, body) {
  await getWorkspacePath(sessionId);
  const entry = normalizePath(body.entry);
  if (!/\.html?$/i.test(entry))
    fail("Bitte eine HTML-Einstiegsdatei auswählen.", {
      messageKey: "serverFeature:preview.selectHtml",
      params: {},
    });
  const expected = body.expectedVersions;
  if (
    !expected ||
    typeof expected !== "object" ||
    Array.isArray(expected) ||
    !Object.hasOwn(expected, entry) ||
    Object.keys(expected).length > 50
  )
    throw new AppError(
      "Erwartete Dateiversionen (maximal 50) erforderlich.",
      undefined,
      undefined,
      { messageKey: "serverFeature:preview.expectedVersions", params: {} },
    );
  for (const [file, version] of Object.entries(expected)) {
    normalizePath(file);
    if (!/^[a-f0-9]{64}$/.test(version))
      throw new AppError("Ungültige Dateiversion.", undefined, undefined, {
        messageKey: "serverFeature:preview.invalidVersion",
        params: {},
      });
  }
  return serial(`preview:${sessionId}`, async () => {
    await assertSessionWritable(sessionId);
    const dir = directory(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const names = await fs.readdir(dir);
    const records = [];
    for (const name of names.filter((n) => /^[a-f0-9-]+\.json$/.test(n))) {
      const record = await readJSON(path.join(dir, name));
      if (Date.now() >= record.expiresAt)
        await fs.rm(path.join(dir, name), { force: true });
      else records.push(record);
    }
    const built = await serial(`workspace:${sessionId}`, async () => {
      await assertSessionWritable(sessionId);
      const files = new Map();
      let bytes = 0;
      const load = async (file) => {
        if (files.has(file)) return files.get(file);
        if (!Object.hasOwn(expected, file))
          throw new AppError(
            `Dateiversion fehlt: ${file}. Bitte speichern und erneut laden.`,
            409,
            "CONFLICT",
            {
              messageKey: "serverFeature:preview.versionMissing",
              params: { file },
            },
          );
        const source = await readFile(sessionId, file);
        if (source.version !== expected[file])
          throw new AppError(`Dateistand geändert: ${file}`, 409, "CONFLICT", {
            messageKey: "serverFeature:preview.fileChanged",
            params: { file },
          });
        bytes += Buffer.byteLength(source.content);
        if (bytes > MAX_BYTES || files.size >= 50)
          throw new AppError(
            "Vorschau zu groß (50 Dateien / 2 MiB).",
            413,
            undefined,
            { messageKey: "serverFeature:preview.tooLarge", params: {} },
          );
        files.set(file, source);
        return source;
      };
      const result = await buildPreview(entry, load);
      for (const f of files.values())
        if ((await readFile(sessionId, f.path)).version !== f.version)
          throw new AppError(
            "Dateien während der Erfassung geändert.",
            409,
            "CONFLICT",
            { messageKey: "serverFeature:preview.filesChanged", params: {} },
          );
      return {
        ...result,
        manifest: [...files.values()].map(({ path, version }) => ({
          path,
          version,
        })),
      };
    });
    const run = {
      ...built,
      previewRunId: randomUUID(),
      renderId: randomUUID(),
      entry,
      createdAt: Date.now(),
      expiresAt: Date.now() + TTL,
    };
    if (Buffer.byteLength(JSON.stringify(run)) > MAX_BYTES * 4)
      throw new AppError("Aufbereitete Vorschau zu groß.", 413, undefined, {
        messageKey: "serverFeature:preview.preparedTooLarge",
        params: {},
      });
    for (const old of records
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(9))
      await fs.rm(path.join(dir, `${old.previewRunId}.json`), { force: true });
    await assertSessionWritable(sessionId);
    await writeJSON(path.join(dir, `${run.previewRunId}.json`), run);
    return publicRun(run);
  });
}
async function loadRun(sessionId, id) {
  await getWorkspacePath(sessionId);
  validateSessionId(id);
  try {
    return await readJSON(path.join(directory(sessionId), `${id}.json`));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new AppError(
        "Vorschau fehlt oder wurde bereits aufgeräumt.",
        404,
        "NOT_FOUND",
        { messageKey: "serverFeature:preview.notFound", params: {} },
      );
    throw error;
  }
}
export async function getPreview(sessionId, id) {
  const run = publicRun(await loadRun(sessionId, id));
  const changedFiles = [];
  for (const file of run.manifest) {
    try {
      if ((await readFile(sessionId, file.path)).version !== file.version)
        changedFiles.push(file.path);
    } catch (error) {
      if (
        !["NOT_FOUND", "TEXT_REQUIRED", "PATH_DENIED", "ENOENT"].includes(
          error.code,
        )
      )
        throw error;
      changedFiles.push(file.path);
    }
  }
  return { ...run, stale: changedFiles.length > 0, changedFiles };
}

export async function prunePreviews() {
  const root = path.join(DATA_DIR, "previews");
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    await serial(`preview:${entry.name}`, async () => {
      const dir = path.join(root, entry.name);
      for (const name of await fs.readdir(dir).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const file = path.join(dir, name);
        const run = await readJSON(file);
        if (Date.now() >= run.expiresAt) await fs.rm(file, { force: true });
      }
    });
  }
}
export async function previewDocument(sessionId, id, origin, locale = "de") {
  const run = await loadRun(sessionId, id);
  if (Date.now() >= run.expiresAt)
    throw new AppError(
      "Vorschau abgelaufen. Bitte neu laden.",
      410,
      "PREVIEW_EXPIRED",
      { messageKey: "serverFeature:preview.expired", params: {} },
    );
  const document = parse(run.html);
  const head = document.childNodes
    .find((n) => n.tagName === "html")
    .childNodes.find((n) => n.tagName === "head");
  const messages = Object.fromEntries(
    [
      "suppressed",
      "unserializable",
      "resourceFailed",
      "navigationUnsupported",
    ].map((key) => [key, t(locale, `serverFeature:preview.${key}`)]),
  );
  const code = `(${previewBridge.toString()})(${JSON.stringify({ previewRunId: run.previewRunId, renderId: run.renderId, sources: run.sources, origin, messages })});`;
  const script = parseFragment(
    `<script src="${dataURL("text/javascript", code)}"></script>`,
  ).childNodes[0];
  script.parentNode = head;
  head.childNodes.unshift(script);
  return serialize(document);
}
export function previewHeaders(origin) {
  return {
    "Content-Security-Policy": `default-src 'none'; script-src data:; style-src 'unsafe-inline' data:; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}; sandbox allow-scripts`,
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(), display-capture=()",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
}
