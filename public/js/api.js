import { t, getLocale, translateMessage } from "./i18n.js";
export class APIError extends Error {
  constructor(message, status, code, metadata = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.messageKey = metadata.messageKey;
    this.params = metadata.params || {};
  }
}
let pendingMutations = 0;
export const getPendingMutationCount = () => pendingMutations;
export async function api(
  url,
  { method = "GET", body, signal, keepalive = false } = {},
) {
  const mutation = method.toUpperCase() !== "GET";
  if (mutation) pendingMutations++;
  try {
    return await request(url, { method, body, signal, keepalive });
  } finally {
    if (mutation) pendingMutations--;
  }
}
async function request(url, { method, body, signal, keepalive }) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "Accept-Language": getLocale(),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
      keepalive,
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new APIError(t("common:network.unavailable"), 0, "NETWORK");
  }
  const data = await response.json().catch(() => {
    throw new APIError(
      t("common:network.invalid"),
      response.status,
      "INVALID_RESPONSE",
    );
  });
  if (!response.ok) {
    if (
      (response.status === 401 || data.code === "SETUP_REQUIRED") &&
      !["/api/login", "/api/setup"].includes(url)
    )
      window.dispatchEvent(new CustomEvent("auth-required"));
    throw new APIError(
      translateMessage(data, data.error || response.statusText),
      response.status,
      data.code,
      data,
    );
  }
  return data;
}
export const sessionURL = (id) => `/api/sessions/${encodeURIComponent(id)}`;
export const workspaceURL = (id) => `/api/workspaces/${encodeURIComponent(id)}`;
export function uploadZip(url, file, { signal, onProgress } = {}) {
  pendingMutations++;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/zip");
    xhr.setRequestHeader("Accept-Language", getLocale());
    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    xhr.upload.onprogress = (event) =>
      onProgress?.(event.loaded, event.lengthComputable ? event.total : null);
    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(
          new APIError(
            t("common:network.invalid"),
            xhr.status,
            "INVALID_RESPONSE",
          ),
        );
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        if (xhr.status === 401 || data.code === "SETUP_REQUIRED")
          window.dispatchEvent(new CustomEvent("auth-required"));
        reject(
          new APIError(
            translateMessage(data, data.error || xhr.statusText),
            xhr.status,
            data.code,
            data,
          ),
        );
      }
    };
    xhr.onerror = () =>
      reject(new APIError(t("common:network.unavailable"), 0, "NETWORK"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    xhr.onloadend = () => {
      pendingMutations--;
      signal?.removeEventListener("abort", abort);
    };
    if (signal?.aborted) xhr.abort();
    else xhr.send(file);
  });
}
export async function streamChat(body, onEvent, signal) {
  let response;
  try {
    response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Language": getLocale(),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new APIError(t("common:network.unavailable"), 0, "NETWORK");
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: t("common:network.invalid"),
      code: "INVALID_RESPONSE",
    }));
    if (response.status === 401 || error.code === "SETUP_REQUIRED")
      window.dispatchEvent(new CustomEvent("auth-required"));
    throw new APIError(
      translateMessage(error, error.error),
      response.status,
      error.code,
      error,
    );
  }
  if (!response.body)
    throw new APIError(
      t("common:network.invalid"),
      response.status,
      "INVALID_RESPONSE",
    );
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
    let value;
    try {
      value = JSON.parse(data.join("\n"));
    } catch {
      throw new APIError(
        t("common:network.invalid"),
        response.status,
        "INVALID_RESPONSE",
      );
    }
    if (event === "error")
      throw new APIError(
        translateMessage(value, value.message),
        value.status,
        value.code,
        value,
      );
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
    if (!completed) throw new Error(t("common:network.interrupted"));
    return result;
  } catch (error) {
    if (error.name === "AbortError" || error instanceof APIError) throw error;
    throw new APIError(
      t("common:network.interrupted"),
      0,
      "STREAM_INTERRUPTED",
    );
  } finally {
    reader.releaseLock();
  }
}
