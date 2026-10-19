import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  setLMStudioClientFactory,
  listLoadedModels,
  listModelOptions,
  testLMStudioConnection,
  lmStudioWarning,
} from "../server/services/lmStudio.js";

let temp;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "sterracode-lm-secret-"));
  vi.stubEnv("STERRACODE_LM_STUDIO_TOKEN_FILE", "");
  vi.stubEnv("STERRACODE_LM_STUDIO_OVERRIDE_URL", "");
  vi.stubEnv("STERRACODE_MODE", "local");
});
afterEach(async () => {
  setLMStudioClientFactory();
  vi.unstubAllEnvs();
  await fs.rm(temp, { recursive: true, force: true });
});
describe("native LM Studio secrets and connection checks", () => {
  it("exposes the loaded context window and refreshes it after a configuration change", async () => {
    let contextLength = 8192;
    setLMStudioClientFactory(() => ({
      llm: {
        listLoaded: async () => [
          { identifier: "loaded", getContextLength: async () => contextLength },
        ],
      },
    }));
    const settings = { provider: "lmstudio", lmStudioUrl: "http://host:1234" };
    expect(await listModelOptions(settings)).toEqual([
      { id: "loaded", name: "loaded", contextLength: 8192 },
    ]);
    contextLength = 24576;
    expect((await listModelOptions(settings))[0].contextLength).toBe(24576);
  });
  it("omits the optional SDK apiToken when no secret file is configured", async () => {
    const factory = vi.fn(() => ({ llm: { listLoaded: async () => [] } }));
    setLMStudioClientFactory(factory);
    await listLoadedModels({ lmStudioUrl: "http://host:1234" });
    expect(factory.mock.calls[0][0]).not.toHaveProperty("apiToken");
  });
  it("reads tokens only from a secret file and recreates clients after URL or token changes", async () => {
    const file = path.join(temp, "lm-token");
    await fs.writeFile(file, "first-private-token\n");
    vi.stubEnv("STERRACODE_LM_STUDIO_TOKEN_FILE", file);
    const optionsSeen = [];
    setLMStudioClientFactory((options) => {
      optionsSeen.push(options);
      return { llm: { listLoaded: async () => [] } };
    });
    const settings = { lmStudioUrl: "http://host.docker.internal:1234" };
    await listLoadedModels(settings);
    await listLoadedModels(settings);
    expect(optionsSeen).toEqual([
      {
        baseUrl: "ws://host.docker.internal:1234",
        apiToken: "first-private-token",
      },
    ]);
    await fs.writeFile(file, "second-private-token\n");
    await listLoadedModels(settings);
    expect(optionsSeen.at(-1).apiToken).toBe("second-private-token");
    await listLoadedModels({ lmStudioUrl: "https://model.example" });
    expect(optionsSeen.at(-1).baseUrl).toBe("wss://model.example");
    expect(optionsSeen).toHaveLength(3);
  });
  it("checks actual native tokenization and context functions", async () => {
    const countTokens = vi.fn(async () => 9),
      getContextLength = vi.fn(async () => 8192);
    setLMStudioClientFactory(() => ({
      llm: {
        listLoaded: async () => [
          { identifier: "test-model", countTokens, getContextLength },
        ],
      },
    }));
    const result = await testLMStudioConnection({
      lmStudioUrl: "http://host:1234",
      activeModel: "test-model",
    });
    expect(result).toMatchObject({
      status: "ready",
      connected: true,
      native: true,
      tokenization: true,
      contextLength: 8192,
      tokenCount: 9,
    });
    expect(countTokens).toHaveBeenCalledOnce();
    expect(getContextLength).toHaveBeenCalledOnce();
  });
  it("reports a reachable server without loaded models without requiring one for setup", async () => {
    setLMStudioClientFactory(() => ({ llm: { listLoaded: async () => [] } }));
    expect(
      await testLMStudioConnection({ lmStudioUrl: "http://host:1234" }),
    ).toMatchObject({
      connected: true,
      status: "no-model",
      tokenization: false,
    });
  });
  it("keeps SDK errors, addresses with credentials and tokens out of diagnostics", async () => {
    setLMStudioClientFactory(() => ({
      llm: {
        listLoaded: async () => {
          throw new Error("SECRET_VALUE");
        },
      },
    }));
    const result = await testLMStudioConnection({
      lmStudioUrl: "http://host:1234",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_VALUE");
    expect(result.connected).toBe(false);
    await expect(
      listLoadedModels({ lmStudioUrl: "http://user:SECRET_VALUE@host" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("reports imported localhost settings without changing them", async () => {
    vi.stubEnv("STERRACODE_MODE", "docker");
    const settings = { lmStudioUrl: "http://localhost:1234" };
    expect(lmStudioWarning(settings.lmStudioUrl)).toContain("Container");
    expect(await testLMStudioConnection(settings)).toMatchObject({
      connected: false,
      status: "invalid-container-address",
    });
    expect(settings.lmStudioUrl).toBe("http://localhost:1234");
  });
  it("applies an explicit administrative URL override", async () => {
    vi.stubEnv("STERRACODE_LM_STUDIO_OVERRIDE_URL", "https://override.example");
    const factory = vi.fn(() => ({ llm: { listLoaded: async () => [] } }));
    setLMStudioClientFactory(factory);
    await listLoadedModels({ lmStudioUrl: "http://localhost:1234" });
    expect(factory.mock.calls[0][0].baseUrl).toBe("wss://override.example");
  });
});
