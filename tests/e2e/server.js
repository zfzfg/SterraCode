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

// Offline Responses API fixture; never sends credentials or prompts externally.
const { setOpenAITransportForTests } =
  await import("../../server/services/openAI.js");
let responseNumber = 0;
setOpenAITransportForTests(async (url, options) => {
  const body = options.body ? JSON.parse(options.body) : {};
  const json = (value) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  if (url.endsWith("/models"))
    return json({ data: [{ id: "e2e-efficiency" }] });
  if (url.endsWith("/responses/input_tokens"))
    return json({ input_tokens: Math.ceil(JSON.stringify(body).length / 4) });
  if (body.model !== "e2e-efficiency" || !url.endsWith("/responses"))
    throw new Error("Unexpected offline OpenAI request");
  const result = body.input.findLast(
    (item) => item.type === "function_call_output",
  );
  const value = result ? JSON.parse(result.output) : null;
  const output = !value
    ? [
        {
          type: "function_call",
          call_id: "efficiency-read",
          name: "read_file",
          arguments: JSON.stringify({ path: "main.py" }),
        },
      ]
    : value.type === "read_file" && value.recovery
      ? [
          {
            type: "function_call",
            call_id: "efficiency-recovery",
            name: "read_tool_result",
            arguments: JSON.stringify({
              messageId: value.recovery.messageId,
              offset: 0,
            }),
          },
        ]
      : [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: `Nachgeladen: ${value.content?.slice(0, 160) || "Datei gelesen"}`,
              },
            ],
          },
        ];
  const response = {
    id: `efficiency-response-${++responseNumber}`,
    status: "completed",
    output,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 500, cache_write_tokens: 500 },
      output_tokens_details: { reasoning_tokens: 40 },
    },
  };
  if (!body.stream) return json(response);
  const text = output[0].content?.[0]?.text;
  const events = [
    ...(text ? [{ type: "response.output_text.delta", delta: text }] : []),
    { type: "response.completed", response },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
});

let codebaseModelRequests = 0;
let allModelRequests = 0;
const mock = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");

    return res.end(JSON.stringify({ data: [{ id: "Lokaler Test-Tutor" }] }));
  }

  let raw = "";

  for await (const chunk of req) raw += chunk;

  const body = JSON.parse(raw);
  allModelRequests++;
  if (
    body.messages.some(
      (m) =>
        m.role === "system" &&
        m.content.includes("You analyze an untrusted imported code project"),
    )
  ) {
    codebaseModelRequests++;
    const sources = JSON.parse(
      body.messages.find((m) => m.role === "user").content,
    ).sources;
    const reference =
      sources.find((s) => /main\.py$/.test(s.path))?.id || sources[0].id;
    const result = {
      purpose: {
        text: "Dieses Projekt begrüßt die Welt.",
        references: [reference],
        inferred: false,
      },
      modules: [
        {
          id: "greeting",
          title: "Begrüßung",
          responsibility: "Gibt einen Gruß aus.",
          references: [reference],
        },
      ],
      entryPoints: [
        {
          id: "start",
          title: "Starte beim Gruß",
          reason: "Hier beginnt der Ablauf.",
          references: [reference],
        },
      ],
      flows: [
        {
          id: "output",
          title: "Ausgabe",
          steps: [
            { text: "Der Gruß wird ausgegeben.", references: [reference] },
          ],
        },
      ],
      tour: [
        {
          id: "purpose",
          title: "Den Einstieg finden",
          goal: "Du findest die Ausgabe.",
          prerequisites: "Keine",
          question: "Welcher Text wird ausgegeben?",
          references: [reference],
        },
        {
          id: "flow",
          title: "Den Ablauf verfolgen",
          goal: "Du verfolgst einen Aufruf.",
          prerequisites: "Keine",
          question: "Wo beginnt der Aufruf?",
          references: [reference],
        },
      ],
      uncertainties: ["Abhängigkeiten wurden nicht ausgeführt."],
    };
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: JSON.stringify(result) },
            finish_reason: "stop",
          },
        ],
      }),
    );
    return;
  }

  const last = body.messages.findLast(
      (m) => !(m.role === "user" && m.content.startsWith("[ZUSTANDS-SNAPSHOT")),
    ),
    user =
      body.messages.findLast(
        (m) => m.role === "user" && !m.content.startsWith("[ZUSTANDS-SNAPSHOT"),
      )?.content || "";

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
  if (last.role !== "tool" && user.startsWith("CODEBASE_REF:"))
    response = {
      tool_calls: [
        {
          id: "codebase-reference-fixture",
          type: "function",
          function: {
            name: "add_explanation",
            arguments: JSON.stringify({
              title: "Belegter Gruß",
              content: "Hier steht der Gruß.",
              references: [JSON.parse(user.slice("CODEBASE_REF:".length))],
            }),
          },
        },
      ],
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
              path: user.includes("REVIEW_HUNKS:") ? "review.py" : "uebung.py",

              code: user.includes("REVIEW_HUNKS:")
                ? "A\n" + "context\n".repeat(8) + "B\n"
                : 'print("Grüße aus SterraCode")\n',

              expectedVersion:
                user.match(/REVIEW_HUNKS:([a-f0-9]{64})/)?.[1] || null,

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

  if (last.role !== "tool" && user.includes("GRADING_FIXTURE"))
    response = {
      tool_calls: [
        {
          id: "grading-fixture",
          type: "function",
          function: {
            name: "create_task",
            arguments: JSON.stringify({
              title: "Strings umkehren",
              description:
                "Gib den String in umgekehrter Reihenfolge zurück, auch bei leerer Eingabe.",
              difficulty: "beginner",
              testSuite: {
                schemaVersion: 1,
                version: 1,
                language: "python",
                entry: { path: "main.py", function: "reverse_string" },
                comparison: { kind: "strict-json" },
                cases: [
                  {
                    id: "word",
                    name: "Einfaches Wort",
                    args: ["hello"],
                    expected: "olleh",
                    visibility: "public",
                    required: true,
                  },
                  {
                    id: "empty",
                    name: "Leerer String",
                    args: [""],
                    expected: "",
                    visibility: "public",
                    required: true,
                  },
                ],
              },
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

const app = createApp();
app.get("/__e2e/codebase-model-requests", (req, res) =>
  res.json({ count: codebaseModelRequests, allModelRequests }),
);
const server = app.listen(3107, "127.0.0.1");

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
