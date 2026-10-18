// Optional integration smoke for Caddy's internal TLS, authentication and DELETE bodies.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const project = `sterra-proxy-${randomUUID().slice(0, 8)}`;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-proxy-"));
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
const port = await freePort(),
  httpPort = await freePort(),
  domain = "sterracode.test",
  authority = `${domain}:${port}`,
  origin = `https://${authority}`;
const override = path.join(temp, "ports.yaml");
await fs.writeFile(
  override,
  `services:\n  caddy:\n    ports: !override\n      - "127.0.0.1:${httpPort}:80"\n      - "127.0.0.1:${port}:443"\n`,
);
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  STERRACODE_DOMAIN: domain,
  STERRACODE_PUBLIC_URL: origin,
  STERRACODE_TLS_MODE: "internal",
  STERRACODE_PROXY_MODE: "caddy",
  STERRACODE_INITIAL_PROGRAMS: "",
};
function compose(args, capture = false) {
  const r = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      "compose.yaml",
      "-f",
      "compose.caddy.yaml",
      "-f",
      override,
      ...args,
    ],
    {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: capture ? "pipe" : "inherit",
      timeout: 20 * 60000,
      maxBuffer: 8 * 1024 ** 2,
    },
  );
  if (r.status !== 0)
    throw new Error(
      `Caddy-Compose fehlgeschlagen: ${args.slice(0, 3).join(" ")} ${r.stderr || ""}`,
    );
  return r.stdout?.trim();
}
let ca,
  cookie = "";
function api(endpoint, method = "GET", body, expected = 200, extra = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        servername: domain,
        ca,
        path: endpoint,
        method,
        headers: {
          Host: authority,
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...extra,
        },
      },
      (response) => {
        let content = "";
        response.setEncoding("utf8");
        response.on("data", (d) => (content += d));
        response.on("end", () => {
          try {
            assert.equal(
              response.statusCode,
              expected,
              `${method} ${endpoint}: ${content}`,
            );
            const set = response.headers["set-cookie"]?.[0];
            if (set) cookie = set.split(";")[0];
            resolve({ value: JSON.parse(content), headers: response.headers });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(30000, () =>
      request.destroy(new Error("Proxy-Zeitlimit")),
    );
    request.on("error", reject);
    request.end(payload);
  });
}
function streamViaProxy(sessionId) {
  return new Promise((resolve, reject) => {
    const started = Date.now(),
      heartbeats = [],
      usage = [];
    let buffer = "",
      visible = 0,
      reasoning = 0,
      done;
    const payload = JSON.stringify({
      sessionId,
      turnId: randomUUID(),
      userMessage:
        "Schreibe eine ausführliche nummerierte Liste von 80 konkreten Tipps zum Erlernen von JavaScript. Erkläre jeden Tipp mit mindestens zwei vollständigen Sätzen. Beginne sofort bei 1 und schreibe ohne Zusammenfassung und ohne Rückfragen weiter.",
    });
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        servername: domain,
        ca,
        path: "/api/chat/stream",
        method: "POST",
        headers: {
          Host: authority,
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        try {
          assert.equal(response.statusCode, 200);
          assert.match(response.headers["content-type"], /text\/event-stream/);
          assert.equal(response.headers["x-accel-buffering"], "no");
        } catch (error) {
          request.destroy(error);
          return;
        }
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          try {
            buffer += chunk;
            for (;;) {
              const boundary = buffer.indexOf("\n\n");
              if (boundary < 0) break;
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              if (frame.includes(": heartbeat")) {
                heartbeats.push(Date.now() - started);
                continue;
              }
              const event = frame.match(/^event: (.+)$/m)?.[1],
                raw = frame
                  .split("\n")
                  .filter((line) => line.startsWith("data: "))
                  .map((line) => line.slice(6))
                  .join("\n");
              if (!event || !raw) continue;
              const value = JSON.parse(raw);
              if (event === "token")
                visible += String(value.token || "").length;
              if (event === "reasoning")
                reasoning += String(value.token || "").length;
              if (event === "context-usage") usage.push(value);
              if (event === "context-report" && value.contextUsage)
                usage.push(value.contextUsage);
              if (event === "done") done = value;
              if (event === "error")
                throw new Error(`Caddy-SSE: ${value.code}`);
            }
          } catch (error) {
            request.destroy(error);
          }
        });
        response.on("error", reject);
        response.on("end", () => {
          clearTimeout(timer);
          try {
            assert.ok(
              done &&
                (done.turn.status === "done" ||
                  done.turn.code === "RESPONSE_LIMIT"),
            );
            assert.ok(visible + reasoning > 0);
            assert.ok(
              heartbeats.length > 0,
              "Echter 15-Sekunden-Herzschlag hinter Caddy fehlt",
            );
            const context =
              done.contextUsage ||
              usage.findLast((entry) => entry.measurementQuality === "exact");
            assert.equal(context?.measurementQuality, "exact");
            resolve({
              durationMs: Date.now() - started,
              heartbeats,
              visibleCharacters: visible,
              reasoningCharacters: reasoning,
              nativeContext: context.measurementQuality,
              turnCode: done.turn.code || null,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error("Caddy-LM-SSE über 65 Sekunden")),
      65000,
    );
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(payload);
  });
}
try {
  compose(["config", "--quiet"]);
  compose(["build"]);
  compose(["run", "--rm", "--no-deps", "init"]);
  const key = compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "app",
      "node",
      "docker/admin.mjs",
      "setup-key",
    ],
    true,
  )
    .split(/\r?\n/)
    .at(-1);
  compose(["up", "-d", "--wait", "--wait-timeout", "180"]);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      ca = compose(
        [
          "exec",
          "-T",
          "caddy",
          "cat",
          "/data/caddy/pki/authorities/local/root.crt",
        ],
        true,
      );
      if (ca.includes("BEGIN CERTIFICATE")) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(ca?.includes("BEGIN CERTIFICATE"), "Caddy-CA fehlt");
  assert.deepEqual((await api("/api/health")).value, { ok: true });
  await api("/api/chat/settings", "GET", undefined, 401);
  const setup = await api("/api/setup", "POST", {
    setupKey: key,
    password: "proxy-smoke-password",
  });
  assert.match(setup.headers["set-cookie"][0], /; Secure/);
  assert.match(setup.headers["set-cookie"][0], /HttpOnly/);
  await api(
    "/api/sessions",
    "POST",
    { title: "Fremder Ursprung", language: "javascript" },
    403,
    { Origin: "https://evil.invalid" },
  );
  const session = (
    await api(
      "/api/sessions",
      "POST",
      {
        title: "Proxy DELETE",
        language: "javascript",
      },
      201,
    )
  ).value;
  const job = (
    await api("/api/terminal", "POST", {
      sessionId: session.id,
      command: "sleep 1000",
    })
  ).value;
  const stopped = (
    await api(`/api/terminal/${job.processId}`, "DELETE", {
      sessionId: session.id,
    })
  ).value;
  assert.ok(stopped.exited);
  assert.equal(stopped.state, "cancelled");
  const config = JSON.parse(compose(["config", "--format", "json"], true));
  assert.ok(
    !config.services.app.ports?.length,
    "Proxyprofil veröffentlicht einen zweiten App-Port",
  );
  assert.ok(
    !config.services.runner.ports?.length,
    "Runner-Port veröffentlicht",
  );
  let sse;
  if (process.env.STERRACODE_LIVE_LM_URL) {
    await api("/api/chat/settings", "PATCH", {
      provider: "lmstudio",
      lmStudioUrl: process.env.STERRACODE_LIVE_LM_URL,
      activeModel:
        process.env.STERRACODE_LIVE_LM_MODEL || "ternary-bonsai-2-27b",
      temperature: 0,
      maxTokensResponse: 2048,
      maxToolCallsPerTurn: 1,
      allowAITerminalCommands: false,
      systemPrompt:
        "Antworte direkt auf die Nutzernachricht. Benutze für diese Verbindungstests keine Werkzeuge und stelle keine Rückfragen. Folge der angeforderten Antwortlänge.",
    });
    sse = await streamViaProxy(session.id);
  }
  console.log(
    JSON.stringify({
      test: "caddy-internal-tls",
      trustedCA: true,
      secureHttpOnlyCookie: true,
      originDenied: true,
      deleteJSONBody: true,
      appPortUnpublished: true,
      project,
      sse,
    }),
  );
} finally {
  try {
    compose(["down", "--volumes", "--remove-orphans"]);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
