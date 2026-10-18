import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateArchive } from "../../docker/admin.mjs";

function entry(name, content = "", type = "0") {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(Buffer.byteLength(content).toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.fill(32, 148, 156);
  h[156] = type.charCodeAt(0);
  h.write("ustar\0", 257);
  h.write("00", 263);
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const data = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512);
  data.write(content);
  return Buffer.concat([h, data]);
}
function pax(key, value) {
  const record = `${key}=${value}\n`;
  let n = record.length + 2;
  while (`${n} ${record}`.length !== n) n = `${n} ${record}`.length;
  return `${n} ${record}`;
}
describe("Docker restore archive trust boundary", () => {
  let tmp;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-archive-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });
  async function check(parts) {
    const file = path.join(tmp, "backup.tar");
    await fs.writeFile(file, Buffer.concat([...parts, Buffer.alloc(1024)]));
    return validateArchive(file);
  }
  it("accepts regular UTF-8 content and long PAX names", async () => {
    expect(
      await check([
        entry(".", "", "5"),
        entry("PaxHeader", pax("path", `./${"long/".repeat(40)}main.js`), "x"),
        entry("main.js", "ä"),
      ]),
    ).toBe(2);
  });
  it.each([
    "../../auth.json",
    "/etc/passwd",
    "C:/Windows/system.ini",
    "safe/../escape",
    "safe\\escape",
  ])("rejects traversal %s before extraction", async (name) => {
    await expect(check([entry(name, "x")])).rejects.toThrow(/Archivpfad/);
  });
  it.each(["1", "2", "3", "4", "6"])(
    "rejects link/special type %s",
    async (type) => {
      await expect(check([entry("evil", "", type)])).rejects.toThrow(
        /Symlinks/,
      );
    },
  );
  it("checks PAX path instead of the benign visible header", async () => {
    await expect(
      check([
        entry("PaxHeader", pax("path", "../../escape"), "x"),
        entry("benign", "x"),
      ]),
    ).rejects.toThrow(/Archivpfad/);
  });
  it("rejects duplicated aliases", async () => {
    await expect(
      check([entry("./source.js", "1"), entry("source.js", "2")]),
    ).rejects.toThrow(/Doppelte/);
  });
  it("rejects header corruption", async () => {
    const part = entry("safe", "x");
    part[0] ^= 1;
    await expect(check([part])).rejects.toThrow(/Prüfsumme/);
  });
});
