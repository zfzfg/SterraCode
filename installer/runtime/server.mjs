import http from "node:http";
import { Controller } from "./controller.mjs";
import { secretMatches } from "./io.mjs";

export async function startUpdater(directory = "/installation") {
  const controller = new Controller(directory);
  await controller.initialize();
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (!(await secretMatches(req.headers.authorization, "/run/updater/key")))
        return send(401, { error: "Authentication required." });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 8192)
          return send(413, { error: "Request too large." });
      }
      const value = body ? JSON.parse(body) : {};
      if (req.method === "GET" && req.url === "/status")
        return send(200, controller.status());
      if (req.method === "POST" && req.url === "/check")
        return send(200, await controller.check(true));
      if (req.method === "POST" && req.url === "/install")
        return send(202, await controller.install());
      if (req.method === "PATCH" && req.url === "/settings")
        return send(200, await controller.settings(value));
      if (req.method === "POST" && req.url === "/activity")
        return send(200, controller.activity(value));
      return send(404, { error: "Unknown action." });
    } catch (error) {
      send(409, { error: error.message });
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.listen(3002, "0.0.0.0");
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await controller.tick();
    } catch (error) {
      console.error("Update scheduler:", error.message);
    } finally {
      ticking = false;
    }
  };
  await tick();
  setInterval(tick, 60000).unref();
  return server;
}
