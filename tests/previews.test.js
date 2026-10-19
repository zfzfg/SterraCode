import { beforeAll, afterAll, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
let root, storage, workspace, session, previews;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-preview-"));
  process.env.STERRACODE_DATA_DIR = root;
  storage = await import("../server/services/storage.js");
  await storage.ensureDataDirs();
  session = await (
    await import("../server/services/sessions.js")
  ).createSession({ title: "Web", language: "javascript" });
  workspace = await import("../server/services/workspace.js");
  previews = await import("../server/services/previews.js");
});
afterAll(async () => {
  vi.restoreAllMocks();
  if (root?.startsWith(path.join(os.tmpdir(), "sterra-preview-")))
    await fs.rm(root, { recursive: true, force: true });
});
async function sources(files) {
  const expectedVersions = {};
  for (const [p, content] of Object.entries(files)) {
    let version = null;
    try {
      version = (await workspace.readFile(session.id, p)).version;
    } catch {}
    expectedVersions[p] = (
      await workspace.writeFile(session.id, p, content, version)
    ).version;
  }
  return { entry: "index.html", expectedVersions };
}
it("erfasst unveränderliche HTML/CSS/JS-Stände und sichere Raw-Text-Inhalte", async () => {
  const body = await sources({
    "index.html":
      '<link rel="stylesheet" href="./a.css"><link rel="stylesheet" href="b.css"><h1>Grüße</h1><script src="app.js"></script>',
    "a.css": "h1{color:red}",
    "b.css": 'body{background:url("data:image/png;base64,YQ==")}',
    "app.js": 'console.log("</script><h1>kein HTML</h1>");',
  });
  const run = await previews.startPreview(session.id, body);
  expect(run.manifest).toHaveLength(4);
  const document = await previews.previewDocument(
    session.id,
    run.previewRunId,
    "http://localhost:3000",
  );
  expect(document).toContain("Grüße");
  expect(document).not.toContain("kein HTML");
  expect(document).toContain("data:text/javascript;base64,");
  await workspace.writeFile(
    session.id,
    "index.html",
    "geändert",
    body.expectedVersions["index.html"],
  );
  expect((await previews.getPreview(session.id, run.previewRunId)).stale).toBe(
    true,
  );
  expect(
    await previews.previewDocument(
      session.id,
      run.previewRunId,
      "http://localhost:3000",
    ),
  ).toBe(document);
  await expect(previews.startPreview(session.id, body)).rejects.toMatchObject({
    status: 409,
  });
  const other = await (
    await import("../server/services/sessions.js")
  ).createSession({ title: "Fremd", language: "python" });
  await expect(
    previews.getPreview(other.id, run.previewRunId),
  ).rejects.toMatchObject({ status: 404 });
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60000);
  expect((await previews.getPreview(session.id, run.previewRunId)).status).toBe(
    "expired",
  );
  await expect(
    previews.previewDocument(
      session.id,
      run.previewRunId,
      "http://localhost:3000",
    ),
  ).rejects.toMatchObject({ status: 410 });
  vi.restoreAllMocks();
});
it("verwirft externe Ressourcen, Traversal, Module, CSS-Imports und fehlende Versionen", async () => {
  for (const html of [
    '<script src="../escape.js"></script>',
    '<script src="https://example.org/a.js"></script>',
    '<script src="%2e%2e/a.js"></script>',
    '<script type="module">import "./x.js"</script>',
    '<style>@import "x.css";</style>',
    "<style>p{background:url(https://example.org/x)}</style>",
  ]) {
    const body = await sources({ "index.html": html });
    await expect(previews.startPreview(session.id, body)).rejects.toMatchObject(
      { code: "PREVIEW_UNSUPPORTED" },
    );
  }
  await expect(
    previews.startPreview(
      session.id,
      await sources({ "index.html": '<script src="missing.js"></script>' }),
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it("entfernt Navigation und Einbettungen mit begrenzten Diagnosen und behält restriktive Header", async () => {
  const body = await sources({
    "index.html":
      '<meta http-equiv="refresh" content="0;url=https://example.org"><iframe src="https://example.org"></iframe><a href="https://example.org" onclick="alert(1)">Link</a><svg><circle r="3"/></svg>',
  });
  const run = await previews.startPreview(session.id, body);
  expect(run.diagnostics.length).toBeGreaterThan(0);
  const html = await previews.previewDocument(
    session.id,
    run.previewRunId,
    "http://localhost:3000",
  );
  expect(html).not.toContain("https://example.org");
  expect(html).toContain("<circle");
  const headers = previews.previewHeaders("http://localhost:3000");
  expect(headers["Content-Security-Policy"]).toContain("sandbox allow-scripts");
  expect(headers["Content-Security-Policy"]).not.toContain("allow-same-origin");
  expect(headers["Cache-Control"]).toBe("no-store");
});

it("begrenzt Aufbereitung, Aufbewahrung und Diagnose und räumt abgelaufene Läufe auf", async () => {
  let body = await sources({
    "index.html": '<a onclick="x()">x</a>'.repeat(300),
  });
  expect(
    (await previews.startPreview(session.id, body)).diagnostics,
  ).toHaveLength(200);
  body = await sources({
    "index.html": "<div>".repeat(110) + "Ende" + "</div>".repeat(110),
  });
  await expect(previews.startPreview(session.id, body)).rejects.toMatchObject({
    code: "PREVIEW_UNSUPPORTED",
  });
  body = await sources({
    "index.html": "<script>console.log(1)</script>".repeat(101),
  });
  await expect(previews.startPreview(session.id, body)).rejects.toMatchObject({
    code: "PREVIEW_UNSUPPORTED",
  });
  body = await sources({ "index.html": "<h1>Begrenzt</h1>" });
  const first = await previews.startPreview(session.id, body);
  for (let n = 0; n < 10; n++) await previews.startPreview(session.id, body);
  await expect(
    previews.getPreview(session.id, first.previewRunId),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    (await fs.readdir(path.join(root, "previews", session.id))).length,
  ).toBe(10);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60000);
  await previews.prunePreviews();
  expect(await fs.readdir(path.join(root, "previews", session.id))).toEqual([]);
  vi.restoreAllMocks();
});

it("liest keine Symlinks und verändert die Binärdatei-Grenze nicht", async () => {
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.js"), "console.log('secret')");
  const workspaceRoot = await storage.getWorkspacePath(session.id);
  await fs.symlink(
    outside,
    path.join(workspaceRoot, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const body = await sources({
    "index.html": '<script src="linked/secret.js"></script>',
  });
  body.expectedVersions["linked/secret.js"] = "a".repeat(64);
  await expect(previews.startPreview(session.id, body)).rejects.toMatchObject({
    code: "PATH_DENIED",
  });
  const binary = await sources({
    "index.html": '<script src="binary.js"></script>',
    "binary.js": "\0not text",
  });
  await expect(previews.startPreview(session.id, binary)).rejects.toMatchObject(
    { code: "TEXT_REQUIRED" },
  );
});

it("begrenzt die gesamten Quellbytes", async () => {
  const body = await sources({
    "index.html":
      '<script src="large-a.js"></script><script src="large-b.js"></script>',
    "large-a.js": " ".repeat(1024 * 1024),
    "large-b.js": " ".repeat(1024 * 1024),
  });
  await expect(previews.startPreview(session.id, body)).rejects.toMatchObject({
    status: 413,
  });
});

it("löscht Vorschauartefakte ohne umgekehrte Session-/Vorschau-Sperren", async () => {
  const sessions = await import("../server/services/sessions.js");
  const other = await sessions.createSession({
    title: "Vorschau löschen",
    language: "javascript",
  });
  const file = await workspace.writeFile(
    other.id,
    "index.html",
    "<h1>Test</h1>",
    null,
  );
  await previews.startPreview(other.id, {
    entry: "index.html",
    expectedVersions: { "index.html": file.version },
  });
  let release, entered;
  const started = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  const blocker = storage.serial(`preview:${other.id}`, async () => {
    entered();
    await gate;
  });
  await started;
  const deletion = sessions.removeSession(other.id);
  try {
    // Session deletion must release its own queue before waiting for a preview
    // which may itself need to read the session again.
    let removed = false;
    for (let n = 0; n < 100; n++) {
      removed = await fs
        .access(path.join(root, "sessions", `${other.id}.json`))
        .then(
          () => false,
          () => true,
        );
      if (removed) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(removed).toBe(true);
  } finally {
    release();
    await blocker;
    await deletion;
  }
  await expect(
    fs.access(path.join(root, "previews", other.id)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
