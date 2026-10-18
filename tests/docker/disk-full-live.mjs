// Run only in a disposable App-image container with a 1 MiB tmpfs at /data.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { writeJSON, readJSON } from "/app/server/services/storage.js";
const before = { version: 1, retained: "original" };
await writeJSON("/data/settings.json", before);
await fs.writeFile("/data/filler", Buffer.alloc(900 * 1024, 1));
let failure;
try {
  await writeJSON("/data/settings.json", {
    replacement: "x".repeat(2 * 1024 ** 2),
  });
} catch (error) {
  failure = error;
}
assert.equal(failure?.code, "ENOSPC");
assert.deepEqual(await readJSON("/data/settings.json"), before);
assert.ok(!(await fs.readdir("/data")).some((name) => name.endsWith(".tmp")));
console.log(
  JSON.stringify({
    test: "actual-ENOSPC-on-bounded-1MiB-tmpfs",
    atomicPreviousSettingsRetained: true,
    temporaryFileRemoved: true,
  }),
);
