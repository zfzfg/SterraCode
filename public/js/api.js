export class APIError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export async function api(
  url,
  { method = "GET", body, signal, keepalive = false } = {},
) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
      keepalive,
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new APIError(
      "Der SterraCode-Server ist nicht erreichbar. Bitte Serveradresse und Verbindung prüfen.",
      0,
      "NETWORK",
    );
  }
  const data = await response
    .json()
    .catch(() => ({ error: "Ungültige Serverantwort." }));
  if (!response.ok) {
    if (
      (response.status === 401 || data.code === "SETUP_REQUIRED") &&
      !["/api/login", "/api/setup"].includes(url)
    )
      window.dispatchEvent(new CustomEvent("auth-required"));
    throw new APIError(
      data.error || response.statusText,
      response.status,
      data.code,
    );
  }
  return data;
}
export const sessionURL = (id) => `/api/sessions/${encodeURIComponent(id)}`;
export const workspaceURL = (id) => `/api/workspaces/${encodeURIComponent(id)}`;
export async function streamChat(body, onEvent, signal) {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error = await response.json();
    throw new APIError(error.error, response.status, error.code);
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    completed = false,
    result;
  function consume(frame) {
    let event = "message";
    const data = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const value = JSON.parse(data.join("\n"));
    if (event === "error") throw new Error(value.message);
    if (event === "done") {
      completed = true;
      result = value;
    }
    onEvent(event, value);
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || "";
      for (const frame of frames) consume(frame);
      if (done) {
        if (buffer.trim()) consume(buffer);
        break;
      }
    }
    if (!completed)
      throw new Error(
        "Die Verbindung wurde unterbrochen. Bereits ausgeführte Schritte bleiben gespeichert.",
      );
    return result;
  } finally {
    reader.releaseLock();
  }
}
