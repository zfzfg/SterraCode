import { createApp } from "./app.js";
import { prunePreviews } from "./services/previews.js";
import { ensureDataDirs } from "./services/storage.js";
import { stopAllProcesses } from "./services/processes.js";
import fs from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createAuthService } from "./services/auth.js";
import { abortAllTurns } from "./services/teacher.js";
import { drainServer, writeShutdownState } from "./services/shutdown.js";
const config = loadConfig();
process.umask(0o002);
await ensureDataDirs();
const prune = () =>
  prunePreviews().catch((error) =>
    console.error("Vorschau-Bereinigung fehlgeschlagen", { code: error.code }),
  );
await prune();
setInterval(prune, 60 * 60 * 1000).unref();
await writeShutdownState(config.dataDir, "running");
const auth = createAuthService({ dataDir: config.dataDir });
if (
  config.authRequired &&
  config.adminPasswordFile &&
  (await auth.status()).setupRequired
)
  await auth.initializePassword(
    (await fs.readFile(config.adminPasswordFile, "utf8")).replace(
      /[\r\n]+$/,
      "",
    ),
  );
const app = createApp({ config, auth });
app.locals.updates.start().catch(() => {});
app.locals.updates.beginPolling();
const server = app.listen(config.port, config.bindAddress, () =>
  console.log(`SterraCode läuft auf ${config.publicUrl}`),
);
server.requestTimeout = 21 * 60 * 1000;
server.headersTimeout = 60000;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const confirmed = await drainServer({
    app,
    server,
    dataDir: config.dataDir,
    abortChats: abortAllTurns,
    stopJobs: stopAllProcesses,
  });
  if (!confirmed)
    console.warn(
      "Herunterfahren: Runner-Auftragszustand konnte innerhalb der Stopfrist nicht bestätigt werden.",
    );
  process.exit(confirmed ? 0 : 1);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
