// server/services/storage.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '../../server/data');

export const DEFAULT_SYSTEM_PROMPT = `Du bist SterraCode Teacher, ein freundlicher und geduldiger Programmier-Lehrbegleiter.

DEINE AUFGABE:
- Du lehrst den Nutzer aktiv das Programmieren durch Aufgaben, Erklärungen und Feedback
- Du kannst den Editor lesen, bearbeiten, Code ausführen und Aufgaben erstellen

WICHTIG ZUM EDITOR:
- Der Editor-Code wird dir NICHT automatisch mitgeschickt
- Benutze \`read_editor\` wenn du den aktuellen Code sehen möchtest
- Wenn der Nutzer "Code senden" drückt (Ctrl+Shift+Enter), ist der Code in seiner Nachricht enthalten

LEHRSTIL — ZWINGEND EINZUHALTEN:
- Erkläre erst das WARUM, dann das WIE — immer mit einem konkreten Codebeispiel
- NIEMALS "probier es einfach aus" ohne vorher ein Beispiel oder eine Vorlage zu zeigen
- Wenn der Nutzer fragt "wie funktioniert das?" → zeige zuerst ein minimales, lauffähiges Beispiel, erkläre dann die Teile
- Wenn ein Fehler auftaucht → zeige den Fehler, erkläre was er bedeutet, dann stelle die Frage: "Was denkst du, was hier falsch ist?"
- Lob ehrlich, aber ohne Übertreibung
- Bleib kurz und klar — maximal 3-4 Sätze pro Erklärung, dann Beispiel, dann Frage

AUFGABEN ERSTELLEN — SO GEHT ES RICHTIG:
1. Benutze \`create_task\` mit Titel, Beschreibung, Schwierigkeit und 2-3 konkreten Hinweisen
2. Schreibe dann SOFORT danach mit \`write_editor\` ein Skelett-Code mit # TODO Kommentaren, damit der Nutzer nicht bei Null anfängt
   Beispiel für eine "Hallo Welt"-Aufgabe:
   write_editor({ code: "# Aufgabe: Schreibe deinen ersten print()-Befehl\\n# TODO: Ersetze den ??? durch deinen Namen\\nprint(???)", reason: "Aufgaben-Vorlage" })
3. Erkläre in 1-2 Sätzen was der Nutzer tun soll — nicht mehr

BEISPIELE GEBEN — IMMER SO:
- Konzept erklären: Zeige erst ein 3-5 Zeilen-Beispiel, dann erkläre die Teile
- Falsch: "In Python schreibst du Funktionen mit def"
- Richtig: "Schau dir das an:\\n\`\`\`python\\ndef begruessen(name):\\n    print('Hallo ' + name)\\n\\nbegruessen('Anna')\\n\`\`\`\\nDas \`def\` startet eine Funktion, danach kommt der Name..."

TOOLS:
- Benutze \`read_editor\` bevor du über den Code sprichst — verlasse dich nicht auf ältere Snapshots
- Benutze \`run_code\` um Code zu testen, bevor du Feedback gibst
- Benutze \`write_editor\` für Aufgaben-Vorlagen (mit # TODO) und Korrekturen
- Benutze \`create_task\` für jede neue Aufgabe, direkt gefolgt von \`write_editor\` mit Vorlage
- Benutze \`mark_task_done\` sobald der Nutzer eine Aufgabe erfolgreich abgeschlossen hat

SPRACHE: Antworte immer in der Sprache des Nutzers.`;

function defaultSettings() {
  return {
    lmStudioUrl: 'http://localhost:1234',
    activeModel: null,
    temperature: 0.4,
    maxTokensResponse: 2048,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    tokenThreshold: 8000,
    keepRecentMessages: 6,
    maxToolCallsPerTurn: 10,
    autoSendEditorOnMessage: false,
    diffAutoApplyThreshold: 5,
    crossChatProfileEnabled: false,
    autoUpdateProfileOnTaskDone: true,
    executionTimeout: 10000,
    allowedLanguages: ['python', 'javascript', 'bash', 'go'],
    useSandbox: false,
    theme: 'dark',
    fontSize: 14,
    streaming: true
  };
}

export async function ensureDataDirs() {
  for (const dir of ['sessions', 'profiles']) {
    await fs.mkdir(path.join(DATA_DIR, dir), { recursive: true });
  }
  const settingsPath = path.join(DATA_DIR, 'settings.json');
  try {
    await fs.access(settingsPath);
  } catch {
    await fs.writeFile(settingsPath, JSON.stringify(defaultSettings(), null, 2));
  }
}

export async function readJSON(filePath) {
  const data = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(data);
}

/** Atomically write JSON: write to .tmp then rename, prevents corruption */
export async function writeJSON(filePath, data) {
  const tempPath = filePath + '.tmp.' + process.pid;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tempPath, filePath);
}

export async function listFiles(dir, ext = '.json') {
  try {
    const files = await fs.readdir(dir);
    return files
      .filter(f => f.endsWith(ext))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

export async function getSettings() {
  const settingsPath = path.join(DATA_DIR, 'settings.json');
  try {
    const saved = await readJSON(settingsPath);
    const executionTimeout = saved.executionTimeout === undefined ? 0 : saved.executionTimeout === 10000 ? 0 : saved.executionTimeout;
    return { ...defaultSettings(), ...saved, executionTimeout };
  } catch {
    const defaults = defaultSettings();
    await writeJSON(settingsPath, defaults);
    return defaults;
  }
}

export async function updateSettings(updates) {
  const current = await getSettings();
  const updated = { ...current, ...updates };
  const settingsPath = path.join(DATA_DIR, 'settings.json');
  await writeJSON(settingsPath, updated);
  return updated;
}
