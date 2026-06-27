import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { RUNTIMES } from './executor.js';

const sessions = new Map();

export function startTerminalSession({ command }) {
  const trimmed = typeof command === 'string' ? command.trim() : '';
  if (!trimmed) {
    throw new Error('Befehl ist erforderlich.');
  }

  const sessionId = randomUUID();
  const child = spawn(trimmed, {
    shell: true,
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const session = { id: sessionId, child, output: '', exited: false, exitCode: null };
  child.stdout.on('data', (chunk) => {
    session.output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    session.output += chunk.toString();
  });
  child.on('error', (err) => {
    session.output += `\n[ERROR] ${err.message}`;
    session.exited = true;
    session.exitCode = -1;
  });
  child.on('close', (code) => {
    session.exited = true;
    session.exitCode = code ?? 0;
  });

  sessions.set(sessionId, session);
  return { sessionId, output: session.output, exited: session.exited, exitCode: session.exitCode };
}

export async function startCodeSession({ code, language, timeoutMs = 10000 }) {
  const runtime = RUNTIMES[language];
  if (!runtime) throw new Error(`Sprache nicht unterstützt: ${language}`);

  const sessionId = randomUUID();
  const session = { id: sessionId, child: null, output: '', exited: false, exitCode: null };
  sessions.set(sessionId, session);

  try {
    const tmpFile = path.join(os.tmpdir(), `sterracode_${Date.now()}_${process.pid}${runtime.ext}`);
    await fs.writeFile(tmpFile, code, 'utf-8');

    let command;
    let args = [];
    let cleanup = [];

    if (runtime.isCompiled) {
      const binFile = tmpFile.replace(runtime.ext, runtime.binExt);
      const compileResult = await new Promise((resolve) => {
        const compProc = spawn(runtime.compileCmd, runtime.compileArgs(tmpFile, binFile), { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        compProc.stdout.on('data', d => { out += d.toString(); });
        compProc.stderr.on('data', d => { err += d.toString(); });
        compProc.on('close', (code) => resolve({ exitCode: code ?? 0, stdout: out, stderr: err }));
        compProc.on('error', (err) => resolve({ exitCode: -1, stdout: '', stderr: err.message }));
      });

      if (compileResult.exitCode !== 0) {
        session.output += `${compileResult.stdout || ''}${compileResult.stderr ? `\n${compileResult.stderr}` : ''}`;
        session.exited = true;
        session.exitCode = compileResult.exitCode;
        await fs.unlink(tmpFile).catch(() => {});
        return { sessionId, output: session.output, exited: true, exitCode: session.exitCode };
      }

      command = process.platform === 'win32' ? binFile : 'bash';
      args = process.platform === 'win32' ? [] : ['-c', `ulimit -t 5 -v 262144 -f 10240; ${binFile}`];
      cleanup = [tmpFile, binFile, process.platform !== 'win32' ? binFile.replace(/\.[^.]+$/, '') : null].filter(Boolean);
    } else {
      const baseArgs = runtime.args ? [...runtime.args, tmpFile] : [tmpFile];
      if (process.platform === 'win32') {
        command = runtime.cmd;
        args = baseArgs;
      } else {
        command = 'bash';
        args = ['-c', `ulimit -t 5 -v 262144 -f 10240; ${runtime.cmd} ${baseArgs.map(a => `"${a}"`).join(' ')}`];
      }
      cleanup = [tmpFile];
    }

    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    session.child = child;

    child.stdout.on('data', (chunk) => {
      session.output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      session.output += chunk.toString();
    });
    child.on('error', (err) => {
      session.output += `\n[ERROR] ${err.message}`;
      session.exited = true;
      session.exitCode = -1;
    });
    child.on('close', async (code) => {
      session.exited = true;
      session.exitCode = code ?? 0;
      for (const p of cleanup) {
        await fs.unlink(p).catch(() => {});
      }
    });

    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (!session.exited && session.child) {
          session.child.kill('SIGKILL');
        }
      }, timeoutMs);
      child.on('close', () => clearTimeout(timer));
    }

    return { sessionId, output: session.output, exited: session.exited, exitCode: session.exitCode };
  } catch (err) {
    session.output += `\n[ERROR] ${err.message}`;
    session.exited = true;
    session.exitCode = -1;
    return { sessionId, output: session.output, exited: true, exitCode: -1 };
  }
}

export function sendTerminalInput({ sessionId, input = '' }) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Terminal-Sitzung nicht gefunden.');
  }
  if (session.exited) {
    throw new Error('Terminal-Sitzung ist bereits beendet.');
  }

  if (input) {
    session.child.stdin.write(input);
  }

  return { ok: true, output: session.output, exited: session.exited, exitCode: session.exitCode };
}

export function readTerminalSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Terminal-Sitzung nicht gefunden.');
  }
  return { sessionId, output: session.output, exited: session.exited, exitCode: session.exitCode };
}

export function stopTerminalSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return { ok: false };
  }
  session.child.kill('SIGTERM');
  sessions.delete(sessionId);
  return { ok: true };
}
