import { test, expect } from "@playwright/test";

async function project(page, request, script = "") {
  const session = await (
    await request.post("/api/sessions", {
      data: { title: "Webvorschau", language: "javascript" },
    })
  ).json();
  const base = `/api/workspaces/${session.id}`;
  for (const [path, content] of Object.entries({
    "index.html":
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><h1>Grüße</h1><button>Ändern</button><canvas width="20" height="20"></canvas><svg><circle r="5"/></svg><script src="app.js"></script>',
    "style.css": "h1{color:rgb(200, 10, 20)}",
    "app.js": `document.querySelector('button').addEventListener('click',()=>document.querySelector('h1').textContent='Geändert');\nconst ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,20,20);\nconsole.log('Hallo Vorschau');\n${script}`,
  }))
    expect(
      (await request.post(`${base}/files`, { data: { path, content } })).ok(),
    ).toBeTruthy();
  await request.patch(`/api/sessions/${session.id}`, {
    data: { activeFile: "index.html", openFiles: ["index.html"] },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Webvorschau", exact: true })
    .first()
    .click();
  await page.locator("#preview-open").click();
  await expect(page.locator(".preview-log")).toContainText("Hallo Vorschau");
  return base;
}
test("HTML, CSS, DOM, Canvas, SVG und Sandbox unter produktiver CSP", async ({
  page,
  request,
}) => {
  await project(
    page,
    request,
    `for(const [name,fn] of Object.entries({dom:()=>parent.document.body,cookie:()=>document.cookie,storage:()=>localStorage.getItem('x')})){try{fn();console.error(name+' offen')}catch{console.log(name+' gesperrt')}}
fetch('/api/sessions').then(()=>console.error('Netz offen')).catch(()=>console.log('Netz gesperrt'));
Promise.reject(new Error('Absichtlicher Fehler'));`,
  );
  const frame = page.frameLocator(".preview-frame-host iframe");
  await expect(frame.locator("h1")).toHaveCSS("color", "rgb(200, 10, 20)");
  expect(
    await frame
      .locator("canvas")
      .evaluate((c) =>
        Array.from(c.getContext("2d").getImageData(0, 0, 1, 1).data),
      ),
  ).toEqual([255, 0, 0, 255]);
  await expect(frame.locator("svg circle")).toHaveCount(1);
  await frame.getByRole("button").click();
  await expect(frame.locator("h1")).toHaveText("Geändert");
  for (const text of [
    "dom gesperrt",
    "cookie gesperrt",
    "storage gesperrt",
    "Netz gesperrt",
    "Absichtlicher Fehler",
  ])
    await expect(page.locator(".preview-log")).toContainText(text);
  await expect(page.locator(".preview-log")).toContainText("app.js:");
  const url = await page
    .locator(".preview-frame-host iframe")
    .getAttribute("src");
  const response = await request.get(url);
  expect(response.headers()["content-security-policy"]).toContain(
    "sandbox allow-scripts",
  );
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(
    (await request.get(url, { headers: { Origin: "null" } })).status(),
  ).toBe(403);
  const direct = await page.context().newPage();
  await direct.goto(url);
  expect(
    await direct.evaluate(() => {
      try {
        localStorage.getItem("x");
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  await direct.close();
});
test("fremde und alte Nachrichten, Logflut, Pause und neue Dateistände", async ({
  page,
  request,
}) => {
  const base = await project(page, request);
  const old = await page
    .locator(".preview-frame-host iframe")
    .getAttribute("src");
  const id = old.split("/").at(-2);
  const run = await (await request.get(`${base}/preview-runs/${id}`)).json();
  const message = {
    type: "preview-log",
    previewRunId: run.previewRunId,
    renderId: run.renderId,
    level: "log",
    text: "Fremdfenster",
    file: "app.js",
    line: 1,
  };
  await page.evaluate((d) => window.postMessage(d, "*"), message);
  await expect(page.locator(".preview-log")).not.toContainText("Fremdfenster");
  await page.getByLabel("Automatisch aktualisieren").uncheck();
  const file = await (
    await request.get(`${base}/files/content?path=style.css`)
  ).json();
  await request.put(`${base}/files/content`, {
    data: {
      path: "style.css",
      content: "h1{color:blue}",
      expectedVersion: file.version,
    },
  });
  await page.getByRole("button", { name: "Neu laden", exact: true }).click();
  await expect(
    page.frameLocator(".preview-frame-host iframe").locator("h1"),
  ).toHaveCSS("color", "rgb(0, 0, 255)");
  const actualFrame = page.frames().find((f) => f.url().includes("/document"));
  await actualFrame.evaluate((d) => parent.postMessage(d, "*"), {
    ...message,
    text: "Alter Renderlauf",
  });
  const currentId = actualFrame.url().split("/").at(-2);
  const current = await (
    await request.get(`${base}/preview-runs/${currentId}`)
  ).json();
  await actualFrame.evaluate((d) => parent.postMessage(d, "*"), {
    ...message,
    previewRunId: current.previewRunId,
    renderId: current.renderId,
    text: "x".repeat(2001),
  });
  await expect(page.locator(".preview-log")).not.toContainText("x".repeat(100));
  await actualFrame.evaluate((d) => parent.postMessage(d, "*"), {
    ...message,
    previewRunId: current.previewRunId,
    renderId: current.renderId,
    text: '<img src=x onerror="alert(1)">',
  });
  await expect(page.locator(".preview-log img")).toHaveCount(0);
  await expect(page.locator(".preview-log")).toContainText(
    '<img src=x onerror="alert(1)">',
  );
  await expect(page.locator(".preview-log")).not.toContainText(
    "Alter Renderlauf",
  );
  await actualFrame.evaluate(() => {
    for (let i = 0; i < 300; i++) console.log("Flut", i);
  });
  await expect(page.locator(".preview-log")).toContainText(
    "Weitere Meldungen zusammengefasst",
  );
  expect(await page.locator(".preview-message").count()).toBeLessThanOrEqual(
    200,
  );
});

test("Autosave, Pause, Quellnavigation und responsive Themes", async ({
  page,
  request,
}) => {
  await project(page, request);
  const html = page.frameLocator(".preview-frame-host iframe").locator("h1");
  const edit = async (text) =>
    page.evaluate((text) => {
      const model = monaco.editor
        .getModels()
        .find((m) => m.getValue().includes("<!doctype html>"));
      model.setValue(
        model.getValue().replace(/Grüße|Automatisch|Pausiert/g, text),
      );
    }, text);
  await edit("Automatisch");
  await expect(html).toHaveText("Automatisch");
  await page.getByLabel("Automatisch aktualisieren").uncheck();
  await edit("Pausiert");
  await expect(page.locator("#save-status")).toHaveText("Gespeichert");
  await expect(html).toHaveText("Automatisch");
  await page.getByLabel("Automatisch aktualisieren").check();
  await expect(html).toHaveText("Pausiert");
  await page
    .locator(".preview-log")
    .getByRole("button", { name: "app.js:3", exact: true })
    .click();
  await expect(page.locator("#file-path")).toHaveText("app.js");
  for (const [width, height] of [
    [1800, 1000],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["dark", "light", "high-contrast", "solarized"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await expect(page.locator(".preview-frame-host iframe")).toBeVisible();
      const bounds = await page.locator("#preview-panel").boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    }
    await page.screenshot({ path: `test-results/web-preview-${width}.png` });
  }
  await page
    .getByRole("button", { name: "Editor anzeigen", exact: true })
    .click();
  await expect(page.locator("#editor-container")).toBeVisible();
  await expect(page.locator("#preview-panel")).toBeHidden();
  await page
    .getByRole("button", { name: "Vorschau anzeigen", exact: true })
    .click();
  await expect(page.locator("#preview-panel")).toBeVisible();
});

test("Inline-Skripte behalten Originalzeilen; Top-Navigation und Formulare bleiben gesperrt", async ({
  page,
  request,
}) => {
  const base = await project(page, request);
  const file = await (
    await request.get(`${base}/files/content?path=index.html`)
  ).json();
  await request.put(`${base}/files/content`, {
    data: {
      path: "index.html",
      expectedVersion: file.version,
      content:
        '<!doctype html>\n<h1>Inline</h1>\n<script>\nconsole.log("Originalzeile");\nthrow new Error("Inlinefehler");\n</script>\n<form action="/api/sessions" method="post"><button>Senden</button></form>',
    },
  });
  await page.getByRole("button", { name: "Neu laden", exact: true }).click();
  await expect(page.locator(".preview-log")).toContainText("Inlinefehler");
  await expect(page.locator(".preview-log")).toContainText("index.html:5");
  const frame = page.frames().find((f) => f.url().includes("/document"));
  expect(
    await frame.evaluate(() => {
      try {
        top.location = "https://example.org";
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  expect(
    await frame.evaluate(() => window.open("https://example.org")),
  ).toBeNull();
  await page
    .frameLocator(".preview-frame-host iframe")
    .getByRole("button", { name: "Senden", exact: true })
    .click();
  await expect(
    page.frameLocator(".preview-frame-host iframe").locator("h1"),
  ).toHaveText("Inline");
});

test("verspätete Vorschauantwort öffnet keine Vorschau in einer anderen Session", async ({
  page,
  request,
}) => {
  await request.post("/api/sessions", {
    data: { title: "Andere Vorschau-Session", language: "python" },
  });
  await project(page, request);
  let release, reached;
  const gate = new Promise((resolve) => (release = resolve));
  const entered = new Promise((resolve) => (reached = resolve));
  await page.route("**/preview-runs", async (route) => {
    const response = await route.fetch();
    reached();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Neu laden", exact: true }).click();
  await entered;
  await page
    .getByRole("button", { name: "Andere Vorschau-Session", exact: true })
    .first()
    .click();
  release();
  await expect(page.locator("#session-title")).toHaveText(
    "Andere Vorschau-Session",
  );
  await expect(page.locator("#preview-panel")).toBeHidden();
  await expect(page.locator(".preview-frame-host iframe")).toHaveCount(0);
  await expect(page.locator("#preview-open")).toBeHidden();
});

test("fehlgeschlagene Vorschau erholt sich nach erfolgreichem Autosave", async ({
  page,
  request,
}) => {
  await project(page, request);
  await page
    .getByRole("button", { name: "Vorschau schließen", exact: true })
    .click();
  await page.evaluate(() => {
    monaco.editor
      .getModels()
      .find((m) => m.getValue().includes("<!doctype html>"))
      .setValue('<!doctype html><script type="module">export {}</script>');
  });
  await page.locator("#preview-open").click();
  await expect(page.locator("#preview-panel [role=status]")).toContainText(
    "Module",
  );
  await expect(page.locator(".preview-log")).toBeEmpty();
  await page.evaluate(() => {
    monaco.editor
      .getModels()
      .find((m) => m.getValue().includes("<!doctype html>"))
      .setValue("<!doctype html><h1>Wiederhergestellt</h1>");
  });
  await expect(
    page.frameLocator(".preview-frame-host iframe").locator("h1"),
  ).toHaveText("Wiederhergestellt");
});
