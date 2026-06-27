// server/services/toolExecutor.js
import { executeCode } from './executor.js';
import { getProfile, updateProfile } from './profileManager.js';
import { getSettings, DATA_DIR } from './storage.js';
import path from 'path';
import fs from 'fs/promises';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

/**
 * Executes a tool call from the Teacher agent.
 *
 * context shape:
 *   { sessionId, editorCode, language, session, settings }
 *
 * Returns an object with:
 *   - The tool result for the LM (always present)
 *   - Optional UI action fields (type, code, task, etc.) processed by the frontend
 */
export async function executeTool(name, args, context) {
  const { sessionId, editorCode, language, session, settings } = context;

  switch (name) {
    case 'read_editor': {
      return {
        content: editorCode || '',
        language: language || 'python',
        lines: (editorCode || '').split('\n').length
      };
    }

    case 'write_editor': {
      // Return the pending write — frontend applies it with diff preview
      return {
        type: 'write_editor',
        code: args.code,
        reason: args.reason,
        status: 'pending_apply'
      };
    }

    case 'insert_at_line': {
      // Build the modified code server-side so the LM can see the result
      const lines = (editorCode || '').split('\n');
      const insertAt = Math.max(0, (args.line || 1) - 1);
      const insertLines = args.code.split('\n');
      lines.splice(insertAt, 0, ...insertLines);
      const newCode = lines.join('\n');
      return {
        type: 'insert_at_line',
        code: newCode,
        line: args.line,
        reason: args.reason,
        status: 'pending_apply'
      };
    }

    case 'run_code': {
      const codeToRun = editorCode || '';
      if (!codeToRun.trim()) {
        return { stdout: '', stderr: 'Editor ist leer — kein Code zum Ausführen.', exitCode: 1 };
      }
      const result = await executeCode({
        code: codeToRun,
        language: args.language || language || 'python',
        timeoutMs: settings?.executionTimeout ?? 10000
      });
      return result;
    }

    case 'create_task': {
      const task = {
        title:       args.title,
        description: args.description,
        difficulty:  args.difficulty,
        hints:       args.hints || [],
        done:        false,
        createdAt:   new Date().toISOString()
      };
      // Update the session's currentTask
      if (session) session.currentTask = task;
      return { type: 'create_task', task };
    }

    case 'mark_task_done': {
      if (session && session.currentTask) {
        session.currentTask.done = true;
        session.currentTask.completedAt = new Date().toISOString();
        session.currentTask.feedback = args.feedback;
      }
      // Update language profile if enabled
      if (settings?.crossChatProfileEnabled && settings?.autoUpdateProfileOnTaskDone) {
        try {
          await updateProfile({
            language: language || 'python',
            newConcepts: args.newConcepts || [],
            strengths:   args.strengths   || [],
            weaknesses:  args.weaknesses  || [],
            taskSucceeded: args.taskSucceeded !== false
          });
        } catch (err) {
          console.warn('[SterraCode] Profil-Update fehlgeschlagen:', err.message);
        }
      }
      return {
        type: 'mark_task_done',
        feedback: args.feedback,
        taskSucceeded: args.taskSucceeded !== false
      };
    }

    case 'add_explanation': {
      return {
        type: 'add_explanation',
        title:   args.title,
        content: args.content
      };
    }

    case 'get_language_profile': {
      if (!settings?.crossChatProfileEnabled) {
        return { error: 'Cross-Chat-Profil ist deaktiviert. Kann in den Einstellungen aktiviert werden.' };
      }
      const profile = await getProfile();
      const langData = profile.languages?.[args.language];
      if (!langData) {
        return { language: args.language, known: false, message: 'Noch keine Daten für diese Sprache.' };
      }
      return { language: args.language, ...langData };
    }

    case 'trigger_summarize': {
      // Signal to teacher loop that summarization should happen
      return { type: 'trigger_summarize', status: 'requested' };
    }

    default:
      return { error: `Unbekanntes Tool: ${name}` };
  }
}
