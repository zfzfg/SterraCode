import { randomUUID } from "node:crypto";
import { AppError, getSettings } from "./storage.js";
import { mutateSession, validatePlan, setLearningPlan } from "./sessions.js";
import { readFile, writeFile, listWorkspace } from "./workspace.js";
import {
  startProcess,
  readProcess,
  stopProcess,
  waitProcess,
} from "./processes.js";
import { getProfile, updateProfile } from "./profileManager.js";
const text = (v, name) => {
  if (typeof v !== "string" || !v.trim() || v.length > 100000)
    throw new AppError(`Ungültiges Tool-Feld: ${name}`);
  return v;
};
export async function executeTool(name, args, context) {
  const { sessionId, turnId, signal } = context;
  try {
    if (signal?.aborted) throw new AppError("Abgebrochen.");
    switch (name) {
      case "list_files":
        return { type: name, files: await listWorkspace(sessionId) };
      case "read_file":
        return { type: name, ...(await readFile(sessionId, args.path)) };
      case "write_file":
        return await writeFile(
          sessionId,
          args.path,
          args.code,
          // Some local models serialize JSON null as the literal "null".
          // It can never be a SHA-256 file version; the normal version guard
          // still rejects null for every existing file.
          args.expectedVersion === "null" ? null : args.expectedVersion,
          { actor: "ai", reason: text(args.reason, "reason"), turnId },
        );
      case "run_terminal_command": {
        const job = await startProcess({
          sessionId,
          command: text(args.command, "command"),
          actor: "ai",
        });
        context.onProcess?.(job);
        const stop = () => {
          stopProcess(job.processId, sessionId).catch(() => {});
        };
        signal?.addEventListener("abort", stop, { once: true });
        if (signal?.aborted) stop();
        try {
          return {
            type: name,
            ...(await waitProcess(job.processId, sessionId)),
          };
        } finally {
          signal?.removeEventListener("abort", stop);
        }
      }
      case "read_terminal_output":
        return {
          type: name,
          ...(await readProcess(args.processId, sessionId)),
        };
      case "ask_question": {
        const question = text(args.question, "question");
        if (
          !["multiple-choice", "text"].includes(args.type) ||
          (args.options &&
            (!Array.isArray(args.options) ||
              args.options.length > 5 ||
              args.options.some((v) => typeof v !== "string")))
        )
          throw new AppError("Ungültige Frageoptionen.");
        return {
          type: name,
          question,
          questionId: randomUUID(),
          questionType: args.type,
          options: args.options || [],
        };
      }
      case "update_learning_plan": {
        const plan = validatePlan({ goal: args.goal, topics: args.topics });
        await mutateSession(sessionId, (s) => {
          if (
            JSON.stringify(s.learningPlan) !==
            JSON.stringify(context.learningPlan)
          )
            throw new AppError(
              "Der Lernplan wurde inzwischen verändert. Bitte erneut lesen.",
              409,
            );
          setLearningPlan(s, plan);
        });
        context.learningPlan = plan;
        return { type: name, ...plan };
      }
      case "create_task": {
        const task = {
          id: randomUUID(),
          title: text(args.title, "title"),
          description: text(args.description, "description"),
          difficulty: args.difficulty,
          hints: Array.isArray(args.hints)
            ? args.hints.filter((h) => typeof h === "string")
            : [],
          done: false,
        };
        await mutateSession(sessionId, (s) => {
          s.currentTask = task;
        });
        return { type: name, task };
      }
      case "mark_task_done": {
        await mutateSession(sessionId, (s) => {
          if (!s.currentTask) throw new AppError("Keine aktive Aufgabe.");
          s.currentTask.done = true;
          s.currentTask.feedback = args.feedback;
        });
        const settings = await getSettings();
        if (
          settings.crossChatProfileEnabled &&
          settings.autoUpdateProfileOnTaskDone
        )
          await updateProfile({
            language: context.language,
            newConcepts: [],
            strengths: [],
            weaknesses: [],
            taskSucceeded: true,
          });
        return { type: name, feedback: args.feedback || "" };
      }
      case "add_explanation":
        return {
          type: name,
          title: text(args.title, "title"),
          content: text(args.content, "content"),
        };
      case "get_language_profile": {
        if (!(await getSettings()).crossChatProfileEnabled)
          throw new AppError("Sprachprofil ist deaktiviert.");
        return {
          type: name,
          profile: (await getProfile()).languages?.[args.language] || null,
        };
      }
      case "trigger_summarize": {
        context.requestCompaction();
        return { type: name, status: "scheduled" };
      }
      case "get_context_usage":
        return { type: name, ...context.getContextUsage() };
      case "read_tool_result":
        return await context.readToolResult(args.messageId, args.offset ?? 0);
      default:
        throw new AppError(`Unbekanntes Tool: ${name}`);
    }
  } catch (error) {
    return {
      type: "tool_error",
      tool: name,
      error: error.message,
      code: error.code || "TOOL_ERROR",
    };
  }
}
