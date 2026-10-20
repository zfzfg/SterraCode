import { randomUUID } from "node:crypto";

// Waiting for a selection is durable idle state. Only actual work participates
// in update drain and session deletion.
const active = new Map();

export async function withCodebaseJob(metadata, operation) {
  const key = `${metadata.kind}:${metadata.id || randomUUID()}`;
  if (active.has(key)) return active.get(key).promise;
  const controller = new AbortController();
  const entry = {
    ...metadata,
    startedAt: new Date().toISOString(),
    controller,
  };
  active.set(key, entry);
  entry.promise = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await entry.promise;
  } finally {
    if (active.get(key) === entry) active.delete(key);
  }
}

export function listActiveCodebaseJobs() {
  return [...active.values()].map(({ controller, promise, ...entry }) => entry);
}

export function cancelCodebaseJob(id) {
  for (const entry of active.values())
    if (entry.id === id) entry.controller.abort();
}

export function cancelCodebaseJobsForSession(sessionId) {
  for (const entry of active.values())
    if (entry.sessionId === sessionId) entry.controller.abort();
}

export function interruptCodebaseJobs() {
  for (const entry of active.values()) entry.controller.abort();
}

export async function waitForCodebaseJobs() {
  await Promise.allSettled([...active.values()].map((entry) => entry.promise));
}
