// server/services/toolExecutor.js
import { executeCode } from './executor.js';
import { startTerminalSession } from './terminal.js';
import { getProfile, updateProfile } from './profileManager.js';
import { getSettings, DATA_DIR, getWorkspacePath } from './storage.js';
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
    case 'read_file': {
      try {
        const wp = await getWorkspacePath(sessionId);
        const fullPath = path.join(wp, args.path);
        if (!fullPath.startsWith(wp)) throw new Error('Access denied');
        const content = await fs.readFile(fullPath, 'utf-8');
        return {
          content,
          lines: content.split('\n').length
        };
      } catch (err) {
        return { error: 'Datei konnte nicht gelesen werden: ' + err.message };
      }
    }

    case 'write_file': {
      try {
        const wp = await getWorkspacePath(sessionId);
        const fullPath = path.join(wp, args.path);
        if (!fullPath.startsWith(wp)) throw new Error('Access denied');
        
        // Backup old content for undo if file exists
        let oldContent = null;
        try { oldContent = await fs.readFile(fullPath, 'utf-8'); } catch {}
        
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, args.code, 'utf-8');
        
        return {
          type: 'write_file',
          path: args.path,
          code: args.code,
          oldContent,
          reason: args.reason,
          status: 'applied'
        };
      } catch (err) {
        return { error: 'Datei konnte nicht geschrieben werden: ' + err.message };
      }
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

    case 'run_terminal_command': {
      try {
        const wp = await getWorkspacePath(sessionId);
        const { exec } = await import('child_process');
        const util = await import('util');
        const execPromise = util.promisify(exec);
        
        const { stdout, stderr } = await execPromise(args.command, { cwd: wp, timeout: 15000 });
        return {
          type: 'run_terminal_command',
          command: args.command,
          stdout,
          stderr,
          exitCode: 0
        };
      } catch (err) {
        return {
          type: 'run_terminal_command',
          command: args.command,
          stdout: err.stdout || '',
          stderr: err.stderr || err.message,
          exitCode: err.code || 1
        };
      }
    }

    case 'ask_question': {
      return {
        type: 'ask_question',
        question: args.question,
        questionType: args.type,
        options: args.options
      };
    }

    case 'update_learning_plan': {
      if (session) {
        session.learningPlan = {
          goal: args.goal,
          topics: args.topics
        };
      }
      return {
        type: 'update_learning_plan',
        goal: args.goal,
        topics: args.topics
      };
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
