import { createApp } from "./app.js";
import { ensureDataDirs } from "./services/storage.js";
import { stopAllProcesses } from "./services/processes.js";
await ensureDataDirs();
const port = Number(process.env.PORT) || 3000;
const server = createApp().listen(port, "127.0.0.1", () =>
  console.log(`SterraCode läuft auf http://localhost:${port}`),
);
async function shutdown() {
  server.close();
  await stopAllProcesses();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
