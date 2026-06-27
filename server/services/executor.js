// server/services/executor.js
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const isWindows = process.platform === 'win32';

export const RUNTIMES = {
  python:     { cmd: 'python3', ext: '.py' },
  javascript: { cmd: 'node',    ext: '.js' },
  bash:       { cmd: 'bash',    ext: '.sh' },
  go:         { cmd: 'go', args: ['run'], ext: '.go' },
  lua:        { cmd: 'lua',     ext: '.lua' },
  java:       { cmd: 'java',    ext: '.java' },
  rust:       { isCompiled: true, ext: '.rs', compileCmd: 'rustc', compileArgs: (src, out) => [src, '-o', out], binExt: isWindows ? '.exe' : '' },
  cpp:        { isCompiled: true, ext: '.cpp', compileCmd: 'g++', compileArgs: (src, out) => ['-std=c++17', src, '-o', out], binExt: isWindows ? '.exe' : '' },
  csharp:     { isCompiled: true, ext: '.cs', compileCmd: 'csc', compileArgs: (src, out) => ['/out:' + out, src], binExt: '.exe' }
};

// On Windows 'python3' may not exist; fall back to 'python'
if (isWindows) {
  RUNTIMES.python.cmd = 'python';
}

/**
 * Executes code in a temporary subprocess.
 *
 * Security note: This runs code with the same privileges as the Node.js process.
 * Acceptable for single-user local use only. For LAN-accessible setups, use
 * the Docker alternative described in the concept.
 *
 * Protections in place:
 *  - Configurable timeout (default 10s) with SIGKILL fallback
 *  - 1 MB stdout buffer limit
 *  - ulimit wrappers on Unix (CPU time, memory, file size)
 */
export async function executeCode({ code, language, timeoutMs = 0 }) {
  const runtime = RUNTIMES[language];
  if (!runtime) throw new Error(`Sprache nicht unterstützt: ${language}`);

  const tmpFile = path.join(os.tmpdir(), `sterracode_${Date.now()}_${process.pid}${runtime.ext}`);
  await fs.writeFile(tmpFile, code, 'utf-8');

  // Multi-step compiled language handling
  if (runtime.isCompiled) {
    const binFile = tmpFile.replace(runtime.ext, runtime.binExt);
    let compileCmd = runtime.compileCmd;

    // Windows fallback for C# compiler
    if (language === 'csharp' && isWindows) {
      try {
        await fs.access('csc.exe');
      } catch {
        const msNetCsc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
        try {
          await fs.access(msNetCsc);
          compileCmd = msNetCsc;
        } catch {}
      }
    }

    const compArgs = runtime.compileArgs(tmpFile, binFile);

    // Run compiler
    const compileResult = await new Promise((resolve) => {
      const compProc = spawn(compileCmd, compArgs);
      let listStdout = '';
      let listStderr = '';
      compProc.stdout.on('data', d => { listStdout += d.toString(); });
      compProc.stderr.on('data', d => { listStderr += d.toString(); });
      compProc.on('close', (code) => {
        resolve({ exitCode: code ?? 0, stdout: listStdout, stderr: listStderr });
      });
      compProc.on('error', (err) => {
        resolve({ exitCode: -1, stdout: '', stderr: `Compiler konnte nicht gestartet werden (${compileCmd}): ${err.message}` });
      });
    });

    if (compileResult.exitCode !== 0) {
      // Clean up source file
      await fs.unlink(tmpFile).catch(() => {});
      return {
        stdout: compileResult.stdout,
        stderr: `Kompilierungsfehler:\n${compileResult.stderr || compileResult.stdout}`,
        exitCode: compileResult.exitCode
      };
    }

    // Run the compiled binary
    return new Promise((resolve) => {
      let finalCmd = binFile;
      let finalArgs = [];

      if (!isWindows) {
        // ulimit: CPU 5s, virtual memory 256 MB, max file size 10 MB
        finalCmd  = 'bash';
        finalArgs = ['-c', `ulimit -t 5 -v 262144 -f 10240; ${binFile}`];
      }

      const spawnOptions = timeoutMs > 0 ? { timeout: timeoutMs } : {};
      const proc = spawn(finalCmd, finalArgs, spawnOptions);

      let stdout = '';
      let stderr = '';
      let killed = false;

      proc.stdout.on('data', d => {
        stdout += d.toString();
        if (stdout.length > 1024 * 1024) { // 1 MB limit
          proc.kill('SIGKILL');
          killed = true;
        }
      });
      proc.stderr.on('data', d => { stderr += d.toString(); });

      const timer = timeoutMs > 0 ? setTimeout(() => {
        proc.kill('SIGKILL');
        killed = true;
      }, timeoutMs) : null;

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        fs.unlink(tmpFile).catch(() => {});
        fs.unlink(binFile).catch(() => {});
        if (language === 'csharp') {
          fs.unlink(binFile.replace('.exe', '.pdb')).catch(() => {});
        }
        if (killed && !stdout.includes('[TIMEOUT')) {
          resolve({ stdout, stderr: stderr + '\n[TIMEOUT: Ausführung nach ' + (timeoutMs / 1000) + 's abgebrochen]', exitCode: -1 });
        } else {
          resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        fs.unlink(tmpFile).catch(() => {});
        fs.unlink(binFile).catch(() => {});
        resolve({ stdout: '', stderr: `Fehler beim Ausführen der Binärdatei: ${err.message}`, exitCode: -1 });
      });
    });
  }

  // Interpreted language handling
  return new Promise((resolve) => {
    const baseArgs = runtime.args ? [...runtime.args, tmpFile] : [tmpFile];

    let finalCmd, finalArgs;

    if (!isWindows) {
      // ulimit: CPU 5s, virtual memory 256 MB, max file size 10 MB
      finalCmd  = 'bash';
      finalArgs = ['-c', `ulimit -t 5 -v 262144 -f 10240; ${runtime.cmd} ${baseArgs.map(a => `"${a}"`).join(' ')}`];
    } else {
      finalCmd  = runtime.cmd;
      finalArgs = baseArgs;
    }

    const spawnOptions = timeoutMs > 0 ? { timeout: timeoutMs } : {};
    const proc = spawn(finalCmd, finalArgs, spawnOptions);

    let stdout = '';
    let stderr = '';
    let killed = false;

    proc.stdout.on('data', d => {
      stdout += d.toString();
      if (stdout.length > 1024 * 1024) { // 1 MB limit
        proc.kill('SIGKILL');
        killed = true;
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = timeoutMs > 0 ? setTimeout(() => {
      proc.kill('SIGKILL');
      killed = true;
    }, timeoutMs) : null;

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      fs.unlink(tmpFile).catch(() => {});
      if (killed && !stdout.includes('[TIMEOUT')) {
        resolve({ stdout, stderr: stderr + '\n[TIMEOUT: Ausführung nach ' + (timeoutMs / 1000) + 's abgebrochen]', exitCode: -1 });
      } else {
        resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      fs.unlink(tmpFile).catch(() => {});
      resolve({ stdout: '', stderr: `Fehler beim Starten von '${finalCmd}': ${err.message}`, exitCode: -1 });
    });
  });
}
