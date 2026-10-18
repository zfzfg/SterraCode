import { test, expect } from "@playwright/test";

test("Binärdateien erklären und geöffnete Quelldatei erhalten", async ({
  page,
  request,
}) => {
  const session = await (
    await request.post("/api/sessions", {
      data: { title: "Binärdateien", language: "java" },
    })
  ).json();
  const root = `/api/workspaces/${session.id}/files`;
  for (const [path, content] of [
    ["Source.java", "class Source {}"],
    ["Source.class", "\u0000Java bytecode fixture"],
    ["data.bin", "\u0000binary fixture"],
  ]) {
    const created = await request.post(root, {
      data: { path, content, type: "file" },
    });
    expect(created.ok()).toBeTruthy();
  }
  await request.patch(`/api/sessions/${session.id}`, {
    data: { activeFile: "Source.java", openFiles: ["Source.java"] },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Binärdateien", exact: true })
    .first()
    .click();
  await expect(page.locator("#file-path")).toHaveText("Source.java");
  await page.getByRole("tab", { name: "Dateien", exact: true }).click();
  for (const [name, title, explanation] of [
    ["Source.class", "Kompilierte Java-Datei", "Java-Bytecode"],
    ["data.bin", "Keine Textdatei", "Binärdatei"],
  ]) {
    await page.getByRole("treeitem", { name, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await expect(dialog).toContainText(explanation);
    await expect(page.locator("#file-path")).toHaveText("Source.java");
    await expect(page.locator(".view-lines")).toContainText("class Source {}");
    await expect(page.locator("#toasts [role=alert]")).toHaveCount(0);
    await dialog
      .getByRole("button", { name: "Verstanden", exact: true })
      .click();
    const saved = await (
      await request.get(`/api/sessions/${session.id}`)
    ).json();
    expect(saved.activeFile).toBe("Source.java");
    expect(saved.openFiles).toEqual(["Source.java"]);
    expect(
      (
        await request.get(`${root}/content?path=${encodeURIComponent(name)}`)
      ).status(),
    ).toBe(415);
  }
});
