import fs from "node:fs/promises";
import path from "node:path";
import { area, hash } from "./model.mjs";

export async function collectSources(root, config, scope = "all") {
  const files = [];
  const coverage = [];
  const excluded = new Set(
    config.excludeDirectories.map((name) => name.toLowerCase()),
  );
  async function walk(directory, rootLevel = false) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      coverage.push({
        file: path.relative(root, directory).replaceAll("\\", "/"),
        status: "error",
        reason: error.code,
      });
      return;
    }
    for (const entry of entries.sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const absolute = path.join(directory, entry.name);
      const file = path.relative(root, absolute).replaceAll("\\", "/");
      const omit = (reason) =>
        coverage.push({ file, status: "excluded", reason });
      if (entry.isSymbolicLink()) {
        omit("symlink-not-followed");
        continue;
      }
      if (entry.isDirectory()) {
        if (excluded.has(entry.name.toLowerCase())) {
          omit("data-dependency-or-secret-directory");
          continue;
        }
        if (rootLevel && !config.roots.includes(entry.name)) {
          omit("outside-configured-source-roots");
          continue;
        }
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        omit("non-regular-file");
        continue;
      }
      if (
        (entry.name.startsWith(".env") && entry.name !== ".env.example") ||
        /^(?:credentials?|secrets?|tokens?)\.(?:json|txt|ya?ml)$/i.test(
          entry.name,
        )
      ) {
        omit("secret-or-environment-file");
        continue;
      }
      if (file === "package-lock.json" || file === "scripts/audit-i18n.mjs") {
        omit("dependency-lock-or-legacy-auditor");
        continue;
      }
      const ext = path.extname(file).toLowerCase();
      if (
        !config.extensions.includes(ext) &&
        !config.rootNames.includes(entry.name)
      ) {
        omit("unsupported-or-documentation-or-binary");
        continue;
      }
      const category = area(file);
      if (
        (scope === "product" &&
          !["frontend", "server", "runner", "shared"].includes(category)) ||
        (scope === "tests" && category !== "tests") ||
        (scope === "operations" && category !== "operations")
      ) {
        omit("scope-filter");
        continue;
      }
      const stat = await fs.lstat(absolute);
      if (stat.size > config.maxSourceBytes) {
        coverage.push({
          file,
          status: "error",
          reason: "source-size-limit",
          bytes: stat.size,
        });
        continue;
      }
      try {
        const bytes = await fs.readFile(absolute);
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        files.push({ file, source, area: category });
        coverage.push({
          file,
          status: "pending",
          bytes: bytes.length,
          sha256: hash(bytes),
          lines: source.split(/\r?\n/).length,
        });
      } catch (error) {
        coverage.push({
          file,
          status: "error",
          reason: `read-or-encoding: ${error.message}`,
        });
      }
    }
  }
  await walk(root, true);
  return { files, coverage };
}
