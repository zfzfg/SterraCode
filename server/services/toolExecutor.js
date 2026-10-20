import { proposeFile } from "./proposals.js";
import {
  taskAssessment,
  startTaskTests,
  getTaskTestResults,
  completeTask,
} from "./testRunner.js";
import { randomUUID } from "node:crypto";
import { AppError, getSettings } from "./storage.js";
import { mutateSession, validatePlan, setLearningPlan } from "./sessions.js";
import { readFile, writeFile, listWorkspace } from "./workspace.js";
import { startProcess, stopProcess, waitProcess } from "./processes.js";
import { getProfile, profileToPromptText } from "./profileManager.js";
import { getTrace, traceEvents } from "./traces.js";
import {
  terminalPage,
  terminalRuntime,
  readTerminalPage,
} from "./terminalPages.js";
const text = (v, name) => {
  if (typeof v !== "string" || !v.trim() || v.length > 100000)
    throw new AppError(
      `Ungültiges Tool-Feld: ${name}`,
      400,
      "INVALID_REQUEST",
      {
        messageKey: "serverFeature:tools.invalidField",
        params: { name },
      },
    );
  return v;
};
export async function executeTool(name, args, context) {
  const { sessionId, turnId, signal } = context;
  try {
    if (signal?.aborted)
      throw new AppError("Abgebrochen.", undefined, undefined, {
        messageKey: "serverFeature:tools.aborted",
        params: {},
      });
    switch (name) {
      case "inspect_execution_trace": {
        const info = await getTrace(sessionId, args.traceRunId);
        if (args.fromStep === undefined)
          return {
            type: name,
            traceRunId: info.traceRunId,
            status: info.status,
            reason: info.reason,
            complete: info.complete,
            eventCount: info.eventCount,
            manifest: info.snapshot.files.map(({ path, version }) => ({
              path,
              version,
            })),
            limitations: info.limitations,
            ...(info.limitationsKey
              ? {
                  limitationsKey: info.limitationsKey,
                  limitationsParams: info.limitationsParams || {},
                }
              : {}),
          };
        return {
          type: name,
          ...(await traceEvents(
            sessionId,
            args.traceRunId,
            args.fromStep,
            args.limit ?? 5,
            args.detail ?? "summary",
          )),
        };
      }
      case "run_task_tests":
        return {
          type: name,
          ...(await startTaskTests(sessionId, args.taskId, args, "ai")),
        };
      case "read_task_test_results":
        return {
          type: name,
          ...(await getTaskTestResults(sessionId, args.testRunId)),
        };
      case "list_files":
        return { type: name, files: await listWorkspace(sessionId) };
      case "read_file":
        return { type: name, ...(await readFile(sessionId, args.path, args)) };
      case "write_file":
        return await (
          (await getSettings()).reviewAIChanges ? proposeFile : writeFile
        )(
          sessionId,
          args.path,
          args.code,
          // Some local models serialize JSON null as the literal "null".
          // It can never be a SHA-256 file version; the normal version guard
          // still rejects null for every existing file.
          args.expectedVersion === "null" ? null : args.expectedVersion,
          {
            actor: "ai",
            reason: text(args.reason, "reason"),
            turnId,
            operationId: context.toolCallId
              ? `${turnId}:${context.toolCallId}`
              : `${turnId}:${args.path}:${args.expectedVersion}`,
          },
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
            ...terminalPage(
              await waitProcess(job.processId, sessionId),
              sessionId,
              terminalRuntime(),
              0,
              true,
            ),
          };
        } finally {
          signal?.removeEventListener("abort", stop);
        }
      }
      case "read_terminal_output":
        return {
          type: name,
          ...(await readTerminalPage(
            args.processId,
            sessionId,
            args.cursor,
            true,
          )),
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
          throw new AppError("Ungültige Frageoptionen.", undefined, undefined, {
            messageKey: "serverFeature:tools.invalidQuestionOptions",
            params: {},
          });
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
              undefined,
              { messageKey: "serverFeature:tools.planChanged", params: {} },
            );
          setLearningPlan(s, plan);
        });
        context.learningPlan = plan;
        return { type: name, ...plan };
      }
      case "create_task": {
        const task = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          title: text(args.title, "title"),
          description: text(args.description, "description"),
          difficulty: args.difficulty,
          hints: Array.isArray(args.hints)
            ? args.hints.filter((h) => typeof h === "string")
            : [],
          done: false,
        };
        await mutateSession(sessionId, (s) => {
          Object.assign(task, taskAssessment(args, s.language));
          s.currentTask = task;
        });
        return { type: name, task };
      }
      case "mark_task_done": {
        const result = await completeTask(
          sessionId,
          args,
          context.language,
          "ai",
        );
        return {
          type: name,
          taskId: result.currentTask.id,
          completion: result.currentTask.completion,
          feedback: args.feedback || "",
        };
      }
      case "add_explanation":
        return {
          type: name,
          title: text(args.title, "title"),
          content: text(args.content, "content"),
        };
      case "get_language_profile": {
        if (!(await getSettings()).crossChatProfileEnabled)
          throw new AppError(
            "Sprachprofil ist deaktiviert.",
            undefined,
            undefined,
            { messageKey: "serverFeature:tools.profileDisabled", params: {} },
          );
        return {
          type: name,
          profile: profileToPromptText(await getProfile()),
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
        throw new AppError(
          `Unbekanntes Tool: ${name}`,
          400,
          "INVALID_REQUEST",
          {
            messageKey: "serverFeature:tools.unknownTool",
            params: { name },
          },
        );
    }
  } catch (error) {
    return {
      type: "tool_error",
      tool: name,
      error: error.message,
      code: error.code || "TOOL_ERROR",
      ...(error.messageKey
        ? { messageKey: error.messageKey, params: error.params || {} }
        : {}),
    };
  }
}
