import { beforeAll, afterAll, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
let root, storage, sessions, ws, proposals, tools;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterracode-review-"));
  vi.stubEnv("STERRACODE_DATA_DIR", root);
  vi.stubEnv("STERRACODE_WORKSPACE_DIR", path.join(root, "workspaces"));
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  ws = await import("../server/services/workspace.js");
  proposals = await import("../server/services/proposals.js");
  tools = await import("../server/services/toolExecutor.js");
  await storage.ensureDataDirs();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const s = await sessions.createSession();
  const before = "a\n" + "context\n".repeat(8) + "b\n";
  const target = "A\n" + "context\n".repeat(8) + "B\n";
  const f = await ws.writeFile(s.id, "review.py", before, null);
  const p = await proposals.proposeFile(s.id, f.path, target, f.version, {
    reason: "Zwei Änderungen",
    turnId: randomUUID(),
    operationId: randomUUID(),
  });
  return { s, f, p, before, target };
}
it("preserves both historical snapshots after later writes and rename; old records never invent a diff", async () => {
  const { s, f } = await fixture();
  const change = await ws.writeFile(s.id, f.path, "historical", f.version, {
    actor: "ai",
  });
  await ws.writeFile(s.id, f.path, "new", change.version);
  await ws.renamePath(s.id, f.path, "renamed.py");
  const record = await ws.getChange(s.id, change.changeId);
  expect(record.after.content).toBe("historical");
  expect(record.historicalPath).toBe(f.path);
  delete record.after;
  const location = path.join(root, "changes", s.id, `${record.id}.json`);
  await storage.writeJSON(location, record);
  expect((await ws.getChange(s.id, record.id)).diffAvailable).toBe(false);
  await ws.writeFile(
    s.id,
    "renamed.py",
    "historical",
    (await ws.readFile(s.id, "renamed.py")).version,
  );
  expect((await ws.getChange(s.id, record.id)).after.content).toBe(
    "historical",
  );
});
it("applies selected server hunks exactly once concurrently and safely undoes", async () => {
  const { s, f, p, before } = await fixture();
  const detail = await proposals.getProposal(s.id, p.proposalId);
  expect(detail.hunks).toHaveLength(2);
  const request = {
    operationId: randomUUID(),
    expectedVersion: f.version,
    selectedHunkIds: [detail.hunks[0].id],
  };
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      proposals.decideProposal(s.id, p.proposalId, "apply", request),
    ),
  );
  expect(new Set(results.map((r) => r.changeId)).size).toBe(1);
  expect(results[0].status).toBe("partially_applied");
  expect(await ws.listChanges(s.id)).toHaveLength(1);
  expect((await ws.readFile(s.id, f.path)).content).toBe(
    before.replace("a\n", "A\n"),
  );
  await expect(
    proposals.decideProposal(s.id, p.proposalId, "apply", {
      ...request,
      operationId: randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 409 });
  await ws.undoChange(s.id, results[0].changeId);
  expect((await ws.readFile(s.id, f.path)).content).toBe(before);
  expect((await proposals.getProposal(s.id, p.proposalId)).status).toBe(
    "undone",
  );
});
it("rejects invalid, empty, duplicate and dependent selections without writing", async () => {
  const { s, f, p } = await fixture();
  for (const selectedHunkIds of [[], ["invented"], ["hunk-1", "hunk-1"]]) {
    await expect(
      proposals.decideProposal(s.id, p.proposalId, "apply", {
        operationId: randomUUID(),
        expectedVersion: f.version,
        selectedHunkIds,
      }),
    ).rejects.toBeTruthy();
  }
  expect(await ws.listChanges(s.id)).toHaveLength(0);
  const d = await proposals.getProposal(s.id, p.proposalId);
  d.hunks[0].dependsOn = ["hunk-2"];
  expect(() => proposals.selectHunks(d, ["hunk-1"])).toThrow(/gemeinsam/);
});
it.each(["autosave", "rename", "delete", "undo"])(
  "conflicts on %s and never overwrites newer contents",
  async (kind) => {
    const { s, f, p } = await fixture();
    if (kind === "autosave")
      await ws.writeFile(s.id, f.path, "newer", f.version);
    if (kind === "rename") await ws.renamePath(s.id, f.path, "moved.py");
    if (kind === "delete") await ws.deletePath(s.id, f.path);
    if (kind === "undo") {
      const c = await ws.writeFile(s.id, "other.py", "old", null, {
        actor: "ai",
      });
      const other = await proposals.proposeFile(
        s.id,
        "other.py",
        "proposal",
        c.version,
        { reason: "test", turnId: randomUUID(), operationId: randomUUID() },
      );
      await ws.undoChange(s.id, c.changeId);
      await expect(
        proposals.decideProposal(s.id, other.proposalId, "apply", {
          operationId: randomUUID(),
          expectedVersion: c.version,
        }),
      ).rejects.toMatchObject({ status: 409 });
      return;
    }
    await expect(
      proposals.decideProposal(s.id, p.proposalId, "apply", {
        operationId: randomUUID(),
        expectedVersion: f.version,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await proposals.getProposal(s.id, p.proposalId)).status).toBe(
      "stale",
    );
  },
);
it("persists rejection, scopes IDs to sessions and deduplicates creation", async () => {
  const { s, f, p, target } = await fixture();
  const d = await proposals.getProposal(s.id, p.proposalId);
  const repeat = await proposals.proposeFile(s.id, f.path, target, f.version, {
    reason: d.reason,
    turnId: d.turnId,
    operationId: d.operationId,
  });
  expect(repeat.proposalId).toBe(p.proposalId);
  await expect(
    proposals.proposeFile(s.id, "../escape.py", "bad", null, {}),
  ).rejects.toBeTruthy();
  await expect(
    proposals.getProposal((await sessions.createSession()).id, p.proposalId),
  ).rejects.toMatchObject({ status: 404 });
  await proposals.decideProposal(s.id, p.proposalId, "reject");
  expect(
    (await proposals.decideProposal(s.id, p.proposalId, "reject")).status,
  ).toBe("rejected");
  expect((await ws.readFile(s.id, f.path)).content).toBe(f.content);
});
it("recovers a committed application after receipt loss without duplicate history", async () => {
  const { s, f, p } = await fixture();
  const saved = await proposals.getProposal(s.id, p.proposalId);
  const request = { operationId: randomUUID(), expectedVersion: f.version };
  const applied = await proposals.decideProposal(
    s.id,
    p.proposalId,
    "apply",
    request,
  );
  const disk = await storage.readJSON(
    path.join(root, "proposals", s.id, `${p.proposalId}.json`),
  );
  await storage.writeJSON(
    path.join(root, "proposals", s.id, `${p.proposalId}.json`),
    { ...saved, application: disk.application },
  );
  expect(
    (await proposals.decideProposal(s.id, p.proposalId, "apply", request))
      .changeId,
  ).toBe(applied.changeId);
  expect(await ws.listChanges(s.id)).toHaveLength(1);
});
it("review mode returns proposed without writing; default mode stays direct; context keeps live IDs", async () => {
  const s = await sessions.createSession();
  const args = {
    path: "tool.py",
    code: "print(1)",
    reason: "test",
    expectedVersion: null,
  };
  await storage.updateSettings({ reviewAIChanges: false });
  const direct = await tools.executeTool("write_file", args, {
    sessionId: s.id,
    turnId: randomUUID(),
    toolCallId: "direct",
  });
  expect(direct.status).toBe("applied");
  await storage.updateSettings({ reviewAIChanges: true });
  const ctx = { sessionId: s.id, turnId: randomUUID(), toolCallId: "proposal" };
  const result = await tools.executeTool(
    "write_file",
    { ...args, path: "proposed.py" },
    ctx,
  );
  expect(result.status).toBe("proposed");
  expect(
    (
      await tools.executeTool(
        "write_file",
        { ...args, path: "proposed.py" },
        ctx,
      )
    ).proposalId,
  ).toBe(result.proposalId);
  await expect(ws.readFile(s.id, "proposed.py")).rejects.toMatchObject({
    status: 404,
  });
  const { workflowState } =
    await import("../server/services/context/workflow.js");
  const records = await workflowState(await sessions.loadSession(s.id));
  expect(records).toContainEqual(
    expect.objectContaining({
      proposalId: result.proposalId,
      status: "pending_review",
      baseVersion: null,
    }),
  );
});
it("bounded hunk fallback and line endings produce exact target", () => {
  for (const [before, after] of [
    ["a\r\nb\r\n", "a\r\nc"],
    ["", "new\n"],
    ["old", ""],
    ["x\n".repeat(1100), "y\n".repeat(1100)],
  ]) {
    const p = {
      before: { content: before },
      hunks: proposals.computeHunks(before, after),
    };
    expect(
      proposals.selectHunks(
        p,
        p.hunks.map((h) => h.id),
      ),
    ).toBe(after);
  }
});

it("groups nearby edits and detects cross-hunk introduced identifiers", () => {
  expect(proposals.computeHunks("a\nkeep\nb\n", "A\nkeep\nB\n")).toHaveLength(
    1,
  );
  const before = "pass\n" + "# context\n".repeat(8) + "print(0)\n";
  const after =
    "def helper(): return 1\n" + "# context\n".repeat(8) + "print(helper())\n";
  const p = {
    before: { content: before },
    hunks: proposals.computeHunks(before, after),
  };
  expect(p.hunks).toHaveLength(2);
  expect(p.hunks[1].dependsOn).toContain("hunk-1");
  expect(() => proposals.selectHunks(p, ["hunk-2"])).toThrow(/gemeinsam/);
  expect(proposals.selectHunks(p, ["hunk-1", "hunk-2"])).toBe(after);
});
it("retries a prepared commit and recovers a pending history record after the file write", async () => {
  const { s, f, p } = await fixture();
  const request = { operationId: randomUUID(), expectedVersion: f.version };
  const original = fs.rename.bind(fs);
  const write = vi.spyOn(fs, "rename");
  write.mockImplementation(async (from, to) => {
    if (to === path.join(root, "workspaces", s.id, f.path))
      throw new Error("simulated interruption");
    return original(from, to);
  });
  await expect(
    proposals.decideProposal(s.id, p.proposalId, "apply", request),
  ).rejects.toThrow("interruption");
  write.mockRestore();
  expect((await proposals.getProposal(s.id, p.proposalId)).status).toBe(
    "pending_review",
  );
  const saved = await proposals.getProposal(s.id, p.proposalId);
  const applied = await proposals.decideProposal(
    s.id,
    p.proposalId,
    "apply",
    request,
  );
  const journal = path.join(root, "changes", s.id, `${applied.changeId}.json`);
  const change = await storage.readJSON(journal);
  change.status = "pending";
  await storage.writeJSON(journal, change);
  await storage.writeJSON(
    path.join(root, "proposals", s.id, `${p.proposalId}.json`),
    saved,
  );
  const recovered = await proposals.decideProposal(
    s.id,
    p.proposalId,
    "apply",
    request,
  );
  expect(recovered.changeId).toBe(applied.changeId);
  expect((await storage.readJSON(journal)).status).toBe("applied");
  expect(
    (await proposals.getProposal(s.id, p.proposalId)).events.filter(
      (e) => e.status === "applied",
    ),
  ).toHaveLength(1);
  expect(await ws.listChanges(s.id)).toHaveLength(1);
});
it("reconstructs exact targets for repeated lines, insertions and removals", () => {
  let seed = 31;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let k = 0; k < 150; k++) {
    const sample = () =>
      Array.from(
        { length: 1 + Math.floor(random() * 25) },
        () => ["a\n", "b\n", "\n", "c\r\n"][Math.floor(random() * 4)],
      ).join("");
    const before = sample(),
      after = sample();
    const p = {
      before: { content: before },
      hunks: proposals.computeHunks(before, after),
    };
    if (p.hunks.length)
      expect(
        proposals.selectHunks(
          p,
          p.hunks.map((h) => h.id),
        ),
      ).toBe(after);
    else expect(before).toBe(after);
  }
});

it("defers creation of nested directories until acceptance and conflicts on a binary replacement", async () => {
  const s = await sessions.createSession();
  const p = await proposals.proposeFile(
    s.id,
    "new/folder/code.py",
    "print(1)",
    null,
    { reason: "Nested file" },
  );
  await expect(
    fs.access(path.join(root, "workspaces", s.id, "new")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await proposals.decideProposal(s.id, p.proposalId, "apply", {
    operationId: randomUUID(),
    expectedVersion: null,
  });
  const current = await ws.readFile(s.id, p.path);
  const next = await proposals.proposeFile(
    s.id,
    p.path,
    "print(2)",
    current.version,
  );
  await fs.writeFile(
    path.join(root, "workspaces", s.id, p.path),
    Buffer.from([0, 255]),
  );
  expect((await proposals.getProposal(s.id, next.proposalId)).status).toBe(
    "stale",
  );
  await expect(
    proposals.decideProposal(s.id, next.proposalId, "apply", {
      operationId: randomUUID(),
      expectedVersion: current.version,
    }),
  ).rejects.toMatchObject({ status: 409 });
});
