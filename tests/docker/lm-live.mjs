// Optional real LM Studio integration. Never selects the paid OpenAI provider.
// STERRACODE_LIVE_LM_URL=http://192.168.178.64:1234 node tests/docker/lm-live.mjs
// Creates and removes its own Compose project unless an explicitly isolated
// STERRACODE_LIVE_APP_URL is supplied with STERRACODE_LIVE_TEST_INSTANCE=1.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const lmURL = process.env.STERRACODE_LIVE_LM_URL;
if (!lmURL) {
  console.log(
    JSON.stringify({
      skipped: true,
      reason:
        "Set STERRACODE_LIVE_LM_URL for the optional real LM Studio test.",
    }),
  );
  process.exit(0);
}
const model = process.env.STERRACODE_LIVE_LM_MODEL || "ternary-bonsai-2-27b";
const root = fileURLToPath(new URL("../../", import.meta.url));
const external = process.env.STERRACODE_LIVE_APP_URL;
if (external)
  assert.equal(
    process.env.STERRACODE_LIVE_TEST_INSTANCE,
    "1",
    "An existing app URL must identify an isolated test instance.",
  );
const project = `sterra-lm-${randomUUID().slice(0, 8)}`;
const port = external
  ? null
  : await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const value = server.address().port;
        server.close(() => resolve(value));
      });
    });
const base = external || `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  STERRACODE_BIND_IP: "127.0.0.1",
  STERRACODE_PORT: String(port),
  STERRACODE_PUBLIC_URL: base,
  STERRACODE_PROXY_MODE: "off",
  STERRACODE_INITIAL_PROGRAMS: "",
  STERRACODE_LM_STUDIO_URL: lmURL,
};
let cookie = "",
  sessionId,
  created = false;
function compose(args, capture = false) {
  const result = spawnSync(
    "docker",
    ["compose", "-f", "compose.yaml", "-f", "compose.lan.yaml", ...args],
    {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: capture ? "pipe" : "inherit",
      timeout: 20 * 60000,
      maxBuffer: 16 * 1024 ** 2,
    },
  );
  if (result.status !== 0)
    throw new Error(
      `Docker Compose ${args.slice(0, 3).join(" ")} failed: ${result.stderr || result.error?.message || result.status}`,
    );
  return result.stdout?.trim();
}
async function api(route, method = "GET", body, expected = 200) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: {
      Origin: base,
      Cookie: cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json();
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(value)}`);
  if (response.headers.get("set-cookie"))
    cookie = response.headers.get("set-cookie").split(";")[0];
  return value;
}
async function streamTurn(userMessage, { allowLimit = false } = {}) {
  const started = Date.now(),
    controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 60000);
  const turnId = randomUUID(),
    events = [],
    heartbeats = [],
    usage = [];
  let text = "",
    reasoningCharacters = 0,
    done,
    buffer = "",
    timedOut = false;
  try {
    const response = await fetch(`${base}/api/chat/stream`, {
      method: "POST",
      headers: {
        Origin: base,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId, turnId, userMessage }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
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
        events.push(event);
        if (event === "token") text += value.token;
        if (event === "reasoning")
          reasoningCharacters += String(value.token || "").length;
        if (event === "context-usage") usage.push(value);
        if (event === "context-report" && value.contextUsage)
          usage.push(value.contextUsage);
        if (event === "done") done = value;
        if (event === "error")
          throw new Error(`SSE error ${value.code}: ${value.message}`);
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    timedOut = true;
    await api("/chat/abort", "POST", { sessionId });
  } finally {
    clearTimeout(timer);
  }
  if (!timedOut) {
    assert(done, "SSE stream ended without a done event");
    assert(
      done.turn.status === "done" ||
        (allowLimit && done.turn.code === "RESPONSE_LIMIT"),
      JSON.stringify(done.turn),
    );
  }
  const measured =
    done?.contextUsage ||
    usage.findLast((entry) => entry.measurementQuality === "exact");
  assert.equal(
    measured?.measurementQuality,
    "exact",
    `Native context token measurement missing: ${JSON.stringify(measured)}`,
  );
  assert(measured.promptTokens > 0);
  assert(measured.contextLength > measured.promptTokens);
  assert.equal(measured.provider, "lmstudio");
  return {
    text,
    reasoningCharacters,
    durationMs: Date.now() - started,
    timedOut,
    heartbeats,
    events: [...new Set(events)],
    context: {
      measurementQuality: measured.measurementQuality,
      promptTokens: measured.promptTokens,
      contextLength: measured.contextLength,
      model: measured.model,
      provider: measured.provider,
    },
    turnStatus: done?.turn.status,
    turnCode: done?.turn.code || null,
  };
}

try {
  if (!external) {
    created = true;
    compose(["build"]);
    compose(["run", "--rm", "--no-deps", "init"]);
    const setupKey = compose(
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
    await api("/setup", "POST", {
      setupKey,
      password: "live-local-model-test-password",
    });
  } else {
    const password = process.env.STERRACODE_LIVE_PASSWORD_FILE
      ? (
          await fs.readFile(process.env.STERRACODE_LIVE_PASSWORD_FILE, "utf8")
        ).trim()
      : process.env.STERRACODE_LIVE_PASSWORD || "smoke-password-safe";
    await api("/login", "POST", { password });
  }
  await api("/chat/settings", "PATCH", {
    provider: "lmstudio",
    lmStudioUrl: lmURL,
    activeModel: model,
    temperature: 0,
    maxTokensResponse: 256,
    maxToolCallsPerTurn: 1,
    allowAITerminalCommands: false,
    systemPrompt:
      "Antworte direkt auf die Nutzernachricht. Benutze für diese Verbindungstests keine Werkzeuge und stelle keine Rückfragen. Folge der angeforderten Antwortlänge.",
  });
  const listed = await api("/models");
  assert(listed.connected);
  assert(listed.models.some((entry) => entry.id === model));
  const connection = await api("/lm-studio/test", "POST", { url: lmURL });
  assert(connection.connected && connection.native && connection.tokenization);
  assert(connection.tokenCount > 0);
  const session = await api(
    "/sessions",
    "POST",
    { language: "javascript", title: "Isolierter LM Studio Live-Test" },
    201,
  );
  sessionId = session.id;
  const short = await streamTurn("Antworte ausschließlich mit STERRA_LIVE_OK.");
  assert(!short.timedOut);
  assert(short.text.includes("STERRA_LIVE_OK"));
  console.log(
    JSON.stringify({
      stage: "real-short-response",
      ok: true,
      model,
      durationMs: short.durationMs,
      context: short.context,
      response: short.text.slice(0, 160),
    }),
  );
  const usage = await api("/chat", "POST", {
    sessionId,
    userMessage: "/usage",
  });
  assert.equal(usage.contextUsage.measurementQuality, "exact");
  // Bonsai completes 512 tokens in ~8 s on the test host; 2048 exercises a real
  // 15-second heartbeat while the same 60-second request deadline remains.
  await api("/chat/settings", "PATCH", { maxTokensResponse: 2048 });
  const long = await streamTurn(
    "Schreibe eine ausführliche nummerierte Liste von 80 konkreten Tipps zum Erlernen von JavaScript. Erkläre jeden Tipp mit mindestens zwei vollständigen Sätzen. Beginne sofort bei 1 und schreibe ohne Zusammenfassung und ohne Rückfragen weiter.",
    { allowLimit: true },
  );
  assert(
    long.text.length > 0 || long.reasoningCharacters > 0,
    "Long live response produced neither visible text nor reasoning",
  );
  if (long.durationMs >= 16000)
    assert(
      long.heartbeats.length > 0,
      "A long real model response arrived without the 15-second SSE heartbeat",
    );
  console.log(
    JSON.stringify(
      {
        ok: true,
        at: new Date().toISOString(),
        project: external ? "provided-isolated-instance" : project,
        app: base,
        lmStudio: lmURL,
        model,
        nativeConnection: {
          tokenization: connection.tokenization,
          tokenCount: connection.tokenCount,
          contextLength: connection.contextLength,
        },
        short: { ...short, text: short.text.slice(0, 160) },
        long: {
          ...long,
          text: long.text.slice(0, 160),
          heartbeatResult: long.heartbeats.length
            ? "observed-during-real-model-response"
            : "response-completed-before-heartbeat-interval",
        },
        contextUsageCommand: usage.contextUsage.measurementQuality,
      },
      null,
      2,
    ),
  );
} finally {
  if (sessionId) {
    await api("/chat/abort", "POST", { sessionId }).catch(() => {});
    await api(`/sessions/${sessionId}`, "DELETE").catch(() => {});
  }
  if (created && process.env.STERRACODE_KEEP_LIVE_TEST !== "1")
    compose(["down", "--volumes", "--remove-orphans"]);
}
