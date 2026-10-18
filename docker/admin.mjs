import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const roots = {
  "app-data": "/data",
  workspaces: "/workspaces",
  "runner-state": "/runner-state",
  "package-cache": "/package-cache",
  "app-key": "/app-key",
  "runner-key": "/runner-key",
};
const maxBytes = Number(
  process.env.STERRACODE_ARCHIVE_MAX_BYTES || 100 * 1024 ** 3,
);
const command = process.argv[2];
const exists = (p) =>
  fs.lstat(p).then(
    () => true,
    (e) => {
      if (e.code === "ENOENT") return false;
      throw e;
    },
  );

async function run(program, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${program} fehlgeschlagen (${code}).`)),
    );
  });
}
async function atomic(file, content, mode = 0o600) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}
async function freeSpace(dir, bytes) {
  const s = await fs.statfs(dir);
  if (s.bavail * s.bsize < bytes + 64 * 1024 ** 2)
    throw new Error(`Zu wenig freier Speicher in ${dir}.`);
}
async function scan(
  dir,
  repair = false,
  uid = 10001,
  gid = 10001,
  privateData = false,
) {
  let bytes = 0;
  async function visit(p) {
    const s = await fs.lstat(p);
    if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory()))
      throw new Error(`Verknüpfung oder Spezialdatei abgewiesen: ${p}`);
    if (s.isFile() && s.nlink > 1) throw new Error(`Hardlink abgewiesen: ${p}`);
    if (repair) {
      await fs.chown(p, uid, gid);
      await fs.chmod(
        p,
        s.isDirectory()
          ? privateData
            ? 0o700
            : 0o2770
          : privateData
            ? 0o600
            : s.mode & 0o111
              ? 0o770
              : 0o660,
      );
    }
    if (s.isDirectory())
      for (const name of await fs.readdir(p)) await visit(path.join(p, name));
    else {
      bytes += s.size;
      if (bytes > maxBytes)
        throw new Error("Daten überschreiten das konfigurierte Archivlimit.");
    }
  }
  await visit(dir);
  return bytes;
}
async function init() {
  for (const [dir, uid, gid, mode] of [
    ["/data", 10001, 10001, 0o700],
    ["/workspaces", 10001, 10001, 0o2770],
    ["/runner-state", 0, 0, 0o700],
    ["/package-cache", 0, 0, 0o700],
    ["/tool-cache", 10002, 10001, 0o2770],
    ["/runs", 10002, 10001, 0o2770],
    ["/app-key", 10001, 10001, 0o700],
    ["/runner-key", 0, 0, 0o700],
  ]) {
    await fs.mkdir(dir, { recursive: true });
    if ((await fs.lstat(dir)).isSymbolicLink())
      throw new Error(`Ungültiger Volumepfad: ${dir}`);
    await fs.chown(dir, uid, gid);
    await fs.chmod(dir, mode);
  }
  const a = "/app-key/runner_key",
    b = "/runner-key/runner_key";
  if ((await exists(a)) !== (await exists(b)))
    throw new Error(
      "Dienstschlüssel unvollständig. Beide Secret-Volumes aus derselben Sicherung wiederherstellen.",
    );
  if (!(await exists(a))) {
    const key = randomBytes(32).toString("hex");
    await atomic(a, key, 0o400);
    await fs.chown(a, 10001, 10001);
    await atomic(b, key, 0o400);
  } else if (!Buffer.from(await fs.readFile(a)).equals(await fs.readFile(b)))
    throw new Error("Die Dienstschlüssel stimmen nicht überein.");
  console.log(
    "Volumes und Dienstschlüssel bereit; vorhandene Daten bleiben erhalten.",
  );
}
async function auth() {
  const { createAuthService } = await import("../server/services/auth.js");
  const service = createAuthService({
    dataDir: process.env.STERRACODE_DATA_DIR || "/data",
  });
  const key = await service.createSetupKey({
    reset: command === "reset-password",
  });
  console.log(
    key ||
      "Die Instanz ist bereits eingerichtet; das Passwort wurde nicht verändert.",
  );
}
async function importData() {
  const source = "/import";
  if (
    (await fs.readdir("/data")).length ||
    (await fs.readdir("/workspaces")).length
  )
    throw new Error(
      "Import verlangt leere Daten- und Workspace-Volumes. Vorhandene Instanz zuerst sichern, dann ein neues Compose-Projekt verwenden.",
    );
  const bytes = await scan(source);
  if (
    (await exists(`${source}/migrations`)) &&
    (await fs.readdir(`${source}/migrations`)).some((name) =>
      name.endsWith(".json"),
    )
  )
    throw new Error(
      "Unvollständige Migrationsjournale vorhanden. Migration im bisherigen lokalen Server abschließen und diesen danach stoppen, bevor der Import erneut gestartet wird.",
    );
  await freeSpace("/data", bytes * 2);
  await freeSpace("/workspaces", bytes);
  const { copySafe, loadSession } =
    await import("../server/services/sessions.js");
  const { ensureDataDirs, validateSessionId } =
    await import("../server/services/storage.js");
  const entries = await fs.readdir(source);
  if (await exists(`${source}/shutdown-state.json`)) {
    const previous = JSON.parse(
      await fs.readFile(`${source}/shutdown-state.json`, "utf8"),
    );
    if (previous.state !== "clean")
      throw new Error(
        "Die Importquelle wurde nicht sauber gestoppt. Alten Server starten und kontrolliert stoppen, bevor importiert wird.",
      );
  }
  if (!entries.includes("sessions"))
    throw new Error(
      "Quelle ist kein SterraCode-Datenverzeichnis (sessions fehlt).",
    );
  // Retain an untouched source snapshot before any schema/context migration.
  const snapshot = `/data/backups/import-original-${randomUUID()}`;
  await fs.mkdir(snapshot, { recursive: true });
  for (const name of entries) {
    if (name === "runs" || name === "shutdown-state.json") continue;
    const p = path.join(source, name);
    await copySafe(p, path.join(snapshot, name));
    if (name === "workspaces") {
      for (const entry of await fs.readdir(p))
        await copySafe(path.join(p, entry), path.join("/workspaces", entry));
    } else if (name === "backups") {
      for (const entry of await fs.readdir(p))
        await copySafe(path.join(p, entry), path.join("/data/backups", entry));
    } else await copySafe(p, path.join("/data", name));
  }
  await ensureDataDirs();
  for (const name of await fs.readdir("/data/sessions")) {
    if (!name.endsWith(".json")) continue;
    const id = validateSessionId(name.slice(0, -5));
    const session = JSON.parse(
      await fs.readFile(`/data/sessions/${name}`, "utf8"),
    );
    if (
      session.id !== id ||
      (session.schemaVersion !== undefined &&
        ![1, 2].includes(session.schemaVersion))
    )
      throw new Error(`Ungültige Session: ${name}`);
    await loadSession(id);
  }
  await scan("/data", true, 10001, 10001, true);
  await scan("/workspaces", true);
  const settings = JSON.parse(await fs.readFile("/data/settings.json", "utf8"));
  try {
    if (
      ["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(settings.lmStudioUrl).hostname,
      )
    )
      console.warn(
        "LM-Studio-Adresse zeigt auf localhost und wurde nicht verändert. Im Browser eine erreichbare Host-/LAN-Adresse einstellen.",
      );
  } catch {}
  console.log(
    "Import und alle Sessionmigrationen abgeschlossen. Originalquelle unverändert; Originalkopie unter backups/import-original-*.",
  );
}
async function hash(file) {
  const h = createHash("sha256");
  for await (const part of createReadStream(file)) h.update(part);
  return h.digest("hex");
}
function safeName(name) {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /^[a-z]:/i.test(name) ||
    name.split("/").includes("..")
  )
    throw new Error("Unsicherer Archivpfad.");
  return name;
}
// Parse every tar header before extraction; reject links, special files and sparse extensions.
export async function validateArchive(file) {
  const fd = await fs.open(file, "r");
  const length = (await fd.stat()).size;
  let offset = 0,
    total = 0,
    count = 0,
    extended = {},
    longName;
  const names = new Set();
  const str = (b) => b.toString("utf8").replace(/\0.*$/s, "");
  const num = (b) => {
    const s = str(b).trim();
    if (!/^[0-7]*$/.test(s)) throw new Error("Ungültige TAR-Zahl.");
    return parseInt(s || "0", 8);
  };
  try {
    while (offset + 512 <= length) {
      const header = Buffer.alloc(512);
      await fd.read(header, 0, 512, offset);
      offset += 512;
      if (header.every((n) => n === 0)) break;
      let checksum = 0;
      for (let i = 0; i < 512; i++)
        checksum += i >= 148 && i < 156 ? 32 : header[i];
      if (checksum !== num(header.subarray(148, 156)))
        throw new Error("Ungültige TAR-Prüfsumme.");
      const size = num(header.subarray(124, 136));
      const type = String.fromCharCode(header[156] || 48);
      if (!Number.isSafeInteger(size) || offset + size > length)
        throw new Error("Abgeschnittenes Archiv.");
      if (["x", "g", "L"].includes(type)) {
        if (size > 1024 ** 2 || type === "g")
          throw new Error("Nicht unterstützte globale/große TAR-Metadaten.");
        const content = Buffer.alloc(size);
        await fd.read(content, 0, size, offset);
        if (type === "L") longName = str(content);
        else {
          let i = 0;
          while (i < content.length) {
            const space = content.indexOf(32, i),
              len = Number(content.subarray(i, space).toString());
            if (
              space < i ||
              !Number.isInteger(len) ||
              len <= space - i + 1 ||
              i + len > content.length
            )
              throw new Error("Ungültige PAX-Metadaten.");
            const entry = content
                .subarray(space + 1, i + len - 1)
                .toString("utf8"),
              equal = entry.indexOf("=");
            const key = entry.slice(0, equal);
            if (equal < 1 || /sparse|linkpath/i.test(key))
              throw new Error("Unsichere PAX-Metadaten.");
            extended[key] = entry.slice(equal + 1);
            i += len;
          }
        }
      } else {
        if (!["0", "5"].includes(type))
          throw new Error(
            "Archive mit Symlinks, Hardlinks oder Spezialdateien werden abgewiesen.",
          );
        const prefix = str(header.subarray(345, 500));
        const name = safeName(
          extended.path ||
            longName ||
            `${prefix ? prefix + "/" : ""}${str(header.subarray(0, 100))}`,
        );
        const normalized = path.posix.normalize(name).replace(/\/$/, "");
        if (names.has(normalized))
          throw new Error("Doppelte Archivpfade werden abgewiesen.");
        names.add(normalized);
        if (extended.size !== undefined && Number(extended.size) !== size)
          throw new Error("Abweichende PAX-Größe.");
        total += size;
        count++;
        if (total > maxBytes || count > 1000000)
          throw new Error("Archiv überschreitet das Größen-/Dateilimit.");
        extended = {};
        longName = undefined;
      }
      offset += Math.ceil(size / 512) * 512;
    }
    if (offset > length || length < 1024)
      throw new Error("Ungültiges TAR-Ende.");
    return total;
  } finally {
    await fd.close();
  }
}
async function backup() {
  if (await exists("/data/shutdown-state.json")) {
    const shutdown = JSON.parse(
      await fs.readFile("/data/shutdown-state.json", "utf8"),
    );
    if (shutdown.state !== "clean")
      throw new Error(
        "Die App wurde nicht sauber beendet. Keine konsistente Sicherung möglich; App wieder starten und kontrolliert stoppen.",
      );
  }
  if ((await fs.readdir("/backup")).length)
    throw new Error("Backupziel muss leer sein.");
  await fs.chmod("/backup", 0o700);
  const selected = Object.entries(roots).filter(
    ([name]) => name !== "package-cache" || process.argv.includes("--offline"),
  );
  let bytes = 0;
  for (const [, dir] of selected) bytes += await scan(dir);
  await freeSpace("/backup", bytes * 1.05);
  const manifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    architecture: process.arch,
    dataSchema: 2,
    images: JSON.parse(process.env.STERRACODE_BACKUP_IMAGES || "[]"),
    offlinePackages: process.argv.includes("--offline"),
    archives: [],
  };
  for (const [name, dir] of selected) {
    const file = `${name}.tar`,
      target = path.join("/backup", file);
    await run("tar", [
      "--format=posix",
      "--numeric-owner",
      "-cf",
      target,
      "-C",
      dir,
      ".",
    ]);
    await fs.chmod(target, 0o600);
    await validateArchive(target);
    manifest.archives.push({
      volume: name,
      file,
      bytes: (await fs.stat(target)).size,
      sha256: await hash(target),
    });
  }
  await atomic("/backup/manifest.json", JSON.stringify(manifest, null, 2));
  const uid = Number(process.env.STERRACODE_BACKUP_UID || 0),
    gid = Number(process.env.STERRACODE_BACKUP_GID || 0);
  if (![uid, gid].every((value) => Number.isInteger(value) && value >= 0))
    throw new Error("Ungültiger Sicherungseigentümer.");
  for (const name of await fs.readdir("/backup"))
    await fs.chown(path.join("/backup", name), uid, gid);
  await fs.chown("/backup", uid, gid);
  console.log(
    "Konsistente Sicherung abgeschlossen; enthält Anmeldedaten und geschützte Secret-Archive. Verzeichnis vertraulich verwahren.",
  );
}
async function restore() {
  const manifest = JSON.parse(
    await fs.readFile("/backup/manifest.json", "utf8"),
  );
  if (
    manifest.format !== 1 ||
    !Array.isArray(manifest.archives) ||
    manifest.archives.length > 6
  )
    throw new Error("Unbekanntes Sicherungsformat.");
  if (manifest.architecture !== process.arch)
    throw new Error(
      "Architekturwechsel erfordert eine geprüfte Manifestmigration.",
    );
  const seen = new Set();
  for (const item of manifest.archives) {
    if (
      !Object.hasOwn(roots, item.volume) ||
      seen.has(item.volume) ||
      item.file !== `${item.volume}.tar`
    )
      throw new Error("Ungültiges Volume im Sicherungsmanifest.");
    seen.add(item.volume);
    if ((await fs.readdir(roots[item.volume])).length)
      throw new Error(
        `Restoreziel ${item.volume} muss leer sein; isoliertes neues Compose-Projekt verwenden.`,
      );
    const file = path.join("/backup", item.file);
    if (
      (await fs.stat(file)).size !== item.bytes ||
      (await hash(file)) !== item.sha256
    )
      throw new Error("Sicherungsprüfsumme stimmt nicht.");
    await freeSpace(roots[item.volume], await validateArchive(file));
  }
  for (const required of [
    "app-data",
    "workspaces",
    "runner-state",
    "app-key",
    "runner-key",
  ])
    if (!seen.has(required)) throw new Error(`Volume ${required} fehlt.`);
  // No extraction starts until every archive and target has passed validation.
  for (const item of manifest.archives) {
    const dir = roots[item.volume];
    await run("tar", [
      "--extract",
      "--file",
      `/backup/${item.file}`,
      "--directory",
      dir,
      "--no-same-owner",
      "--no-same-permissions",
      "--keep-old-files",
      "--delay-directory-restore",
    ]);
    const app = ["app-data", "app-key"].includes(item.volume);
    await scan(
      dir,
      true,
      app || item.volume === "workspaces" ? 10001 : 0,
      item.volume === "workspaces" || app ? 10001 : 0,
      item.volume !== "workspaces",
    );
  }
  for (const p of ["/app-key/runner_key", "/runner-key/runner_key"])
    await fs.chmod(p, 0o400);
  console.log(
    "Restore geprüft und abgeschlossen. Startskript ausführen und alte Session mit Verlauf sowie Programmausführung prüfen.",
  );
}
async function usage() {
  const result = {};
  for (const [name, dir] of Object.entries(roots))
    result[name] = {
      bytes: await scan(dir),
      availableBytes: await fs.statfs(dir).then((s) => s.bavail * s.bsize),
    };
  console.log(JSON.stringify(result, null, 2));
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.umask(0o077);
    if (command === "init") await init();
    else if (["setup-key", "reset-password"].includes(command)) await auth();
    else if (command === "import") await importData();
    else if (command === "backup") await backup();
    else if (command === "restore") await restore();
    else if (command === "usage") await usage();
    else
      throw new Error(
        "Befehle: init | setup-key | reset-password | import | backup [--offline] | restore | usage",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
