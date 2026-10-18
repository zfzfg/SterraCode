import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { httpFixtureFactory } from "../helpers/lmStudio.js";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "sterracode-e2e-"));
process.env.STERRACODE_DATA_DIR = root;
const { setLMStudioClientFactory } =
  await import("../../server/services/lmStudio.js");
const { ensureDataDirs, updateSettings } =
  await import("../../server/services/storage.js");
const { createApp } = await import("../../server/app.js");
const { stopAllProcesses } = await import("../../server/services/processes.js");
const mock = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ data: [{ id: "Lokaler Test-Tutor" }] }));
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const last = body.messages.at(-1),
    user = body.messages.findLast((m) => m.role === "user")?.content || "";
  if (!body.tools?.length && user.includes("COMPRESS_SLOW")) {
    const timer = setTimeout(() => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Zusammengefasster Lernstand.",
              },
            },
          ],
        }),
      );
    }, 8000);
    res.on("close", () => clearTimeout(timer));
    return;
  }
  let response = {
    content:
      "Wir lernen Schritt für Schritt. Was möchtest du als Nächstes ausprobieren?",
  };
  if (last.role !== "tool" && /erstelle.*übung/i.test(user))
    response = {
      tool_calls: [
        {
          id: "write-fixture",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "uebung.py",
              code: 'print("Grüße aus SterraCode")\n',
              expectedVersion: null,
              reason: "Deine erste Übung",
            }),
          },
        },
        {
          id: "plan-fixture",
          type: "function",
          function: {
            name: "update_learning_plan",
            arguments: JSON.stringify({
              goal: "Python verstehen",
              topics: [
                { id: "first", title: "Ausgaben verstehen", done: false },
                { id: "second", title: "Variablen nutzen", done: false },
              ],
            }),
          },
        },
        {
          id: "question-fixture",
          type: "function",
          function: {
            name: "ask_question",
            arguments: JSON.stringify({
              question: "Welches Thema interessiert dich?",
              type: "multiple-choice",
              options: ["Variablen", "Schleifen"],
            }),
          },
        },
      ],
    };
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`,
      );
    if (/warte/i.test(user)) {
      send({ content: "Ich prüfe das …" });
      const timer = setInterval(() => res.write(": wait\n\n"), 1000);
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (response.tool_calls) {
      for (const [index, call] of response.tool_calls.entries()) {
        const split = Math.floor(call.function.arguments.length / 2);
        send({
          tool_calls: [
            {
              index,
              id: call.id,
              type: "function",
              function: {
                name: call.function.name,
                arguments: call.function.arguments.slice(0, split),
              },
            },
          ],
        });
        send({
          tool_calls: [
            {
              index,
              function: { arguments: call.function.arguments.slice(split) },
            },
          ],
        });
      }
      send({}, "tool_calls");
    } else {
      send({ content: response.content.slice(0, 18) });
      send({ content: response.content.slice(18) }, "stop");
    }
    res.end("data: [DONE]\n\n");
  } else {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", ...response },
            finish_reason: response.tool_calls ? "tool_calls" : "stop",
          },
        ],
      }),
    );
  }
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
await ensureDataDirs();
setLMStudioClientFactory(httpFixtureFactory({ probe: true }));
await updateSettings({
  lmStudioUrl: `http://127.0.0.1:${mock.address().port}`,
  activeModel: "Lokaler Test-Tutor",
});
const server = createApp().listen(3107, "127.0.0.1");
async function shutdown() {
  await stopAllProcesses();
  server.closeAllConnections();
  mock.closeAllConnections();
  server.close();
  mock.close();
  if (root.startsWith(path.join(os.tmpdir(), "sterracode-e2e-")))
    await fs.rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
