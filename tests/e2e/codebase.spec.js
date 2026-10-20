import { test, expect } from "@playwright/test";
import { crc32 } from "node:zlib";
function zip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [path, content] of entries) {
    const name = Buffer.from(path),
      bytes = Buffer.from(content),
      crc = crc32(bytes);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800, 6);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(bytes.length, 18);
    head.writeUInt32LE(bytes.length, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, bytes);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(0x314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(bytes.length, 20);
    c.writeUInt32LE(bytes.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += head.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function calls(page) {
  return (
    await (await page.request.get("/__e2e/codebase-model-requests")).json()
  ).allModelRequests;
}
async function importProject(page, title) {
  await page.goto("/");
  await page.locator("#welcome-codebase-import").click();
  const dialog = page.locator("#codebase-import-dialog");
  await dialog.getByLabel("ZIP-Datei auswählen").setInputFiles({
    name: `${title}.zip`,
    mimeType: "application/zip",
    buffer: zip([
      ["main.py", 'print("Hallo")\n'],
      ["README.md", "# Begrüßung\nEin kleines Beispiel.\n"],
      ["docs/guide.md", "Zusatznotiz"],
      ["node_modules/example.js", "generated"],
    ]),
  });
  await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
  await expect(
    dialog.getByLabel("docs auswählen", { exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("docs auswählen", { exact: true }).uncheck();
  await expect(dialog.getByText(/2 Dateien ·/)).toBeVisible();
  await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill(title);
  await dialog
    .getByRole("button", { name: "Projekt öffnen", exact: true })
    .click();
  await expect(page.locator("#session-title")).toHaveText(title);
  await expect(page.locator("#codebase-cockpit")).toBeVisible();
}
test("ZIP auswählen, ohne KI öffnen und manuell analysieren, Tour und sichere Codesprünge", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const before = await calls(page);
  await importProject(page, "Explorer-Beispiel");
  expect(await calls(page)).toBe(before);
  const sessions = await (await page.request.get("/api/sessions")).json();
  const session = sessions.find((s) => s.title === "Explorer-Beispiel");
  const tree = await (
    await page.request.get(`/api/workspaces/${session.id}/tree`)
  ).json();
  expect(tree.entries.map((e) => e.path)).toEqual(["README.md", "main.py"]);
  await page
    .locator("#codebase-cockpit")
    .getByRole("button", { name: "Codebase analysieren", exact: true })
    .click();
  await expect(
    page.getByText("Dieses Projekt begrüßt die Welt.", { exact: true }),
  ).toBeVisible();
  expect(await calls(page)).toBe(before + 1);
  await page
    .getByRole("button", { name: "Den Ablauf verfolgen", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Den Ablauf verfolgen", exact: true }),
  ).toBeVisible();
  expect(await calls(page)).toBe(before + 1);
  await page
    .locator(".codebase-tour-step .codebase-references button")
    .first()
    .click();
  await expect(page.locator("#codebase-tab-code")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#file-path")).toHaveText("main.py");
  await page.locator("#codebase-tour-return").click();
  await expect(
    page.getByRole("heading", { name: "Den Ablauf verfolgen", exact: true }),
  ).toBeVisible();
  expect(await calls(page)).toBe(before + 1);
  await page.reload();
  await page
    .locator(".session-open")
    .filter({ hasText: "Explorer-Beispiel" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Den Ablauf verfolgen", exact: true }),
  ).toBeVisible();
  expect(await calls(page)).toBe(before + 1);
  expect(errors).toEqual([]);
});
test("Demos bleiben getrennt, erzeugen lokal keine Ausführung und verlinken das Original", async ({
  page,
}) => {
  await importProject(page, "Explorer-Demoquelle");
  const session = (await (await page.request.get("/api/sessions")).json()).find(
    (item) => item.title === "Explorer-Demoquelle",
  );
  const source = await (
    await page.request.get(
      `/api/workspaces/${session.id}/files/content?path=main.py`,
    )
  ).json();
  await page
    .getByRole("button", { name: "Demo erstellen", exact: true })
    .click();
  const dialog = page.locator("#app-dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Eigenständiger Gruß");
  await dialog
    .getByLabel("Lernziel und Vereinfachungen")
    .fill("Eine Ausgabe ohne Projektabhängigkeiten.");
  await dialog.getByLabel("Democode").fill('print("Demo")\n');
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Eigenständiger Gruß", exact: true }),
  ).toBeVisible();
  const demos = await (
    await page.request.get(`/api/codebase/sessions/${session.id}/demos`)
  ).json();
  expect(demos.demos).toHaveLength(1);
  expect(demos.demos[0].sessionId).not.toBe(session.id);
  expect(
    await (
      await page.request.get(
        `/api/workspaces/${session.id}/files/content?path=main.py`,
      )
    ).json(),
  ).toEqual(source);
  await page.getByRole("button", { name: "Demo öffnen", exact: true }).click();
  await expect(page.locator("#run-btn")).toBeDisabled();
  await expect(page.locator("#codebase-demo-parent")).toBeVisible();
  await page.locator("#codebase-demo-parent").click();
  await expect(page.locator("#session-title")).toHaveText(
    "Explorer-Demoquelle",
  );
});
test("Import lässt sich bei 390px per Tastatur ohne Modellanfrage bedienen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const before = await calls(page);
  await page.locator("#welcome-codebase-import").click();
  const dialog = page.locator("#codebase-import-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("ZIP-Datei auswählen")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#welcome-codebase-import")).toBeFocused();
  expect(await calls(page)).toBe(before);
});
test("Über 500 MB erfordern eine an Auswahl und Manifest gebundene Bestätigung", async ({
  page,
}) => {
  const job = {
    id: "fixture-import",
    state: "awaiting_selection",
    phase: "awaiting_selection",
    manifestVersion: "manifest-1",
    selectionVersion: 1,
    selectionDigest: "selection-1",
    summary: {
      files: 1,
      bytes: 500000001,
      selectedFiles: 1,
      selectedBytes: 500000001,
    },
    source: { kind: "zip" },
    warnings: [],
  };
  let commit;
  await page.route("**/api/codebase/imports**", async (route) => {
    const url = new URL(route.request().url());
    let response;
    if (url.pathname.endsWith("/commit")) {
      commit = route.request().postDataJSON();
      response = {
        ...job,
        state: "failed",
        error: {
          messageKey: "features:codebase.errors.import",
          params: { reason: "FIXTURE_COMPLETE" },
        },
      };
    } else if (url.pathname.endsWith("/tree"))
      response = {
        entries: [
          {
            id: "big",
            name: "big.txt",
            path: "big.txt",
            type: "file",
            selected: true,
            bytes: 500000001,
            editorEligible: false,
          },
        ],
        manifestVersion: job.manifestVersion,
        selectionVersion: job.selectionVersion,
        summary: job.summary,
      };
    else if (
      route.request().method() === "GET" &&
      url.pathname === "/api/codebase/imports"
    )
      response = [];
    else response = job;
    await route.fulfill({ json: response });
  });
  await page.goto("/");
  await page.locator("#welcome-codebase-import").click();
  const dialog = page.locator("#codebase-import-dialog");
  await dialog.getByLabel("ZIP-Datei auswählen").setInputFiles({
    name: "big.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("fixture"),
  });
  await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
  await expect(dialog.getByText(/1 Dateien ·/)).toBeVisible();
  await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
  const confirm = dialog.locator("#codebase-large-confirmation");
  await expect(confirm).not.toBeChecked();
  await dialog
    .getByRole("button", { name: "Projekt öffnen", exact: true })
    .click();
  expect(commit).toBeUndefined();
  await confirm.check();
  await dialog
    .getByRole("button", { name: "Projekt öffnen", exact: true })
    .click();
  await expect
    .poll(() => commit?.confirmation)
    .toEqual({
      bytes: 500000001,
      selectionDigest: "selection-1",
      manifestVersion: "manifest-1",
    });
});
test("Codebase-Ansicht bleibt in vier Themes, fünf Fensterbreiten und 200 Prozent Zoom bedienbar", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await importProject(page, "Explorer-Ansicht");
  const cockpit = page.locator("#codebase-cockpit");
  for (const width of [390, 800, 1024, 1366, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["dark", "light", "high-contrast", "solarized"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        window.dispatchEvent(new Event("theme-changed"));
      }, theme);
      await expect(cockpit).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath(`codebase-${width}-${theme}.png`),
      });
    }
  }
  // Browser zoom of 200% on an 800x900 window gives a 400x450 CSS viewport.
  await page.setViewportSize({ width: 400, height: 450 });
  await expect(
    cockpit.getByRole("button", { name: "Codebase analysieren", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("codebase-200-percent.png"),
  });
});
test("Versionsgebundene Chatbelege und paginierte Dateiaktionen erhalten normale Workspace-Regeln", async ({
  page,
}) => {
  await importProject(page, "Explorer-Dateiaktionen");
  const session = (await (await page.request.get("/api/sessions")).json()).find(
    (s) => s.title === "Explorer-Dateiaktionen",
  );
  const file = await (
    await page.request.get(
      `/api/workspaces/${session.id}/files/content?path=main.py`,
    )
  ).json();
  const reference = {
    sessionId: session.id,
    path: "main.py",
    startLine: 1,
    endLine: 1,
    fileVersion: file.version,
  };
  const response = await page.request.post("/api/chat", {
    data: {
      sessionId: session.id,
      userMessage: `CODEBASE_REF:${JSON.stringify(reference)}`,
    },
  });
  expect(response.ok()).toBe(true);
  await page.reload();
  await page
    .locator(".session-open")
    .filter({ hasText: "Explorer-Dateiaktionen" })
    .click();
  await page.locator(".event-card .codebase-references button").click();
  await expect(page.locator("#file-path")).toHaveText("main.py");
  await page.locator("#tab-files").click();
  await page
    .getByRole("button", { name: "Umbenennen: main.py", exact: true })
    .click();
  await page
    .getByLabel("Neuer relativer Pfad", { exact: true })
    .fill("greeting.py");
  await page
    .locator("#app-dialog")
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  await expect(
    page
      .locator("#file-tree")
      .getByRole("button", { name: "greeting.py", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Löschen: README.md", exact: true })
    .click();
  await page
    .locator("#app-dialog")
    .getByRole("button", { name: "Bestätigen", exact: true })
    .click();
  await expect(
    page
      .locator("#file-tree")
      .getByRole("button", { name: "README.md", exact: true }),
  ).toHaveCount(0);
});
test("Git-Zugänge entsperren nur vorübergehend und erzeugte Schlüssel zeigen nur öffentliche Daten", async ({
  page,
}) => {
  const credential = {
    id: "credential-fixture",
    name: "Verschlüsselter Testschlüssel",
    host: "git.example.test",
    port: 22,
    type: "ssh-key",
    version: 3,
    encryptedKey: true,
    publicKey: "ssh-ed25519 PUBLIC_FIXTURE",
    fingerprint: "SHA256:PUBLIC_FIXTURE",
  };
  let unlock, generation;
  await page.route("**/api/git-credentials**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/unlock")) {
      unlock = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true } });
    } else if (url.pathname.endsWith("/generate")) {
      generation = route.request().postDataJSON();
      await route.fulfill({
        json: { ...credential, name: generation.name, encryptedKey: false },
      });
    } else
      await route.fulfill({
        json: {
          credentials: [credential],
          transportAllowed: true,
          storage: { keySource: "external" },
        },
      });
  });
  await page.goto("/");
  await expect(page.locator("#welcome-new")).toBeEnabled();
  await page.locator("#settings-btn").click();
  await page.getByRole("button", { name: "Git-Zugänge", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Verschlüsselter Testschlüssel verwalten",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Öffentlicher SSH-Schlüssel")).toHaveValue(
    credential.publicKey,
  );
  await page
    .getByRole("button", {
      name: "SSH-Schlüssel vorübergehend entsperren",
      exact: true,
    })
    .click();
  const secret = "SYNTHETIC_EPHEMERAL_PASSPHRASE";
  await page.getByLabel("Passphrase", { exact: true }).fill(secret);
  await expect(page.getByLabel("Passphrase", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await page
    .locator("#app-dialog")
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  await expect(page.locator("#app-dialog")).toBeHidden();
  expect(unlock).toEqual({ passphrase: secret, expectedVersion: 3 });
  await expect(page.locator("#field-passphrase")).toHaveValue("");
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage })),
  ).not.toContain(secret);
  await page.locator("#settings-btn").click();
  await page.getByRole("button", { name: "Git-Zugänge", exact: true }).click();
  await page
    .getByRole("button", { name: "SSH-Schlüsselpaar erzeugen", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Neuer Testschlüssel");
  await page.getByLabel("Host", { exact: true }).fill("git.example.test");
  await page
    .getByLabel("Geprüfter SSH-Hostschlüssel", { exact: true })
    .fill("ssh-ed25519 TRUSTED_PUBLIC_FIXTURE");
  await page
    .locator("#app-dialog")
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  await expect(page.getByLabel("Öffentlicher SSH-Schlüssel")).toHaveValue(
    credential.publicKey,
  );
  expect(generation).not.toHaveProperty("secret");
  expect(generation).not.toHaveProperty("passphrase");
});
