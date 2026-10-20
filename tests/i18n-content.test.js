import { beforeAll, afterAll, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fixtureModel, openAIMessages } from "./helpers/lmStudio.js";

let root,
  storage,
  sessions,
  concepts,
  projects,
  templates,
  workspace,
  teacher,
  profile,
  reviews,
  prompt,
  questions,
  ContextManager,
  OpenAIContext,
  sourceHash;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-i18n-content-"));
  vi.stubEnv("STERRACODE_DATA_DIR", root);
  vi.stubEnv("STERRACODE_WORKSPACE_DIR", path.join(root, "workspaces"));
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  concepts = await import("../server/services/concepts.js");
  projects = await import("../server/services/projects.js");
  templates = await import("../server/services/projectTemplates.js");
  workspace = await import("../server/services/workspace.js");
  teacher = await import("../server/services/teacher.js");
  profile = await import("../server/services/profileManager.js");
  reviews = await import("../server/services/learningReviews.js");
  prompt = await import("../server/services/context/prompt.js");
  questions = await import("../server/services/applicationQuestions.js");
  ({ ContextManager } = await import("../server/services/context/index.js"));
  ({ OpenAIContext } = await import("../server/services/openAIContext.js"));
  ({ sourceHash } = await import("../server/services/context/sourceHash.js"));
  await storage.ensureDataDirs();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (
    path.dirname(root) === os.tmpdir() &&
    path.basename(root).startsWith("sterra-i18n-content-")
  )
    await fs.rm(root, { recursive: true, force: true });
});
const semanticSuite = (suite) => ({
  ...suite,
  cases: suite.cases.map(({ name, ...test }) => test),
});
const digest = (value) => createHash("sha256").update(value).digest("hex");

it("localises every curated content variant while preserving the programming contract", () => {
  const baseline = templates.materializeProjectTemplates("de");
  for (const locale of ["de", "en", "es"]) {
    const variants = templates.materializeProjectTemplates(locale);
    expect(variants).toHaveLength(3);
    for (const template of variants) {
      expect(template.contentProvenance).toMatchObject({
        contentLocale: locale,
        id: template.id,
        contentVersion: 1,
      });
      expect(template.task.contentLocale).toBe(locale);
      const original = baseline.find((item) => item.id === template.id);
      if (template.task.testSuite)
        expect(semanticSuite(template.task.testSuite)).toEqual(
          semanticSuite(original.task.testSuite),
        );
      if (locale !== "de")
        expect(template.task.description).not.toBe(original.task.description);
      if (template.id === "small-website")
        expect(template.files[0].content).toContain(`lang="${locale}"`);
      if (template.id === "guess-number") {
        expect(template.files[0].content).toContain(
          "def beurteile_tipp(tipp, geheim)",
        );
        expect(
          template.task.testSuite.cases.map((item) => item.expected),
        ).toEqual(["zu klein", "zu groß", "richtig", "zu klein"]);
      }
    }
    for (const concept of concepts.CONCEPTS.filter(
      (c) => c.language === "python",
    )) {
      const exercise = concepts.reviewExercise(concept.id, locale);
      expect(exercise.contentLocale).toBe(locale);
      expect(semanticSuite(exercise.testSuite)).toEqual(
        semanticSuite(concepts.reviewExercise(concept.id).testSuite),
      );
    }
  }
  expect(concepts.conceptTitle("python.loops", "es")).toBe("Bucles");
  expect(
    concepts.validateConceptIds(["bucles", "Schleifen", "Loops"], "python"),
  ).toEqual(["python.loops"]);
});

it("preserves materialised locale, hashes and provenance through retries and package round trips", async () => {
  const operationId = randomUUID();
  const body = {
    templateId: "small-website",
    contentLocale: "es",
    operationId,
  };
  const session = await projects.importProject(body);
  expect(session.tutorLocale).toBe("es");
  expect((await projects.importProject(body)).id).toBe(session.id);
  await expect(
    projects.importProject({ ...body, contentLocale: "en" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const files = await Promise.all(
    ["index.html", "style.css", "app.js"].map((name) =>
      workspace.readFile(session.id, name),
    ),
  );
  const pkg = await projects.exportProject(session.id, {
    paths: files.map((f) => f.path),
    expectedVersions: Object.fromEntries(files.map((f) => [f.path, f.version])),
    taskVersion: session.currentTask.taskVersion,
  });
  expect(pkg.contentLocale).toBe("es");
  expect(pkg.contentProvenance).toEqual(session.project.contentProvenance);
  expect(pkg.task.contentProvenance).toEqual(
    session.currentTask.contentProvenance,
  );
  for (const file of pkg.files) expect(file.version).toBe(digest(file.content));
  const restored = await projects.importProject({
    package: pkg,
    contentLocale: "en",
    operationId: randomUUID(),
  });
  expect(restored.currentTask.description).toBe(
    session.currentTask.description,
  );
  expect(restored.project.contentLocale).toBe("es");
  expect((await workspace.readFile(restored.id, "index.html")).content).toBe(
    files[0].content,
  );
  await expect(
    projects.importProject({
      templateId: "small-website",
      contentLocale: "../en",
      operationId: randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(() =>
    projects.validateProjectPackage({
      ...pkg,
      contentProvenance: { ...pkg.contentProvenance, contentLocale: "en" },
    }),
  ).toThrow();
});

it("validates stable application options against their question and retains canonical answers", async () => {
  const s = await sessions.createSession({ tutorLocale: "es" });
  const question = s.messages[0].event;
  expect(question.question).toBe("¿Quieres crear un plan de aprendizaje?");
  const before = sourceHash(s.messages);
  // Merely reading a different display variant does not change source history.
  questions.materializeApplicationQuestion("onboarding", "en");
  expect(sourceHash((await sessions.loadSession(s.id)).messages)).toBe(before);
  await expect(
    teacher.answerQuestion(
      s.id,
      question.questionId,
      undefined,
      "finish_today",
    ),
  ).rejects.toMatchObject({ status: 400 });
  const answered = await teacher.answerQuestion(
    s.id,
    question.questionId,
    "untrusted browser label",
    "create_plan",
  );
  expect(answered.session.messages.at(-1).content).toBe("Sí, por favor");
  expect(answered.session.messages[0].event.answerOptionId).toBe("create_plan");
  expect(
    (
      await teacher.answerQuestion(
        s.id,
        question.questionId,
        undefined,
        "create_plan",
      )
    ).messageId,
  ).toBe(answered.messageId);
  await expect(
    teacher.answerQuestion(
      s.id,
      question.questionId,
      undefined,
      "start_directly",
    ),
  ).rejects.toMatchObject({ status: 409 });
  const custom = {
    ...questions.materializeApplicationQuestion("onboarding", "en"),
    application: undefined,
  };
  await sessions.mutateSession(s.id, (session) =>
    session.messages.push(sessions.message("event", "", { event: custom })),
  );
  await expect(
    teacher.answerQuestion(s.id, custom.questionId, undefined, "create_plan"),
  ).rejects.toMatchObject({ status: 400 });
  await teacher.answerQuestion(s.id, custom.questionId, "My own answer");
});

it("recognises a pre-locale German import receipt without allowing a new materialised language", async () => {
  const operationId = randomUUID();
  const s = await projects.importProject({
    templateId: "guess-number",
    operationId,
  });
  const template = templates.materializeProjectTemplates("de")[0];
  const pkg = projects.validateProjectPackage({
    ...template,
    format: "sterracode-project",
    schemaVersion: 1,
    files: template.files.map((f) => ({
      ...f,
      bytes: Buffer.byteLength(f.content),
      version: digest(f.content),
    })),
  });
  delete pkg.contentLocale;
  delete pkg.contentProvenance;
  delete pkg.task.contentLocale;
  delete pkg.task.contentProvenance;
  const provenance = {
    templateId: template.id,
    version: template.version,
    origin: template.origin,
    license: template.license,
  };
  await storage.writeJSON(
    path.join(root, "project-imports", `${operationId}.json`),
    {
      sessionId: s.id,
      digest: digest(JSON.stringify([pkg, provenance])),
    },
  );
  expect(
    (await projects.importProject({ templateId: "guess-number", operationId }))
      .id,
  ).toBe(s.id);
  await expect(
    projects.importProject({
      templateId: "guess-number",
      contentLocale: "es",
      operationId,
    }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

it("uses a versioned prompt contract without rewriting custom prompts or legacy language mode", async () => {
  const { getDefaultSystemPrompt } = await import("../server/prompts/tutor.js");
  expect(getDefaultSystemPrompt("de")).toBe(storage.DEFAULT_SYSTEM_PROMPT);
  expect(getDefaultSystemPrompt("es")).toContain("Eres SterraCode");
  const settings = { systemPrompt: "My personal instructions, unchanged." };
  const generated = prompt.systemPrompt(settings, { tutorLocale: "es" });
  expect(generated).toContain(settings.systemPrompt);
  expect(generated).toContain("STERRACODE_PROMPT_CONTRACT:1");
  expect(generated).toContain("Current tutor language: Español");
  expect(settings.systemPrompt).toBe("My personal instructions, unchanged.");
  expect(prompt.systemPrompt(settings, { tutorLocale: null })).not.toContain(
    "Current tutor language:",
  );
});

it("applies the latest tutor language to LM Studio and OpenAI after compaction", async () => {
  const session = await sessions.createSession({ tutorLocale: "es" });
  const original = JSON.stringify(session.messages);
  const settings = storage.defaultSettings();
  const model = fixtureModel();
  const info = await model.getModelInfo();
  const connection = {
    model,
    info,
    identity: JSON.stringify([
      info.identifier,
      info.path,
      info.instanceReference,
    ]),
  };
  const lm = new ContextManager({
    connection,
    settings,
    sessionId: session.id,
    signal: new AbortController().signal,
  });
  await lm.initialize();
  const prepared = await lm.prepare(session, [], { diagnostics: true });
  expect(openAIMessages(prepared.chat)[0].content).toContain(
    "Current tutor language: Español",
  );
  const esHashes = [...lm.hashes];
  await lm.prepare({ ...session, tutorLocale: "en" }, [], {
    diagnostics: true,
  });
  expect(lm.hashes).not.toEqual(esHashes);
  const native = {
    identifier: "openai-fixture",
    countTokens: async (text) => Math.ceil(text.length / 4),
    countInput: async () => 100,
    compact: async () => ({
      output: [
        { role: "developer", content: "old instructions" },
        { type: "compaction", encrypted_content: "opaque" },
      ],
    }),
  };
  const openai = new OpenAIContext({
    connection: { model: native },
    settings: { ...settings, provider: "openai" },
    signal: new AbortController().signal,
  });
  await openai.prepare(session, [], { force: true });
  expect(native.nativeInput[0].content).toContain(
    "Current tutor language: Español",
  );
  expect(
    native.nativeInput.some((item) => item.encrypted_content === "opaque"),
  ).toBe(true);
  // This provider snapshot is opaque; the next prepare must still prepend the
  // current developer instruction instead of retaining the old language.
  await openai.prepare({ ...session, tutorLocale: "en" }, []);
  expect(native.nativeInput[0].content).toContain(
    "Current tutor language: English",
  );
  expect(
    native.nativeInput.filter((item) => item.role === "developer"),
  ).toHaveLength(1);
  expect(JSON.stringify(session.messages)).toBe(original);
});

it("materialises a new review in its chosen language and reuses an existing review unchanged", async () => {
  await storage.updateSettings({ crossChatProfileEnabled: true });
  const p = await profile.getProfile();
  p.events = [
    {
      schemaVersion: 1,
      eventId: randomUUID(),
      type: "self_assessment",
      language: "python",
      conceptIds: ["python.loops"],
      occurredAt: "2020-01-01T12:00:00.000Z",
      evidence: {
        kind: "self_assessment",
        outcome: "unsure",
        assistance: "not_recorded",
      },
    },
  ];
  await storage.writeJSON(path.join(root, "profiles", "user.json"), p);
  const before = await fs.readFile(
    path.join(root, "profiles", "user.json"),
    "utf8",
  );
  expect(
    (await profile.getProfile("es")).concepts.find(
      (c) => c.id === "python.loops",
    ).title,
  ).toBe("Bucles");
  const derived = await profile.getProfile();
  const canonical = profile.profileToPromptText(derived);
  expect(profile.displayProfileContext(derived, "es")).toContain(
    "PERFIL DE APRENDIZAJE COMPARTIDO",
  );
  expect(profile.displayProfileContext(derived, "es").split("\n")[2]).toBe(
    canonical.split("\n")[2],
  );
  expect(profile.profileToPromptText(derived)).toBe(canonical);
  expect(
    await fs.readFile(path.join(root, "profiles", "user.json"), "utf8"),
  ).toBe(before);
  const review = (await profile.getProfile()).reviews[0];
  const s = await reviews.startReview(review.reviewId, { tutorLocale: "es" });
  expect(s.currentTask.title).toBe("Repaso voluntario: Bucles");
  expect(s.currentTask.contentLocale).toBe("es");
  expect(
    (await reviews.startReview(review.reviewId, { tutorLocale: "en" }))
      .currentTask,
  ).toEqual(s.currentTask);
});
