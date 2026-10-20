import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  DATA_DIR,
  readJSON,
  writeJSON,
  listFiles,
  serial,
  getWorkspacePath,
  assertSessionWritable,
  validateSessionId,
} from "./storage.js";
import {
  readFile,
  normalizePath,
  writeFileUnlocked,
  getChange,
} from "./workspace.js";

const file = (sid, id) => path.join(DATA_DIR, "proposals", sid, `${id}.json`);
const hash = (s) => createHash("sha256").update(s).digest("hex");
const lines = (s) => s.match(/[^\n]*\n|[^\n]+$/g) || [];
// Exact, bounded line LCS. Nearby edits form one indivisible hunk, so their
// shared context cannot be independently selected. Large comparisons stay whole.
export function computeHunks(before, after) {
  const a = lines(before),
    b = lines(after);
  if (before === after) return [];
  if (a.length * b.length > 1000000 || a.length + b.length > 10000)
    return [
      {
        id: "hunk-1",
        start: 0,
        end: a.length,
        replacement: b.join(""),
        summary: "Gesamte Datei (Vergleichsgrenze)",
        summaryKey: "serverFeature:proposal.wholeFile",
        summaryParams: {},
        dependsOn: [],
      },
    ];
  const table = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j]
          ? 1 + table[i + 1][j + 1]
          : Math.max(table[i + 1][j], table[i][j + 1]);
  let i = 0,
    j = 0;
  const edits = [];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const start = i,
      target = j;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) break;
      if (
        j < b.length &&
        (i === a.length || table[i][j + 1] >= table[i + 1][j])
      )
        j++;
      else i++;
    }
    const prev = edits.at(-1);
    if (prev && start - prev.end < 6) {
      prev.replacement +=
        a.slice(prev.end, start).join("") + b.slice(target, j).join("");
      prev.end = i;
    } else
      edits.push({ start, end: i, replacement: b.slice(target, j).join("") });
  }
  const hunks = edits.map((e, n) => ({
    ...e,
    id: `hunk-${n + 1}`,
    summary: `Zeile ${e.start + 1}: ${e.end - e.start} entfernt, ${lines(e.replacement).length} hinzugefügt`,
    summaryKey: "serverFeature:proposal.hunkSummary",
    summaryParams: {
      line: e.start + 1,
      removed: e.end - e.start,
      added: lines(e.replacement).length,
    },
    dependsOn: [],
  }));
  // Conservative lexical dependency: a newly introduced identifier referenced
  // in another edit must be selected with its introducing edit. This does not
  // claim semantic analysis; shared-context edits are already indivisible.
  const identifiers = (text) =>
    new Set(text.match(/\b[A-Za-z_$][\w$]*\b/g) || []);
  const common = new Set(
    "if else return def function class const let var import from as for while true false None null print console log int str public private void new this self".split(
      " ",
    ),
  );
  const symbols = hunks.map((h) => identifiers(h.replacement));
  hunks.forEach((h, i) => {
    const old = identifiers(a.slice(h.start, h.end).join(""));
    for (const symbol of symbols[i]) {
      if (old.has(symbol) || common.has(symbol)) continue;
      hunks.forEach((other, j) => {
        if (
          i !== j &&
          symbols[j].has(symbol) &&
          !other.dependsOn.includes(h.id)
        )
          other.dependsOn.push(h.id);
      });
    }
  });
  return hunks;
}
export function selectHunks(proposal, ids) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !proposal.hunks.some((h) => h.id === id))
  )
    throw new AppError(
      "Bitte gültige, eindeutige Teiländerungen auswählen.",
      undefined,
      undefined,
      { messageKey: "serverFeature:proposal.invalidHunks", params: {} },
    );
  const chosen = proposal.hunks.filter((h) => ids.includes(h.id));
  for (const h of chosen)
    if (h.dependsOn.some((id) => !ids.includes(id)))
      throw new AppError(
        "Abhängige Teiländerungen gemeinsam auswählen.",
        undefined,
        undefined,
        { messageKey: "serverFeature:proposal.dependencies", params: {} },
      );
  const result = lines(proposal.before.content || "");
  for (const h of [...chosen].reverse())
    result.splice(h.start, h.end - h.start, ...lines(h.replacement));
  return result.join("");
}
async function base(sessionId, input) {
  try {
    return { exists: true, ...(await readFile(sessionId, input)) };
  } catch (e) {
    if (e.status === 404 || e.code === "ENOENT")
      return { exists: false, content: null, version: null };
    throw e;
  }
}
async function matchesBase(p) {
  try {
    return (await base(p.sessionId, p.path)).version === p.baseVersion;
  } catch (error) {
    if ([413, 415].includes(error.status)) return false;
    throw error;
  }
}
function metadata(p) {
  const { before, proposedContent, hunks, application, ...rest } = p;
  return { ...rest, hunkCount: hunks.length };
}
async function persist(p) {
  p.events ??= [];
  if (p.events.at(-1)?.status !== p.status) {
    p.events.push({
      type: "proposal_status",
      status: p.status,
      at: new Date().toISOString(),
      actor:
        p.status === "pending_review"
          ? "ai"
          : ["stale", "undone"].includes(p.status)
            ? "system"
            : "user",
      operationId: p.application?.operationId,
      selectedHunkIds: p.application?.selectedHunkIds,
      changeId: p.changeId,
    });
  }
  await writeJSON(file(p.sessionId, p.proposalId), p);
}
async function load(sessionId, id) {
  validateSessionId(id);
  await getWorkspacePath(sessionId);
  let p;
  try {
    p = await readJSON(file(sessionId, id));
  } catch (e) {
    if (e.code === "ENOENT")
      throw new AppError("Vorschlag nicht gefunden.", 404, undefined, {
        messageKey: "serverFeature:proposal.notFound",
        params: {},
      });
    throw e;
  }
  if (p.application && p.status === "pending_review") {
    // Recover a write interrupted between its durable history record and receipt.
    let change;
    try {
      change = await getChange(sessionId, p.application.changeId);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (
      change &&
      (change.status === "applied" ||
        change.status === "undone" ||
        (await base(sessionId, p.path)).version === change.afterVersion)
    ) {
      p.status = change.status === "undone" ? "undone" : p.application.status;
      p.changeId = change.id;
      p.version = change.afterVersion;
      p.selectedHunkIds = p.application.selectedHunkIds;
      if (change.status === "pending") {
        change.status = "applied";
        await writeJSON(
          path.join(DATA_DIR, "changes", sessionId, `${change.id}.json`),
          change,
        );
      }
      await persist(p);
    }
  }
  if (["applied", "partially_applied"].includes(p.status)) {
    const c = await getChange(sessionId, p.changeId);
    if (c.status === "undone") {
      p.status = "undone";
      await persist(p);
    }
  }
  if (p.status === "pending_review" && !(await matchesBase(p))) {
    p.status = "stale";
    await persist(p);
  }
  return p;
}
export async function proposeFile(
  sessionId,
  input,
  content,
  expectedVersion,
  { reason = "", turnId = null, operationId } = {},
) {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content) > 2 * 1024 * 1024 ||
    content.includes("\0")
  )
    throw new AppError("Ungültiger oder zu großer Vorschlag.", 413, undefined, {
      messageKey: "serverFeature:proposal.invalid",
      params: {},
    });
  const relative = normalizePath(input);
  if (
    operationId !== undefined &&
    (typeof operationId !== "string" || operationId.length > 200)
  )
    throw new AppError("Ungültige Vorgangskennung.", undefined, undefined, {
      messageKey: "serverFeature:proposal.invalidOperation",
      params: {},
    });
  const fingerprint = hash(
    JSON.stringify([relative, content, expectedVersion, reason, turnId]),
  );
  return serial(`workspace:${sessionId}`, async () => {
    await getWorkspacePath(sessionId);
    await assertSessionWritable(sessionId);
    for (const f of await listFiles(
      path.join(DATA_DIR, "proposals", sessionId),
    )) {
      const old = await readJSON(f);
      if (old.operationId === operationId && operationId !== undefined) {
        if (old.fingerprint !== fingerprint)
          throw new AppError(
            "Vorgangskennung bereits anders verwendet.",
            409,
            undefined,
            {
              messageKey: "serverFeature:proposal.operationConflict",
              params: {},
            },
          );
        const current = await load(sessionId, old.proposalId);
        return {
          type: "write_file",
          ...metadata(current),
          status:
            current.status === "pending_review" ? "proposed" : current.status,
          proposalStatus: current.status,
        };
      }
    }
    const before = await base(sessionId, relative);
    if (expectedVersion === undefined || before.version !== expectedVersion)
      throw new AppError(
        "Vorschlagsbasis inzwischen verändert.",
        409,
        "CONFLICT",
        { messageKey: "serverFeature:proposal.baseChanged", params: {} },
      );
    const p = {
      schemaVersion: 1,
      proposalId: randomUUID(),
      sessionId,
      turnId,
      operationId,
      fingerprint,
      path: relative,
      baseVersion: before.version,
      before,
      proposedContent: content,
      reason,
      origin: "ai",
      status: "pending_review",
      hunks: computeHunks(before.content || "", content),
      createdAt: new Date().toISOString(),
    };
    await persist(p);
    return {
      type: "write_file",
      ...metadata(p),
      status: "proposed",
      proposalStatus: p.status,
    };
  });
}
export async function getProposal(sid, id) {
  return serial(`workspace:${sid}`, async () => {
    await assertSessionWritable(sid);
    return load(sid, id);
  });
}
export async function listProposals(sid) {
  await getWorkspacePath(sid);
  const files = await listFiles(path.join(DATA_DIR, "proposals", sid));
  const records = await Promise.all(files.map((f) => readJSON(f)));
  const recent = records
    .sort(
      (a, b) =>
        Number(b.status === "pending_review") -
          Number(a.status === "pending_review") ||
        b.createdAt.localeCompare(a.createdAt),
    )
    .slice(0, 100);
  return Promise.all(
    recent.map(async (p) => metadata(await getProposal(sid, p.proposalId))),
  );
}
export async function decideProposal(sid, id, action, request = {}) {
  return serial(`workspace:${sid}`, async () => {
    await assertSessionWritable(sid);
    const p = await load(sid, id);
    if (action === "reject") {
      if (p.status === "rejected") return metadata(p);
      if (!["pending_review", "stale"].includes(p.status))
        throw new AppError("Vorschlag bereits entschieden.", 409, "CONFLICT", {
          messageKey: "serverFeature:proposal.alreadyDecided",
          params: {},
        });
      p.status = "rejected";
      p.decidedAt = new Date().toISOString();
      await persist(p);
      return metadata(p);
    }
    validateSessionId(request.operationId);
    const ids = request.selectedHunkIds ?? p.hunks.map((h) => h.id);
    const signature = hash(JSON.stringify([request.expectedVersion, ids]));
    if (p.application) {
      if (
        p.application.operationId !== request.operationId ||
        p.application.signature !== signature
      )
        throw new AppError(
          "Vorschlag bereits übernommen oder anderer Vorgang offen.",
          409,
          "CONFLICT",
          { messageKey: "serverFeature:proposal.alreadyApplied", params: {} },
        );
      if (p.status !== "pending_review") return metadata(p);
    }
    if (
      p.status !== "pending_review" ||
      request.expectedVersion !== p.baseVersion
    )
      throw new AppError(
        "Vorschlag veraltet. Bitte auf dem aktuellen Dateistand neu erstellen.",
        409,
        "CONFLICT",
        { messageKey: "serverFeature:proposal.stale", params: {} },
      );
    const content = selectHunks(p, ids);
    p.application ??= {
      operationId: request.operationId,
      signature,
      changeId: randomUUID(),
      selectedHunkIds: ids,
      status: ids.length === p.hunks.length ? "applied" : "partially_applied",
    };
    await persist(p);
    const result = await writeFileUnlocked(
      sid,
      p.path,
      content,
      p.baseVersion,
      {
        actor: "ai",
        reason: p.reason,
        turnId: p.turnId,
        proposalId: id,
        changeId: p.application.changeId,
      },
    );
    p.status = p.application.status;
    p.changeId = result.changeId;
    p.version = result.version;
    p.selectedHunkIds = ids;
    p.decidedAt = new Date().toISOString();
    await persist(p);
    return metadata(p);
  });
}
