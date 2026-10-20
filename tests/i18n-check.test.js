import { it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkI18n } from "../scripts/check-i18n.mjs";

it("rejects nonexistent descriptor keys and missing descriptor parameters", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-i18n-check-"));
  try {
    for (const locale of ["de", "en", "es"]) {
      const dir = path.join(root, "shared/i18n/locales", locale);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "common.json"),
        JSON.stringify({ greeting: "Hello {{name}}" }),
      );
    }
    await fs.mkdir(path.join(root, "server"));
    await fs.writeFile(
      path.join(root, "server/example.js"),
      'export const errors = [{messageKey:"common:missing",params:{}},{messageKey:"common:greeting",params:{}}];',
    );
    const report = await checkI18n(root);
    expect(
      report.errors.filter((error) => error.rule === "DESCRIPTOR_KEY_MISSING"),
    ).toHaveLength(3);
    expect(
      report.errors.filter(
        (error) => error.rule === "DESCRIPTOR_PARAM_MISSING",
      ),
    ).toHaveLength(3);
    await fs.writeFile(
      path.join(root, "server/example.js"),
      'export const errors = [{messageKey:"common:greeting",params:{name:"Ada"}}];',
    );
    expect((await checkI18n(root)).errors).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
