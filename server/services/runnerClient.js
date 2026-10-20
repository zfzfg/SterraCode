import fs from "node:fs/promises";
import { AppError } from "./storage.js";

export function runnerEnabled() {
  return (
    process.env.STERRACODE_MODE === "docker" ||
    Boolean(process.env.STERRACODE_RUNNER_URL)
  );
}
export async function runnerRequest(
  route,
  {
    method = "GET",
    body,
    timeout = 10000,
    retries = method === "GET" || method === "DELETE" ? 2 : 0,
  } = {},
) {
  const base = process.env.STERRACODE_RUNNER_URL,
    file = process.env.STERRACODE_RUNNER_SECRET_FILE;
  if (!base || !file)
    throw new AppError(
      "Docker-Runner ist nicht konfiguriert.",
      503,
      "RUNNER_UNAVAILABLE",
      { messageKey: "serverFeature:runner.notConfigured", params: {} },
    );
  if (!route.startsWith("/v1/"))
    throw new AppError("Ungültiger Runner-Endpunkt.", 500, undefined, {
      messageKey: "serverFeature:runner.invalidEndpoint",
      params: {},
    });
  let secret;
  try {
    secret = (await fs.readFile(file, "utf8")).trim();
  } catch {
    throw new AppError(
      "Runner-Dienstschlüssel ist nicht lesbar.",
      503,
      "RUNNER_UNAVAILABLE",
      { messageKey: "serverFeature:runner.secretUnreadable", params: {} },
    );
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(new URL(route, base), {
        method,
        headers: {
          Authorization: `Bearer ${secret}`,
          "X-Runner-Protocol": "1",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
      });
      if (response.headers.get("x-runner-protocol") !== "1")
        throw new AppError(
          "App und Runner haben inkompatible Protokollversionen. Zusammen aktualisieren.",
          503,
          "RUNNER_PROTOCOL_MISMATCH",
          { messageKey: "serverFeature:runner.protocolMismatch", params: {} },
        );
      const value = await response.json();
      if (!response.ok)
        throw new AppError(
          value.error || "Runner-Anfrage fehlgeschlagen.",
          response.status,
          value.code || "RUNNER_ERROR",
          value.messageKey
            ? { messageKey: value.messageKey, params: value.params || {} }
            : !value.error
              ? { messageKey: "serverFeature:runner.requestFailed", params: {} }
              : {},
        );
      return value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (attempt >= retries)
        throw new AppError(
          "Der Runner ist nicht erreichbar. Es wurde kein lokaler Prozess gestartet.",
          503,
          "RUNNER_UNAVAILABLE",
          { messageKey: "serverFeature:runner.unavailable", params: {} },
        );
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}
export const getRunnerStatus = () => runnerRequest("/v1/status");
export const blockSession = (id) =>
  runnerRequest(`/v1/sessions/${encodeURIComponent(id)}/block`, {
    method: "POST",
    body: {},
    retries: 2,
    timeout: 15000,
  });
export const unblockSession = (id) =>
  runnerRequest(`/v1/sessions/${encodeURIComponent(id)}/block`, {
    method: "DELETE",
    body: {},
  });
