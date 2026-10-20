import { it, expect, vi, afterEach } from "vitest";
import {
  api,
  APIError,
  streamChat,
  getPendingMutationCount,
} from "../public/js/api.js";
afterEach(() => vi.unstubAllGlobals());
it("localizes initial stream transport failures and preserves cancellation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("native network detail")),
  );
  await expect(streamChat({}, () => {})).rejects.toMatchObject({
    message:
      "Der SterraCode-Server ist nicht erreichbar. Bitte Serveradresse und Verbindung prüfen.",
    code: "NETWORK",
  });
  const aborted = new DOMException("cancelled", "AbortError");
  fetch.mockRejectedValue(aborted);
  await expect(streamChat({}, () => {})).rejects.toBe(aborted);
});
it("rejects malformed JSON and stream frames with a localized APIError", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(
        async () => new Response("native secret body", { status: 500 }),
      ),
  );
  await expect(streamChat({}, () => {})).rejects.toMatchObject({
    message: "Ungültige Serverantwort.",
    code: "INVALID_RESPONSE",
  });
  await expect(
    api("/api/example", { method: "POST", body: {} }),
  ).rejects.toBeInstanceOf(APIError);
  expect(getPendingMutationCount()).toBe(0);
  fetch.mockImplementation(
    async () =>
      new Response("data: invalid-json\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
  );
  await expect(streamChat({}, () => {})).rejects.toMatchObject({
    message: "Ungültige Serverantwort.",
    code: "INVALID_RESPONSE",
  });
});
