import { beforeAll, afterAll, expect, it, vi, describe } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let root,
  storage,
  sessions,
  teacher,
  prompt,
  planCreationSkill,
  planContinuationSkill;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-plan-skill-"));
  vi.stubEnv("STERRACODE_DATA_DIR", root);
  vi.stubEnv("STERRACODE_WORKSPACE_DIR", path.join(root, "workspaces"));
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  teacher = await import("../server/services/teacher.js");
  prompt = await import("../server/services/context/prompt.js");
  ({ planCreationSkill, planContinuationSkill } =
    await import("../server/prompts/planSkill.js"));
  await storage.ensureDataDirs();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (
    path.dirname(root) === os.tmpdir() &&
    path.basename(root).startsWith("sterra-plan-skill-")
  )
    await fs.rm(root, { recursive: true, force: true });
});

const settings = () => ({ systemPrompt: "Basisregeln" });

describe("plan creation skill", () => {
  it("defines the shared structure schema for creation and continuation", () => {
    for (const skill of [planCreationSkill, planContinuationSkill]) {
      expect(skill).toContain("PLAN STRUCTURE SCHEMA");
      expect(skill).toContain("8-12 topics");
      expect(skill).toContain('"<level>.<index> <action-oriented title>"');
      expect(skill).toContain("overrides this default schema");
    }
    // The continuation plan must pick up where the finished plan ended.
    expect(planContinuationSkill).toContain("start harder");
  });

  it("stays inactive without a requested plan", () => {
    expect(prompt.planSkillText({})).toBe("");
    expect(prompt.systemPrompt(settings(), {})).not.toContain("LEARNING PLAN");
    expect(
      prompt.systemPrompt(settings(), {
        planRequested: true,
        learningPlan: {
          goal: "x",
          topics: [{ id: "a", title: "A", done: true }],
        },
      }),
    ).not.toContain("LEARNING PLAN");
  });

  it("activates after the create_plan answer and disappears once a plan exists", async () => {
    const s = await sessions.createSession({ tutorLocale: "en" });
    const question = s.messages[0].event;
    const base = prompt.systemPrompt(
      settings(),
      await sessions.loadSession(s.id),
    );
    expect(base).not.toContain(planCreationSkill);
    const answered = await teacher.answerQuestion(
      s.id,
      question.questionId,
      undefined,
      "create_plan",
    );
    expect(answered.session.planRequested).toBe(true);
    const withSkill = prompt.systemPrompt(
      settings(),
      await sessions.loadSession(s.id),
    );
    expect(withSkill).toContain(planCreationSkill);
    expect(withSkill).toContain(settings().systemPrompt);
    // The skill rides along the existing prompt contract; nothing else moves.
    expect(withSkill).toContain("STERRACODE_PROMPT_CONTRACT:1");
    await sessions.mutateSession(s.id, (session) =>
      sessions.setLearningPlan(session, {
        goal: "Master basic loops",
        topics: [
          { id: "while-loops", title: "While loops", done: false },
          { id: "for-loops", title: "For loops", done: false },
        ],
      }),
    );
    expect(
      prompt.systemPrompt(settings(), await sessions.loadSession(s.id)),
    ).not.toContain(planCreationSkill);
  });

  it("never activates for start_directly answers", async () => {
    const s = await sessions.createSession({ tutorLocale: "en" });
    await teacher.answerQuestion(
      s.id,
      s.messages[0].event.questionId,
      undefined,
      "start_directly",
    );
    const session = await sessions.loadSession(s.id);
    expect(session.planRequested).toBe(false);
    expect(prompt.systemPrompt(settings(), session)).not.toContain(
      planCreationSkill,
    );
  });
});

describe("plan continuation skill", () => {
  const completedPlan = {
    goal: "Master basic loops",
    topics: [{ id: "while-loops", title: "While loops", done: true }],
  };

  it("activates after continue_plan on a completed plan until a successor exists", async () => {
    const s = await sessions.createSession({ tutorLocale: "en" });
    await teacher.answerQuestion(
      s.id,
      s.messages[0].event.questionId,
      undefined,
      "start_directly",
    );
    await sessions.mutateSession(s.id, (session) => {
      sessions.setLearningPlan(session, completedPlan);
      session.planCompletedEventId = session.messages.at(-1).id;
    });
    const completed = await sessions.loadSession(s.id);
    const completedQuestion = completed.messages.findLast(
      (m) => m.event?.application?.template === "plan-completed",
    )?.event;
    const before = prompt.systemPrompt(settings(), completed);
    expect(before).not.toContain(planContinuationSkill);
    const answered = await teacher.answerQuestion(
      s.id,
      completedQuestion.questionId,
      undefined,
      "continue_plan",
    );
    expect(answered.session.planContinuationRequested).toBe(true);
    expect(
      prompt.systemPrompt(settings(), await sessions.loadSession(s.id)),
    ).toContain(planContinuationSkill);
    await sessions.mutateSession(s.id, (session) =>
      sessions.setLearningPlan(session, {
        goal: "Master recursion",
        topics: [
          { id: "recursion-basics", title: "Recursion basics", done: false },
        ],
      }),
    );
    expect(
      prompt.systemPrompt(settings(), await sessions.loadSession(s.id)),
    ).not.toContain(planContinuationSkill);
  });

  it("ignores finish_today and incomplete plans", async () => {
    const s = await sessions.createSession({ tutorLocale: "en" });
    await teacher.answerQuestion(
      s.id,
      s.messages[0].event.questionId,
      undefined,
      "start_directly",
    );
    await sessions.mutateSession(s.id, (session) => {
      sessions.setLearningPlan(session, completedPlan);
    });
    const completedQuestion = (
      await sessions.loadSession(s.id)
    ).messages.findLast(
      (m) => m.event?.application?.template === "plan-completed",
    )?.event;
    await teacher.answerQuestion(
      s.id,
      completedQuestion.questionId,
      undefined,
      "finish_today",
    );
    const session = await sessions.loadSession(s.id);
    expect(session.planContinuationRequested).toBe(false);
    expect(prompt.systemPrompt(settings(), session)).not.toContain(
      planContinuationSkill,
    );
    await sessions.mutateSession(s.id, (session) => {
      session.planContinuationRequested = true;
      sessions.setLearningPlan(session, {
        goal: "Halfway there",
        topics: [
          { id: "while-loops", title: "While loops", done: true },
          { id: "for-loops", title: "For loops", done: false },
        ],
      });
    });
    expect(
      prompt.systemPrompt(settings(), await sessions.loadSession(s.id)),
    ).not.toContain(planContinuationSkill);
  });
});

it("keeps deterministic prompts without spending snapshot tokens", () => {
  const session = { planRequested: true };
  expect(prompt.systemPrompt(settings(), session)).toBe(
    prompt.systemPrompt(settings(), { ...session, activeFile: "a.py" }),
  );
  expect(
    prompt.systemPrompt(settings(), {
      planRequested: true,
      learningPlan: null,
    }),
  ).toBe(prompt.systemPrompt(settings(), { planRequested: true }));
});
