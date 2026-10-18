import { beforeAll, afterAll, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
let root, storage, sessions, workspace, processes, available;
const examples = {
  python: 'print("SMOKE_OK")',
  javascript: 'console.log("SMOKE_OK")',
  bash: 'printf "SMOKE_OK\\n"',
  go: 'package main\nimport "fmt"\nfunc main(){fmt.Println("SMOKE_OK")}',
  rust: 'fn main(){println!("SMOKE_OK");}',
  cpp: '#include <iostream>\nint main(){std::cout << "SMOKE_OK" << std::endl;}',
  csharp:
    'using System;\nclass Program { static void Main(){Console.WriteLine("SMOKE_OK");} }',
  lua: 'print("SMOKE_OK")',
  java: 'public class Main {public static void main(String[] args){System.out.println("SMOKE_OK");}}',
};
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterracode-runtimes-"));
  process.env.STERRACODE_DATA_DIR = root;
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  workspace = await import("../server/services/workspace.js");
  processes = await import("../server/services/processes.js");
  await storage.ensureDataDirs();
  available = await processes.getRuntimes();
});
afterAll(async () => {
  await processes?.stopAllProcesses();
  if (root?.startsWith(path.join(os.tmpdir(), "sterracode-runtimes-")))
    await fs.rm(root, { recursive: true, force: true });
});
for (const language of Object.keys(examples))
  it(`führt ${language} mit installierter Laufzeit tatsächlich aus`, async (context) => {
    const runtime = available.find((r) => r.language === language);
    if (!runtime.available) context.skip(runtime.reason);
    const s = await sessions.createSession({
      title: `Laufzeittest ${language}`,
      language,
    });
    const f = await workspace.readFile(s.id, s.activeFile);
    await workspace.writeFile(
      s.id,
      s.activeFile,
      examples[language],
      f.version,
    );
    const job = await processes.startProcess({
      sessionId: s.id,
      file: s.activeFile,
      language,
    });
    const result = await processes.waitProcess(job.processId, s.id);
    expect(result.output, `${language}: ${result.output}`).toContain(
      "SMOKE_OK",
    );
    expect(result.exitCode, result.output).toBe(0);
  }, 90000);
it("weist jede Sprache ohne auffindbare Laufzeit mit einer konkreten Meldung zurück", async () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = "";
    const missing = await processes.getRuntimes();
    expect(missing.every((r) => !r.available)).toBe(true);
    for (const language of Object.keys(examples)) {
      const s = await sessions.createSession({ language });
      await expect(
        processes.startProcess({
          sessionId: s.id,
          file: s.activeFile,
          language,
        }),
      ).rejects.toMatchObject({ code: "RUNTIME_MISSING" });
    }
  } finally {
    process.env.PATH = previous;
  }
});
