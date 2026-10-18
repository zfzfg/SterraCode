// Optional live integration probe; execute in the built App image.
// node docker/check-lm.mjs http://192.168.178.64:1234 ternary-bonsai-2-27b
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { LMStudioClient } from "@lmstudio/sdk";
import { testLMStudioConnection } from "../server/services/lmStudio.js";
const url = process.argv[2] || process.env.STERRACODE_LM_STUDIO_URL;
const modelId = process.argv[3];
const result = await testLMStudioConnection({
  lmStudioUrl: url,
  activeModel: modelId,
});
assert.ok(
  result.connected && result.tokenization,
  `Native SDK-Prüfung fehlgeschlagen: ${JSON.stringify(result)}`,
);
const token = process.env.STERRACODE_LM_STUDIO_TOKEN_FILE
  ? (
      await fs.readFile(process.env.STERRACODE_LM_STUDIO_TOKEN_FILE, "utf8")
    ).trim()
  : "";
const base = new URL(url);
base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
const logger = Object.fromEntries(
  ["debug", "info", "warn", "error"].map((n) => [n, () => {}]),
);
const client = new LMStudioClient({
  baseUrl: base.href.replace(/\/$/, ""),
  logger,
  verboseErrorMessages: false,
  ...(token ? { apiToken: token } : {}),
});
const model = await client.llm.model(modelId);
const completion = await model.respond(
  [{ role: "user", content: "Reply with OK." }],
  { maxTokens: 8, temperature: 0 },
);
assert.ok(
  typeof completion.content === "string" && completion.content.length > 0,
);
console.log(
  JSON.stringify({
    ...result,
    inference: true,
    generatedCharacters: completion.content.length,
    model: modelId,
  }),
);
process.exit(0);
