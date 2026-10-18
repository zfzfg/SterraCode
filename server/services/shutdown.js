import path from "node:path";
import { writeJSON } from "./storage.js";

export function writeShutdownState(dataDir, state) {
  return writeJSON(path.join(dataDir, "shutdown-state.json"), {
    version: 1,
    state,
    updatedAt: new Date().toISOString(),
  });
}
export async function drainServer({
  app,
  server,
  dataDir,
  abortChats,
  stopJobs,
  timeoutMs = 25000,
}) {
  app.locals.beginMaintenance();
  let timer;
  const drained = new Promise((resolve) => server.close(() => resolve(true)));
  server.closeIdleConnections?.();
  try {
    await writeShutdownState(dataDir, "draining");
    abortChats();
    const clean = await Promise.race([
      Promise.all([drained, Promise.resolve().then(stopJobs)]).then(
        () => true,
        () => false,
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (!clean) {
      server.closeAllConnections?.();
      return false;
    }
    await writeShutdownState(dataDir, "clean");
    return true;
  } catch {
    server.closeAllConnections?.();
    return false;
  } finally {
    clearTimeout(timer);
  }
}
