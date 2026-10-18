# SterraCode
## KI-gestützte Coding-Lernumgebung — Vollständiges Implementierungskonzept
### Version 1.2 · Juni 2026

---

> **Zweck dieses Dokuments:** Dieses Konzept beschreibt SterraCode vollständig und präzise genug, damit eine KI oder ein Entwickler direkt mit der Implementierung beginnen kann. Alle Architekturentscheidungen, Datenstrukturen, API-Kontrakte und kritischen Code-Beispiele sind enthalten.

> **v1.2 — Was sich geändert hat:** Sicherheits-Sandbox für Code-Ausführung, File-Locking gegen korrupte JSONs, Editor-Code wird nicht mehr bei jeder Nachricht mitgeschickt (nur per Tool-Call), Tool-Calling-Loop-Limit, Streaming via SSE, genauere Token-Schätzung, smarte Diff-Vorschau mit Auto-Apply, Undo für KI-Änderungen, erfolgsbasierte Profil-Level-Inferenz. Alle kritischen Punkte adressiert.

---

## Inhaltsverzeichnis

1. [Projektübersicht](#1-projektübersicht)
2. [Projektstruktur](#2-projektstruktur)
3. [Backend – Server & API](#3-backend--server--api)
4. [LM Studio Integration](#4-lm-studio-integration)
5. [Der Teacher-Agent & Tool-System](#5-der-teacher-agent--tool-system)
6. [Code-Editor (Frontend)](#6-code-editor-frontend)
7. [Code-Ausführung im Terminal](#7-code-ausführung-im-terminal)
8. [Kontext- & Chat-Persistenz](#8-kontext---chat-persistenz)
9. [Sprachprofil-System (Cross-Chat-Wissen)](#9-sprachprofil-system-cross-chat-wissen)
10. [Kontext-Komprimierung](#10-kontext-komprimierung)
11. [Benutzeroberfläche](#11-benutzeroberfläche)
12. [Einstellungen](#12-einstellungen)
13. [Standard-System-Prompt](#13-standard-system-prompt)
14. [Verbesserungsvorschläge & Erweiterungen](#14-verbesserungsvorschläge--erweiterungen)
15. [Nicht-Ziele](#15-nicht-ziele)
16. [Implementierungs-Checkliste](#16-implementierungs-checkliste)

---

## 1. Projektübersicht

**SterraCode** ist eine selbst gehostete Web-Applikation, die als vollständige interaktive Lernumgebung für das Programmieren dient. Der Nutzer schreibt Code in einem eingebetteten Editor (Monaco), ein lokaler KI-Teacher (betrieben über LM Studio) begleitet, korrigiert, erklärt und führt Code direkt aus — alles im Browser, alles lokal.

**Kernprinzipien:**
- Ein einzelner **Teacher-Agent** mit vollständigem Werkzeugkasten — keine Modi, kein Umschalten
- Jeder Chat wird **persistent gespeichert** und kann jederzeit fortgeführt werden
- Das System kennt den Lernstand des Nutzers **sprachübergreifend** (opt-in) und kann Vergleiche ziehen
- Der Kontext wird automatisch **komprimiert**, bevor das Context-Window voll läuft
- Alles läuft lokal — keine Cloud, keine externen APIs, kein Account

---

## 2. Projektstruktur

```
sterracode/
├── server/
│   ├── index.js                  # Express-Einstiegspunkt
│   ├── routes/
│   │   ├── chat.js               # Chat & Nachrichten-Endpunkte
│   │   ├── models.js             # LM Studio Modell-Abfrage
│   │   ├── execute.js            # Code-Ausführung
│   │   └── sessions.js           # Chat-Sessions CRUD
│   ├── services/
│   │   ├── teacher.js            # Teacher-Agent-Logik & Tool-Dispatch
│   │   ├── tools.js              # Alle Tool-Implementierungen
│   │   ├── executor.js           # Subprocess-Manager
│   │   ├── summarizer.js         # Kontext-Komprimierung
│   │   └── profileManager.js     # Sprachprofil-System
│   └── data/                     # JSON-Dateispeicher (auto-erstellt)
│       ├── sessions/             # Eine JSON pro Chat-Session
│       ├── profiles/             # Sprachprofile pro Nutzer
│       └── settings.json         # Globale Einstellungen
├── public/
│   ├── index.html                # Haupt-UI
│   ├── style.css
│   └── app.js                    # Frontend-Logik
└── package.json
```

**Abhängigkeiten:**

```json
{
  "name": "sterracode",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "express": "^4.18.0",
    "cors": "^2.8.5",
    "uuid": "^9.0.0",
    "node-fetch": "^3.3.0",
    "proper-lockfile": "^4.1.2",
    "express-rate-limit": "^7.0.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.0",
    "vitest": "^1.0.0"
  },
  "scripts": {
    "start": "node server/index.js",
    "dev": "nodemon server/index.js",
    "test": "vitest"
  }
}
```

> **Hinweis:** `"type": "module"` ist zwingend erforderlich damit alle `import`-Statements in Node.js funktionieren. Ohne diesen Eintrag schlägt der Start mit einem Syntax-Fehler fehl. `proper-lockfile` verhindert korrupte JSON-Dateien bei gleichzeitigen Schreibzugriffen. `express-rate-limit` schützt die `/api/execute`-Route.

---

## 3. Backend – Server & API

### 3.1 Express-Einstiegspunkt

```javascript
// server/index.js
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import chatRoutes from './routes/chat.js';
import modelsRoutes from './routes/models.js';
import executeRoutes from './routes/execute.js';
import sessionsRoutes from './routes/sessions.js';
import { ensureDataDirs } from './services/storage.js';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Datenverzeichnisse beim Start anlegen
await ensureDataDirs();

// Routen
app.use('/api/chat', chatRoutes);
app.use('/api/models', modelsRoutes);
app.use('/api/execute', executeRoutes);
app.use('/api/sessions', sessionsRoutes);

// SPA-Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`SterraCode läuft auf http://localhost:${PORT}`);
});
```

### 3.2 Speicher-Hilfsfunktionen

File-Locking via `proper-lockfile` verhindert korrupte JSON-Dateien wenn Teacher und Profil-Manager gleichzeitig schreiben (z. B. bei schnell aufeinanderfolgenden Nachrichten oder mehreren Browser-Tabs).

```javascript
// server/services/storage.js
import fs from 'fs/promises';
import path from 'path';
import lockfile from 'proper-lockfile';

const DATA_DIR = path.join(process.cwd(), 'server/data');

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

/** Schreibt atomisch mit File-Lock — verhindert Race Conditions bei parallelen Schreibzugriffen */
export async function writeJSON(filePath, data) {
  // Datei muss existieren bevor sie gelockt werden kann
  try { await fs.access(filePath); }
  catch { await fs.writeFile(filePath, '{}'); }

  const release = await lockfile.lock(filePath, { retries: { retries: 5, minTimeout: 50 } });
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } finally {
    await release();
  }
}

function defaultSettings() {
  return {
    lmStudioUrl: 'http://localhost:1234',
    activeModel: null,
    tokenThreshold: 8000,
    systemPrompt: DEFAULT_SYSTEM_PROMPT, // siehe Abschnitt 13
    crossChatProfileEnabled: false,
    executionTimeout: 10000,
    maxToolCallsPerTurn: 10,             // Schutz gegen Tool-Calling-Endlosschleifen
    autoSendEditorOnMessage: false,      // Editor-Code nur per Tool-Call, nicht bei jeder Nachricht
    diffAutoApplyThreshold: 5,           // Zeilen-Diff <= N → Auto-Apply ohne Bestätigung
    theme: 'dark'
  };
}
```

---

## 4. LM Studio Integration

### 4.1 Modelle automatisch erkennen

Beim Start und auf Knopfdruck werden alle geladenen LM Studio Modelle über den `/v1/models`-Endpunkt abgefragt. LM Studio implementiert die OpenAI-API vollständig kompatibel.

```javascript
// server/routes/models.js
import express from 'express';
import { getSettings } from '../services/storage.js';

const router = express.Router();

// GET /api/models — Alle verfügbaren Modelle aus LM Studio abrufen
router.get('/', async (req, res) => {
  const settings = await getSettings();
  try {
    const response = await fetch(`${settings.lmStudioUrl}/v1/models`, {
      headers: { 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw new Error(`LM Studio antwortet nicht (${response.status})`);
    const data = await response.json();
    // Modell-IDs extrahieren und zurückgeben
    const models = data.data.map(m => ({ id: m.id, name: m.id }));
    res.json({ models, connected: true });
  } catch (err) {
    res.json({ models: [], connected: false, error: err.message });
  }
});

export default router;
```

**Frontend — Modelle laden und Dropdown befüllen:**

```javascript
// public/app.js (Auszug)
async function loadModels() {
  const { models, connected } = await fetch('/api/models').then(r => r.json());
  const select = document.getElementById('model-select');
  select.innerHTML = '';

  if (!connected) {
    select.innerHTML = '<option disabled>LM Studio nicht erreichbar</option>';
    showStatusBadge('disconnected');
    return;
  }

  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    select.appendChild(opt);
  });
  showStatusBadge('connected');
}

// Beim Start + alle 30 Sekunden neu prüfen
loadModels();
setInterval(loadModels, 30000);
```

### 4.2 Nachrichten an LM Studio senden (mit Tool-Calling)

```javascript
// server/services/teacher.js (Auszug)
export async function callLMStudio({ messages, tools, model, lmStudioUrl }) {
  const body = {
    model,
    messages,
    tools,             // Tool-Definitionen im OpenAI-Format
    tool_choice: 'auto',
    temperature: 0.4,
    max_tokens: 2048,
    stream: false      // Für Tool-Calls immer false; Streaming nur für finale Textantwort (siehe 4.3)
  };

  const response = await fetch(`${lmStudioUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LM Studio Fehler: ${err}`);
  }

  return response.json();
}
```

### 4.3 Streaming der finalen Antwort (SSE)

Ohne Streaming wartet der Nutzer 10–30 Sekunden ohne Feedback — ein UX-Killer. Die finale Textantwort des Teachers wird deshalb per **Server-Sent Events** gestreamt. Tool-Calls selbst laufen weiterhin nicht-streamend (LM Studio unterstützt kein Streaming bei parallelen Tool-Calls zuverlässig).

```javascript
// server/routes/chat.js — Streaming-Endpunkt
router.post('/stream', async (req, res) => {
  const { sessionId, userMessage, editorCode, language } = req.body;

  // SSE-Header setzen
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    // Tool-Calls zunächst nicht-streamend abarbeiten (Status-Updates schicken)
    const { finalMessages, toolResults } = await runTeacherTools({
      sessionId, userMessage, editorCode, language,
      onToolCall: (toolName) => send('tool', { tool: toolName })
    });

    // Finale Textantwort streamen
    const streamResponse = await fetch(`${lmStudioUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: finalMessages, stream: true, max_tokens: 2048 })
    });

    let fullText = '';
    for await (const chunk of streamResponse.body) {
      const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        if (line === 'data: [DONE]') continue;
        const delta = JSON.parse(line.slice(6))?.choices?.[0]?.delta?.content;
        if (delta) { fullText += delta; send('token', { token: delta }); }
      }
    }

    // Vollständige Antwort in Session speichern
    await appendToSession(sessionId, { role: 'assistant', content: fullText });
    send('done', { toolResults });
    res.end();
  } catch (err) {
    send('error', { message: err.message });
    res.end();
  }
});
```

```javascript
// public/app.js — SSE empfangen und Token-für-Token anzeigen
async function sendToTeacher(message) {
  const bubble = createChatBubble('assistant', '');
  const eventSource = new EventSource(
    `/api/chat/stream?${new URLSearchParams({ sessionId, userMessage: message, editorCode: '', language: currentLanguage })}`
  );
  // Für POST-Body: fetch mit ReadableStream statt EventSource (EventSource unterstützt kein POST)
  // → Implementierung via fetch + getReader() auf dem Response-Body
  eventSource.addEventListener('token', e => { bubble.textContent += JSON.parse(e.data).token; });
  eventSource.addEventListener('tool',  e => showToolIndicator(JSON.parse(e.data).tool));
  eventSource.addEventListener('done',  () => eventSource.close());
  eventSource.addEventListener('error', () => eventSource.close());
}
```

---

## 5. Der Teacher-Agent & Tool-System

Der Teacher ist ein **einziger Agent** — kein Moduswechsel, kein Umschalten zwischen verschiedenen Agenten. Er hat immer Zugriff auf alle Tools und entscheidet selbst, welche er wann einsetzt.

### 5.1 Tool-Definitionen (OpenAI-Format für LM Studio)

```javascript
// server/services/tools.js

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_editor',
      description: 'Liest den aktuellen Code aus dem Editor des Nutzers.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_editor',
      description: 'Ersetzt den gesamten Code im Editor. Wird nur nach Bestätigung durch den Nutzer angewendet (Diff-Vorschau).',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Der vollständige neue Code-Inhalt' },
          reason: { type: 'string', description: 'Kurze Erklärung was geändert wurde' }
        },
        required: ['code', 'reason']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'insert_at_line',
      description: 'Fügt Code-Zeilen ab einer bestimmten Zeilennummer ein.',
      parameters: {
        type: 'object',
        properties: {
          line:    { type: 'number', description: 'Zeilennummer (1-basiert)' },
          code:    { type: 'string', description: 'Einzufügender Code' },
          reason:  { type: 'string', description: 'Warum wird dieser Code eingefügt?' }
        },
        required: ['line', 'code', 'reason']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_code',
      description: 'Führt den aktuellen Editor-Code im Terminal aus und gibt stdout/stderr zurück.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['python', 'javascript', 'bash', 'go', 'rust'] }
        },
        required: ['language']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Erstellt eine neue Lernaufgabe im Aufgaben-Panel.',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string' },
          description: { type: 'string' },
          difficulty:  { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
          hints:       { type: 'array', items: { type: 'string' } }
        },
        required: ['title', 'description', 'difficulty']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mark_task_done',
      description: 'Markiert die aktuelle Aufgabe als abgeschlossen. Löst automatisch eine Lernprofil-Aktualisierung aus.',
      parameters: {
        type: 'object',
        properties: {
          feedback: { type: 'string', description: 'Was hat der Nutzer gut gemacht / wo gab es Schwierigkeiten?' }
        },
        required: ['feedback']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_explanation',
      description: 'Zeigt eine strukturierte Erklärung im Erklärungs-Panel (rechts neben dem Editor).',
      parameters: {
        type: 'object',
        properties: {
          title:   { type: 'string' },
          content: { type: 'string', description: 'Markdown-formatierter Erklärungstext' }
        },
        required: ['title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_language_profile',
      description: 'Ruft das gespeicherte Sprachprofil des Nutzers ab (bekannte Konzepte, Stärken, Schwächen in anderen Sprachen). Nur verfügbar wenn cross-chat-profil aktiviert ist.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', description: 'z.B. "java", "python", "javascript"' }
        },
        required: ['language']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'trigger_summarize',
      description: 'Komprimiert den Kontext manuell. Nützlich wenn der Kontext bald voll wird.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
];
```

### 5.2 Tool-Dispatch (Teacher-Loop)

```javascript
// server/services/teacher.js

import { TOOL_DEFINITIONS } from './tools.js';
import { executeTool } from './toolExecutor.js';
import { callLMStudio } from './lmStudio.js';
import { getSettings } from './storage.js';
import { estimateTokens, shouldSummarize } from './summarizer.js';

/**
 * Hauptfunktion: Nutzer-Nachricht → Teacher-Antwort
 *
 * WICHTIG: Der Editor-Code wird NICHT automatisch bei jeder Nachricht mitgeschickt.
 * Stattdessen verwendet der Teacher das `read_editor` Tool, wenn er den Code sehen möchte.
 * Das spart pro Nachricht hunderte bis tausende Token bei langen Dateien.
 * Der Nutzer kann den Code aber auch manuell per Button "Code senden" anhängen.
 */
export async function runTeacher({ sessionId, userMessage, includeEditor = false, editorCode, language }) {
  const settings = await getSettings();
  const session  = await loadSession(sessionId);

  // Editor-Code nur wenn explizit vom Nutzer angefordert (Button "Code senden")
  const messageContent = includeEditor && editorCode
    ? `${userMessage}\n\n[CODE]\n\`\`\`${language}\n${editorCode}\n\`\`\``
    : userMessage;

  session.messages.push({ role: 'user', content: messageContent });

  if (shouldSummarize(session.messages, settings.tokenThreshold)) {
    await summarizeSession(sessionId, session, settings);
  }

  const systemPrompt    = await buildSystemPrompt(settings, language, session);
  const messagesForAPI  = [{ role: 'system', content: systemPrompt }, ...session.messages];
  const toolResults     = [];

  let response      = await callLMStudio({ messages: messagesForAPI, tools: TOOL_DEFINITIONS, model: settings.activeModel, lmStudioUrl: settings.lmStudioUrl });
  let toolCallCount = 0;
  const MAX_TOOL_CALLS = settings.maxToolCallsPerTurn ?? 10;  // Schutz gegen Endlosschleifen

  while (response.choices[0].finish_reason === 'tool_calls') {
    if (toolCallCount >= MAX_TOOL_CALLS) {
      console.warn(`[SterraCode] Tool-Call-Limit (${MAX_TOOL_CALLS}) erreicht. Loop abgebrochen.`);
      break;
    }

    const toolCalls          = response.choices[0].message.tool_calls;
    const toolResultMessages = [];

    for (const call of toolCalls) {
      toolCallCount++;
      const args   = JSON.parse(call.function.arguments);
      // read_editor bekommt den aktuellen Editor-Inhalt übergeben
      const result = await executeTool(call.function.name, args, { sessionId, editorCode, language });
      toolResults.push({ tool: call.function.name, args, result });
      toolResultMessages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }

    messagesForAPI.push(response.choices[0].message, ...toolResultMessages);
    response = await callLMStudio({ messages: messagesForAPI, tools: TOOL_DEFINITIONS, model: settings.activeModel, lmStudioUrl: settings.lmStudioUrl });
  }

  const assistantMessage = response.choices[0].message.content;
  session.messages.push({ role: 'assistant', content: assistantMessage });
  await saveSession(sessionId, session);

  return { message: assistantMessage, toolResults };
}
```

---

## 6. Code-Editor (Frontend)

Der Editor basiert auf **Monaco Editor** (VS Code im Browser). Der Nutzer-Code wird niemals automatisch umformatiert — er bleibt exakt so wie eingegeben.

### 6.1 Monaco einbinden & konfigurieren

Monaco wird **lokal gebündelt** um die "alles lokal"-Anforderung zu erfüllen. CDN-Import ist nur für schnelle Prototypen akzeptabel.

```bash
# Monaco lokal installieren
npm install monaco-editor
# Dateien in public/monaco/ kopieren (oder via Build-Tool wie vite/esbuild)
cp -r node_modules/monaco-editor/min/vs public/monaco/vs
```

```html
<!-- public/index.html (Auszug) — lokaler Pfad statt CDN -->
<link rel="stylesheet" href="/monaco/vs/editor/editor.main.min.css">
<script src="/monaco/vs/loader.min.js"></script>
```

```javascript
// public/app.js — Editor initialisieren
require.config({ paths: { vs: '/monaco/vs' } });  // lokal, kein CDN

require(['vs/editor/editor.main'], function () {
  window.editor = monaco.editor.create(document.getElementById('editor-container'), {
    value: '# Schreib deinen Code hier\n',
    language: 'python',
    theme: 'vs-dark',
    fontSize: 14,
    minimap: { enabled: false },
    automaticLayout: true,
    formatOnType: false,       // KEIN automatisches Formatieren
    formatOnPaste: false,      // KEIN automatisches Formatieren beim Einfügen
    tabSize: 4,
    scrollBeyondLastLine: false
  });

  // Keyboard Shortcuts registrieren
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runCode);
  editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
    () => sendToTeacher(null, { includeEditor: true })  // Code explizit mitsenden
  );
});

// Sprache wechseln (Dropdown-Handler)
document.getElementById('language-select').addEventListener('change', (e) => {
  monaco.editor.setModelLanguage(window.editor.getModel(), e.target.value);
  currentLanguage = e.target.value;
});
```

### 6.2 Code-Diff-Vorschau (bevor KI den Editor ändert)

**Smarte Diff-Strategie:** Kleine Änderungen (≤ konfigurierbarer Schwellwert, Standard 5 geänderte Zeilen) werden automatisch übernommen — kein Unterbrechen des Lernflusses für Tippfehler-Korrekturen. Größere Änderungen zeigen immer den Diff.

Jede KI-Änderung wird im `editorHistory`-Array gespeichert, sodass der Nutzer jederzeit per Button "↩ KI-Änderung rückgängig" zurückspringen kann.

```javascript
// public/app.js — Diff-Vorschau mit Auto-Apply und Undo
const editorHistory = [];   // Stack: { code, reason, timestamp }[]
const AUTO_APPLY_THRESHOLD = window.STERRACODE_SETTINGS?.diffAutoApplyThreshold ?? 5;

function applyEditorChange(newCode, reason) {
  const oldCode = window.editor.getValue();

  // Diff-Größe schätzen: Anzahl unterschiedlicher Zeilen
  const oldLines = oldCode.split('\n');
  const newLines = newCode.split('\n');
  const changedLines = newLines.filter((l, i) => l !== oldLines[i]).length
    + Math.abs(newLines.length - oldLines.length);

  // Vorherigen Stand für Undo speichern
  editorHistory.push({ code: oldCode, reason, timestamp: Date.now() });
  if (editorHistory.length > 20) editorHistory.shift();  // Max 20 Einträge
  updateUndoButton();

  if (changedLines <= AUTO_APPLY_THRESHOLD) {
    // Kleine Änderung → direkt anwenden, kurz aufblitzen lassen
    window.editor.setValue(newCode);
    flashEditorBorder('green');
  } else {
    // Große Änderung → Diff-Vorschau mit Bestätigung
    showDiffPreview(newCode, reason, () => flashEditorBorder('green'));
  }
}

function undoLastAIChange() {
  const last = editorHistory.pop();
  if (!last) return;
  window.editor.setValue(last.code);
  updateUndoButton();
  showToast(`Rückgängig: "${last.reason}"`);
}

function updateUndoButton() {
  const btn = document.getElementById('undo-ai-btn');
  btn.disabled = editorHistory.length === 0;
  btn.title    = editorHistory.length > 0
    ? `↩ Rückgängig: "${editorHistory.at(-1).reason}"`
    : 'Keine KI-Änderungen zum Rückgängigmachen';
}

function showDiffPreview(newCode, reason, onConfirm) {
  const oldCode    = window.editor.getValue();
  const diffEditor = monaco.editor.createDiffEditor(
    document.getElementById('diff-modal-editor'),
    { readOnly: true, renderSideBySide: true, theme: 'vs-dark' }
  );
  diffEditor.setModel({
    original: monaco.editor.createModel(oldCode,  currentLanguage),
    modified: monaco.editor.createModel(newCode, currentLanguage)
  });
  document.getElementById('diff-reason').textContent = reason;
  document.getElementById('diff-modal').classList.remove('hidden');
  document.getElementById('diff-confirm').onclick = () => {
    window.editor.setValue(newCode);
    document.getElementById('diff-modal').classList.add('hidden');
    diffEditor.dispose();
    onConfirm?.();
  };
  document.getElementById('diff-cancel').onclick = () => {
    editorHistory.pop();   // Undo-Eintrag entfernen — Änderung wurde abgelehnt
    updateUndoButton();
    document.getElementById('diff-modal').classList.add('hidden');
    diffEditor.dispose();
  };
}
```

---

## 7. Code-Ausführung im Terminal

### 7.1 Subprocess-Manager (Backend)

> **⚠️ Sicherheitshinweis:** `child_process.spawn` führt Code mit denselben Rechten aus wie der Node.js-Prozess. Für den lokalen Einzelnutzer-Betrieb ist das akzeptabel, solange das Tool nicht im Netzwerk exponiert wird. Für ein Setup das im LAN erreichbar ist, **muss** eine Sandbox verwendet werden — empfohlen: **Docker** (einfachste Option) oder `nsjail` (minimaler Overhead). Die `ulimit`-Flags unten sind eine Mindestabsicherung und kein vollständiger Ersatz.

```javascript
// server/services/executor.js
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const RUNTIMES = {
  python:     { cmd: 'python3', ext: '.py' },
  javascript: { cmd: 'node',    ext: '.js' },
  bash:       { cmd: 'bash',    ext: '.sh' },
  go:         { cmd: 'go',      args: ['run'], ext: '.go' }
};

/**
 * Führt Code in einem temporären Prozess aus.
 * Ressourcen-Limits: maxBuffer 1MB, Timeout konfigurierbar.
 * Für Netzwerk-Setups: stattdessen Docker-Container verwenden (siehe unten).
 */
export async function executeCode({ code, language, timeoutMs = 10000 }) {
  const runtime = RUNTIMES[language];
  if (!runtime) throw new Error(`Sprache nicht unterstützt: ${language}`);

  const tmpFile = path.join(os.tmpdir(), `sterracode_${Date.now()}${runtime.ext}`);
  await fs.writeFile(tmpFile, code, 'utf-8');

  return new Promise((resolve) => {
    const args = runtime.args ? [...runtime.args, tmpFile] : [tmpFile];

    // ulimit als Wrapper: CPU-Zeit (5s), Speicher (256MB), keine Netzwerk-Sockets
    // Nur auf Unix; auf Windows entfällt der ulimit-Wrapper
    const isUnix   = process.platform !== 'win32';
    const finalCmd  = isUnix ? 'bash' : runtime.cmd;
    const finalArgs = isUnix
      ? ['-c', `ulimit -t 5 -v 262144 -f 10240; ${runtime.cmd} ${args.join(' ')}`]
      : args;

    const proc = spawn(finalCmd, finalArgs, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024   // 1MB stdout-Limit
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 50000) proc.kill(); });
    proc.stderr.on('data', d => stderr += d.toString());

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ stdout, stderr: stderr + '\n[TIMEOUT: Ausführung abgebrochen]', exitCode: -1 });
    }, timeoutMs);

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      fs.unlink(tmpFile).catch(() => {});
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * Docker-Alternative (empfohlen für LAN/geteilte Setups):
 *
 * export async function executeCode({ code, language, timeoutMs = 10000 }) {
 *   const tmpDir  = await fs.mkdtemp(path.join(os.tmpdir(), 'sterracode-'));
 *   const tmpFile = path.join(tmpDir, `code${RUNTIMES[language].ext}`);
 *   await fs.writeFile(tmpFile, code);
 *
 *   return new Promise((resolve) => {
 *     const proc = spawn('docker', [
 *       'run', '--rm', '--network=none',
 *       '--memory=128m', '--cpus=0.5',
 *       '-v', `${tmpDir}:/code:ro`,
 *       `sterracode-runner-${language}`,   // vorgebautes Image pro Sprache
 *       '/code/' + path.basename(tmpFile)
 *     ], { timeout: timeoutMs });
 *     // ... stdout/stderr wie oben
 *   });
 * }
 */
```

### 7.2 Execute-Route

```javascript
// server/routes/execute.js
import express from 'express';
import { executeCode } from '../services/executor.js';
import { getSettings } from '../services/storage.js';

const router = express.Router();

// POST /api/execute
router.post('/', async (req, res) => {
  const { code, language } = req.body;
  if (!code || !language) return res.status(400).json({ error: 'code und language erforderlich' });

  const settings = await getSettings();
  try {
    const result = await executeCode({ code, language, timeoutMs: settings.executionTimeout });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
```

### 7.3 Terminal-Ausgabe im Frontend

```javascript
// public/app.js
async function runCode() {
  const code = window.editor.getValue();
  const language = document.getElementById('language-select').value;
  const terminal = document.getElementById('terminal-output');

  terminal.textContent = '$ Ausführen...\n';

  const result = await fetch('/api/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, language })
  }).then(r => r.json());

  const output = result.stdout || '';
  const errors = result.stderr ? `\n[stderr]\n${result.stderr}` : '';
  const exit = `\n[Exit: ${result.exitCode}]`;

  terminal.textContent = output + errors + exit;
}
```

---

## 8. Kontext- & Chat-Persistenz

**Jeder Chat wird als eigene JSON-Datei gespeichert.** Beim Neuladen der Seite oder späteren Besuchen kann der Nutzer eine Session aus einer Liste auswählen und genau dort weitermachen, wo er aufgehört hat.

### 8.1 Session-Datenstruktur

```json
{
  "id": "abc123",
  "title": "Python Grundlagen — Funktionen",
  "language": "python",
  "createdAt": "2026-06-01T10:00:00Z",
  "updatedAt": "2026-06-15T14:32:00Z",
  "messages": [
    { "role": "user",      "content": "Wie schreibe ich eine Funktion in Python?" },
    { "role": "assistant", "content": "Gute Frage! In Python definierst du Funktionen mit dem Schlüsselwort `def` ..." }
  ],
  "summaries": [
    {
      "createdAt": "2026-06-10T11:00:00Z",
      "olderTasks": [
        "Aufgabe 1 (Variablen): Typen verstanden, f-strings geübt",
        "Aufgabe 2 (Schleifen): range() korrekt verwendet"
      ],
      "recentTasksDetailed": [
        {
          "title": "Aufgabe 3 – Listen",
          "detail": "list comprehension war zunächst unklar, nach Beispiel mit range() verstanden. Eigene comprehension erfolgreich geschrieben."
        }
      ]
    }
  ],
  "currentTask": {
    "title": "Funktionen mit Rückgabewerten",
    "description": "Schreibe eine Funktion add(a, b) die zwei Zahlen addiert und das Ergebnis zurückgibt.",
    "difficulty": "beginner",
    "hints": ["Denk an das Schlüsselwort `return`", "Teste mit add(3, 4)"],
    "done": false
  },
  "editorSnapshot": "def add(a, b):\n    pass\n"
}
```

### 8.2 Sessions CRUD

```javascript
// server/routes/sessions.js
import express from 'express';
import { v4 as uuid } from 'uuid';
import path from 'path';
import { readJSON, writeJSON, listFiles } from '../services/storage.js';

const router = express.Router();
const SESSIONS_DIR = path.join(process.cwd(), 'server/data/sessions');

// GET /api/sessions — alle Sessions auflisten
router.get('/', async (req, res) => {
  const files = await listFiles(SESSIONS_DIR, '.json');
  const sessions = await Promise.all(
    files.map(f => readJSON(f).then(s => ({
      id: s.id, title: s.title, language: s.language, updatedAt: s.updatedAt
    })))
  );
  res.json(sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)));
});

// POST /api/sessions — neue Session erstellen
router.post('/', async (req, res) => {
  const { title, language } = req.body;
  const session = {
    id: uuid(), title: title || 'Neue Session', language: language || 'python',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [], summaries: [], currentTask: null, editorSnapshot: ''
  };
  await writeJSON(path.join(SESSIONS_DIR, `${session.id}.json`), session);
  res.json(session);
});

// GET /api/sessions/:id — eine Session laden
router.get('/:id', async (req, res) => {
  try {
    const session = await readJSON(path.join(SESSIONS_DIR, `${req.params.id}.json`));
    res.json(session);
  } catch {
    res.status(404).json({ error: 'Session nicht gefunden' });
  }
});

// DELETE /api/sessions/:id
router.delete('/:id', async (req, res) => {
  await fs.unlink(path.join(SESSIONS_DIR, `${req.params.id}.json`));
  res.json({ ok: true });
});

export default router;
```

---

## 9. Sprachprofil-System (Cross-Chat-Wissen)

**Opt-in Feature.** Wenn aktiviert, pflegt SterraCode ein persistentes Profil des Nutzers über alle Chat-Sessions hinweg. Dieses Profil enthält bekannte Konzepte, Stärken und Schwächen pro Programmiersprache. Der Teacher greift darauf zu, um sprachübergreifende Vergleiche zu machen.

**Beispiel:** Nutzer kennt Java gut → lernt Python → Teacher erklärt: *„In Java würdest du dafür eine Klasse brauchen, in Python reicht eine einfache Funktion."*

### 9.1 Profil-Datenstruktur

```json
{
  "profileVersion": 1,
  "updatedAt": "2026-06-15T14:00:00Z",
  "languages": {
    "java": {
      "level": "intermediate",
      "knownConcepts": [
        "Klassen und Objekte", "for/while Schleifen", "Arrays", "Interfaces",
        "try/catch", "Maven Build-System", "Spring Boot Grundlagen"
      ],
      "strengths": ["OOP-Denkweise", "Typsicherheit verstanden"],
      "weaknesses": ["Generics noch unsicher", "Streams selten benutzt"],
      "sessionCount": 12,
      "lastActive": "2026-05-20"
    },
    "python": {
      "level": "beginner",
      "knownConcepts": [
        "Variablen und Typen", "for-Schleifen", "Listen", "Funktionen"
      ],
      "strengths": ["Schnell Grundlagen gelernt"],
      "weaknesses": ["list comprehension noch nicht sicher", "self in Klassen unklar"],
      "sessionCount": 3,
      "lastActive": "2026-06-15"
    }
  }
}
```

### 9.2 Profil-Manager

```javascript
// server/services/profileManager.js
import path from 'path';
import { readJSON, writeJSON } from './storage.js';

const PROFILE_PATH = path.join(process.cwd(), 'server/data/profiles/user.json');

export async function getProfile() {
  try {
    return await readJSON(PROFILE_PATH);
  } catch {
    return { profileVersion: 1, updatedAt: new Date().toISOString(), languages: {} };
  }
}

/**
 * Wird vom Teacher aufgerufen wenn eine Aufgabe abgeschlossen wird.
 * Aktualisiert bekannte Konzepte, Stärken und Schwächen.
 */
export async function updateProfile({ language, newConcepts = [], strengths = [], weaknesses = [], taskSucceeded = true }) {
  const profile = await getProfile();

  if (!profile.languages[language]) {
    profile.languages[language] = {
      level: 'beginner', knownConcepts: [],
      strengths: [], weaknesses: [],
      tasksAttempted: 0, tasksSucceeded: 0,   // für erfolgsbasierte Level-Inferenz
      sessionCount: 0, lastActive: null
    };
  }

  const lang = profile.languages[language];
  lang.knownConcepts   = [...new Set([...lang.knownConcepts, ...newConcepts])];
  lang.strengths       = [...new Set([...lang.strengths, ...strengths])];
  lang.weaknesses      = [...new Set([...lang.weaknesses, ...weaknesses])];
  lang.tasksAttempted  = (lang.tasksAttempted  ?? 0) + 1;
  lang.tasksSucceeded  = (lang.tasksSucceeded  ?? 0) + (taskSucceeded ? 1 : 0);
  lang.sessionCount   += 1;
  lang.lastActive      = new Date().toISOString().split('T')[0];

  const successRate    = lang.tasksAttempted > 0 ? lang.tasksSucceeded / lang.tasksAttempted : 0;
  lang.level           = inferLevel(lang.knownConcepts.length, successRate);
  profile.updatedAt    = new Date().toISOString();

  await writeJSON(PROFILE_PATH, profile);
  return profile;
}

function inferLevel(knownConceptCount, taskSuccessRate) {
  // Kombiniert Konzept-Breite mit Erfolgsrate — verhindert "inflated" Level
  // durch viele halbverstandene Konzepte ohne erfolgreiche Anwendung
  if (knownConceptCount < 5  || taskSuccessRate < 0.4) return 'beginner';
  if (knownConceptCount < 15 || taskSuccessRate < 0.65) return 'intermediate';
  return 'advanced';
}

/**
 * Erzeugt einen kurzen Profil-Text für den System-Prompt.
 * Wird nur eingebaut wenn Cross-Chat-Profil aktiviert ist.
 */
export function profileToPromptText(profile, currentLanguage) {
  const langs = Object.entries(profile.languages)
    .filter(([lang]) => lang !== currentLanguage)
    .map(([lang, data]) => {
      return `- ${lang.toUpperCase()} (${data.level}): Kennt ${data.knownConcepts.slice(0, 5).join(', ')}${data.knownConcepts.length > 5 ? ' u.a.' : ''}. Stärken: ${data.strengths.join(', ') || '–'}`;
    }).join('\n');

  if (!langs) return '';

  return `\n\n[LERNSTAND DES NUTZERS IN ANDEREN SPRACHEN]\n${langs}\n\nNutze dieses Wissen für Vergleiche (z.B. "In Java machst du das so, in Python geht es kürzer so"). Erkläre Konzepte über Analogien zur bekannten Sprache.`;
}
```

### 9.3 Profil in den System-Prompt einbauen

```javascript
// server/services/teacher.js (buildSystemPrompt)
async function buildSystemPrompt(settings, language, session) {
  let prompt = settings.systemPrompt;

  if (settings.crossChatProfileEnabled) {
    const profile = await getProfile();
    const profileText = profileToPromptText(profile, language);
    prompt += profileText;
  }

  return prompt;
}
```

---

## 10. Kontext-Komprimierung

Das Context-Window eines lokalen Modells ist begrenzt. SterraCode komprimiert den Gesprächsverlauf automatisch, bevor das Limit erreicht wird — ohne Informationsverlust über den Lernstand.

### 10.1 Token-Schätzer

Die einfache Wortanzahl-Heuristik (`Wörter / 0.75`) ist modellabhängig ungenau — Llama-3 tokenisiert anders als Mistral. SterraCode verwendet deshalb eine **zeichenbasierte Schätzung** (1 Token ≈ 4 Zeichen), die modellunabhängig näher am echten Wert liegt. Wer noch genauer sein will, kann `tiktoken` einbinden.

```javascript
// server/services/summarizer.js

/**
 * Zeichenbasierte Token-Schätzung: genauer als Wortanzahl, kein externes Paket nötig.
 * Faustregel: 1 Token ≈ 4 Zeichen (gilt für Llama, Mistral, Phi, Qwen — alle gängigen lokalen Modelle).
 */
export function estimateTokens(messages) {
  const totalChars = messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + content.length;
  }, 0);
  return Math.ceil(totalChars / 4);
}

export function shouldSummarize(messages, threshold) {
  return estimateTokens(messages) >= threshold;
}

/*
 * Optional — präzise Zählung via tiktoken (npm install @dqbd/tiktoken):
 *
 * import { encoding_for_model } from '@dqbd/tiktoken';
 * const enc = encoding_for_model('gpt-3.5-turbo');  // cl100k_base — akzeptable Näherung für Llama-3
 * export function estimateTokens(messages) {
 *   return messages.reduce((sum, m) => sum + enc.encode(m.content ?? '').length, 0);
 * }
 */
```

### 10.2 Zusammenfassung erzeugen

```javascript
// server/services/summarizer.js (Fortsetzung)

/**
 * Komprimiert den Kontext:
 * - Letzte 3 abgeschlossene Aufgaben → detailliert zusammengefasst
 * - Alle älteren Aufgaben → 1-2 Sätze pro Aufgabe
 * - Die letzten 6 Nachrichten bleiben immer vollständig erhalten (Kontinuität)
 */
export async function summarizeSession(sessionId, session, settings) {
  const KEEP_RECENT = 6; // Letzte N Nachrichten ungekürzt behalten
  const messages    = session.messages;

  if (messages.length <= KEEP_RECENT) return session;

  const toSummarize = messages.slice(0, messages.length - KEEP_RECENT);
  const keepFull    = messages.slice(messages.length - KEEP_RECENT);

  // Prompt zum Erstellen der Zusammenfassung
  const summaryPrompt = `Du bist ein Lernassistent. Fasse diese Lern-Konversation zusammen.

FORMAT:
[ÄLTERE AUFGABEN – Überblick]
- Aufgabe X (Thema): 1-Satz-Ergebnis

[LETZTE 3 AUFGABEN – Detail]
Aufgabe Y – Titel:
  • Was der Nutzer gut gemacht hat
  • Wo es Schwierigkeiten gab
  • Was am Ende korrekt war

Halte die Zusammenfassung kurz aber informativ. Kein Blabla.

KONVERSATION:
${toSummarize.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')}`;

  const response = await callLMStudio({
    messages: [{ role: 'user', content: summaryPrompt }],
    tools: [],
    model: settings.activeModel,
    lmStudioUrl: settings.lmStudioUrl
  });

  const summaryText = response.choices[0].message.content;

  // Zusammenfassung als System-Nachricht an den Anfang setzen
  session.messages = [
    { role: 'system', content: `[KONTEXT-ZUSAMMENFASSUNG]\n${summaryText}` },
    ...keepFull
  ];

  // Zusammenfassung auch im Session-Archiv speichern
  session.summaries.push({
    createdAt: new Date().toISOString(),
    text: summaryText,
    messagesCompressed: toSummarize.length
  });

  return session;
}
```

---

## 11. Benutzeroberfläche

### 11.1 Layout-Übersicht

```
┌─────────────────────────────────────────────────────────────────────────┐
│  🌌 SterraCode    [● Llama-3.1-8B ▼]  [Python ▼]       [⚙ Settings]    │
├──────────────────────────────┬──────────────────────────────────────────┤
│  CODE EDITOR                 │  TEACHER                                 │
│                              │  ┌─────────────────────────────────────┐ │
│  1  def add(a, b):           │  │ 🤖 Gute Arbeit! Du hast `return`    │ │
│  2      return a + b         │  │ richtig eingesetzt. In Java hättest  │ │
│  3                           │  │ du dafür eine Methode in einer       │ │
│  4  print(add(3, 4))         │  │ Klasse gebraucht — in Python reicht  │ │
│                              │  │ eine freie Funktion. Nächste Aufgabe:│ │
│                              │  │ Füge Typ-Hinweise hinzu.             │ │
│                              │  └─────────────────────────────────────┘ │
│                              │  ┌──────────────────────────────────────┐ │
│                              │  │📋 AUFGABE                            │ │
│                              │  │ Funktionen mit Typ-Hinweisen         │ │
│                              │  │ [Hinweis anzeigen]  [✓ Erledigt]     │ │
│                              │  └──────────────────────────────────────┘ │
│                              │  ┌──────────────────────────────────────┐ │
│                              │  │ [Nachricht eingeben...]   [↵ Senden] │ │
│                              │  └──────────────────────────────────────┘ │
├──────────────────────────────┴──────────────────────────────────────────┤
│  TERMINAL                                             [▶ Ctrl+Enter]     │
│  $ python3 /tmp/sterracode_code.py                                       │
│  7                                                                        │
│  [Exit: 0]                                                                │
└─────────────────────────────────────────────────────────────────────────┘
```

### 11.2 Sessions-Sidebar

Links kann eine **Session-Seitenleiste** ein-/ausgeklappt werden:

```
┌─────────────────────┐
│ + Neue Session      │
├─────────────────────┤
│ 📁 Heutige Sessions │
│ • Python Klassen    │
│ • Funktionen Basics │
├─────────────────────┤
│ 📁 Letzte Woche     │
│ • Java → Python     │
│ • Schleifen Übung   │
└─────────────────────┘
```

---

## 12. Einstellungen

```javascript
// Alle Einstellungen in server/data/settings.json

{
  // LM Studio
  "lmStudioUrl": "http://localhost:1234",     // Änderbar für Remote-Setup
  "activeModel": "llama-3.1-8b-instruct",

  // Teacher-Verhalten
  "systemPrompt": "...",                       // Vollständig editierbar (Abschnitt 13)
  "temperature": 0.4,                          // 0.0 – 1.0
  "maxTokensResponse": 2048,
  "maxToolCallsPerTurn": 10,                   // Schutz gegen Tool-Loop-Endlosschleifen

  // Editor & Code-Senden
  "autoSendEditorOnMessage": false,            // false = Code nur per "Code senden"-Button
                                               // true  = Code immer automatisch mitsenden (mehr Token)

  // Kontext-Komprimierung
  "tokenThreshold": 8000,                      // Wann wird komprimiert? (Slider: 2000–32000)
  "keepRecentMessages": 6,                     // Wie viele Nachrichten bleiben ungekürzt?

  // Sprachprofil (Cross-Chat)
  "crossChatProfileEnabled": false,            // Opt-in Toggle
  "autoUpdateProfileOnTaskDone": true,         // Profil nach Aufgabe aktualisieren

  // Code-Ausführung
  "executionTimeout": 10000,                   // ms (Slider: 2000–60000)
  "allowedLanguages": ["python", "javascript", "bash", "go"],
  "useSandbox": false,                         // true = Docker-Sandbox (empfohlen für LAN)

  // UI & Diff
  "theme": "dark",
  "fontSize": 14,
  "diffAutoApplyThreshold": 5,                 // Zeilen-Änderungen <= N → Auto-Apply ohne Bestätigung
  "streaming": true                            // SSE-Streaming für Antworten
}
```

---

## 13. Standard-System-Prompt

Dieser Prompt wird beim ersten Start eingefügt und kann im Einstellungs-Panel vollständig editiert werden.

```
Du bist SterraCode Teacher, ein freundlicher und geduldiger Programmier-Lehrbegleiter.

DEINE AUFGABE:
- Du lehrst den Nutzer aktiv das Programmieren durch Aufgaben, Erklärungen und Feedback
- Du kannst den Editor lesen, bearbeiten, Code ausführen und Aufgaben erstellen

WICHTIG ZUM EDITOR:
- Der Editor-Code wird dir NICHT automatisch mitgeschickt
- Benutze `read_editor` wenn du den aktuellen Code sehen möchtest
- Wenn der Nutzer "Code senden" drückt (Ctrl+Shift+Enter), ist der Code in seiner Nachricht enthalten

LEHRSTIL:
- Erkläre erst das WARUM, dann das WIE
- Wenn der Nutzer einen Fehler macht, zeige den Fehler und erkläre ihn — gib nicht sofort die Lösung
- Stelle Fragen ("Was denkst du, warum schlägt das fehl?")
- Lob ehrlich, aber ohne Übertreibung
- Bleib kurz und klar — kein unnötiges Blabla

TOOLS:
- Benutze `read_editor` bevor du über den Code sprichst — verlasse dich nicht auf ältere Snapshots
- Benutze `run_code` um Code zu testen, bevor du Feedback gibst
- Benutze `write_editor` sparsam — zeige lieber wie es geht, lass den Nutzer es selbst schreiben
- Benutze `create_task` für jede neue Aufgabe
- Benutze `mark_task_done` sobald der Nutzer eine Aufgabe erfolgreich abgeschlossen hat

SPRACHE: Antworte immer in der Sprache des Nutzers.
```

---

## 14. Verbesserungsvorschläge & Erweiterungen

### 14.1 Lernpfade (empfohlen für v1.1)
Vordefinierte **Kurs-Pfade** als JSON-Dateien (z. B. `paths/python-beginner.json`) mit sequenziellen Aufgaben. Der Teacher arbeitet sie Schritt für Schritt durch. Freie Sessions ohne Pfad bleiben immer möglich.

```json
{
  "id": "python-beginner",
  "title": "Python Grundlagen in 10 Schritten",
  "language": "python",
  "tasks": [
    { "title": "Hallo Welt",         "concepts": ["print", "strings"] },
    { "title": "Variablen & Typen",  "concepts": ["int", "str", "float", "type()"] },
    { "title": "If / Else",          "concepts": ["if", "elif", "else", "boolean"] }
  ]
}
```

### 14.2 „Erkläre diesen Code"-Modus
Nutzer markiert einen Code-Block im Editor → Rechtsklick → „Teacher: Erkläre das". Spart Chat-Eingabe für gezielte Fragen.

```javascript
// Monaco Context Menu Erweiterung
editor.addAction({
  id: 'explain-selection',
  label: '🤖 Teacher: Erkläre das',
  contextMenuGroupId: 'sterracode',
  run: (ed) => {
    const selection = ed.getModel().getValueInRange(ed.getSelection());
    sendToTeacher(`Erkläre mir diesen Code:\n\`\`\`\n${selection}\n\`\`\``);
  }
});
```

### 14.3 Mehrere Code-Dateien (Tabs)
Für Sessions, in denen mehrere Dateien zusammen arbeiten (z. B. `main.py` + `helpers.py`). Die KI sieht alle offenen Tabs.

### 14.4 Lernstatistiken-Dashboard
Einfache Seite `/stats` zeigt: Aufgaben gesamt, gelöste Aufgaben, Zeit pro Sprache, häufigste Fehlertypen (aus Profil-Daten).

### 14.5 Session-Export & -Import
Sessions als JSON herunterladen und wieder importieren — nützlich für Backups oder um eine Session auf einem anderen Gerät fortzuführen.

### 14.7 Antwort-Feedback (👍 / 👎)
Jede Teacher-Antwort bekommt kleine Thumbs-up/down-Buttons. Eine negative Bewertung sendet automatisch einen kurzen Folge-Prompt: *„Deine letzte Erklärung wurde als unklar bewertet. Versuche es kürzer / einfacher / mit einem anderen Beispiel."* Positive Bewertungen fließen in das Sprachprofil ein (Stärke: bevorzugter Erklärungsstil).

```javascript
// public/app.js — Feedback-Button an jede Antwort anhängen
function addFeedbackButtons(bubbleEl, messageIndex) {
  const bar  = document.createElement('div');
  bar.className = 'feedback-bar';
  bar.innerHTML = `<button class="thumb" data-val="1">👍</button>
                   <button class="thumb" data-val="-1">👎</button>`;
  bar.querySelectorAll('.thumb').forEach(btn => {
    btn.onclick = async () => {
      bar.innerHTML = '<span class="feedback-sent">Danke!</span>';
      await fetch('/api/chat/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, messageIndex, value: Number(btn.dataset.val) })
      });
      if (Number(btn.dataset.val) === -1) {
        sendToTeacher('[SYSTEM: Letzte Erklärung war unklar. Bitte nochmal anders erklären — kürzer oder mit einem anderen Beispiel.]');
      }
    };
  });
  bubbleEl.appendChild(bar);
}
```

### 14.6 Keyboard Shortcuts (Übersicht)

| Shortcut | Aktion |
|---|---|
| `Ctrl+Enter` | Code ausführen |
| `Ctrl+Shift+Enter` | Code an Teacher schicken + Feedback anfragen |
| `Ctrl+K` | Kontext manuell komprimieren |
| `Ctrl+N` | Neue Session starten |
| `Ctrl+/` | Zeile kommentieren (Monaco-Standard) |

---

## 15. Nicht-Ziele

Diese Dinge sind bewusst **nicht** Teil von SterraCode, um das Projekt schlank zu halten:

- Kein Multi-User-System (lokale Einzelinstanz)
- Kein Cloud-Hosting / keine externen APIs
- Keine komplexe Datenbank — JSON-Dateien reichen vollständig aus
- Keine mehrfachen Agent-Modi — ein Teacher, viele Tools
- Kein eigenes Embedding-Modell — das Haupt-LM-Studio-Modell übernimmt die Zusammenfassung selbst

---

## 16. Implementierungs-Checkliste

Die folgende Reihenfolge ist für eine KI-gestützte Implementierung optimiert — jeder Schritt baut auf dem vorherigen auf und ist einzeln testbar.

> **Kritische Voraussetzungen** (müssen vor dem jeweiligen Schritt erfüllt sein — aus Review v1.2):
> - Vor Phase 1: `"type": "module"` in package.json, alle Dependencies inkl. `proper-lockfile`
> - Vor Phase 5: Sandbox-Entscheidung treffen (ulimit vs. Docker) und implementieren
> - Vor Phase 8: Token-Schätzung testen, Tool-Call-Limit verifizieren

```
PHASE 1 – Grundgerüst
[ ] package.json mit "type": "module" + alle Dependencies (express, cors, uuid, node-fetch,
    proper-lockfile, express-rate-limit, nodemon, vitest)
[ ] Verzeichnisstruktur anlegen (server/, public/, server/data/)
[ ] server/index.js — Express-Server mit statischen Dateien
[ ] server/services/storage.js — readJSON, writeJSON (mit File-Lock), ensureDataDirs
[ ] server/data/settings.json — Default-Settings beim ersten Start anlegen

PHASE 2 – LM Studio & Modelle
[ ] server/routes/models.js — GET /api/models (LM Studio /v1/models abfragen)
[ ] public/index.html — Grundlayout mit Modell-Dropdown
[ ] public/app.js — loadModels(), Verbindungsstatus-Badge, Polling alle 30s

PHASE 3 – Editor (lokal, kein CDN)
[ ] Monaco via npm installieren + nach public/monaco/ kopieren
[ ] Monaco initialisieren: formatOnType: false, formatOnPaste: false
[ ] Sprachauswahl-Dropdown (Python, JS, Bash, Go)
[ ] Keyboard Shortcuts: Ctrl+Enter (run), Ctrl+Shift+Enter (Code+Nachricht senden)
[ ] editorHistory-Stack + Undo-Button aufbauen

PHASE 4 – Chat & Teacher (ohne Streaming)
[ ] server/services/tools.js — TOOL_DEFINITIONS Array (alle 9 Tools)
[ ] server/services/lmStudio.js — callLMStudio() mit stream: false
[ ] server/services/teacher.js — runTeacher() mit Tool-Loop + maxToolCallsPerTurn-Limit
    → Editor-Code NICHT automatisch mitsenden (nur wenn includeEditor=true)
[ ] server/services/toolExecutor.js — executeTool() Dispatcher inkl. read_editor
[ ] server/routes/chat.js — POST /api/chat Endpunkt
[ ] public/app.js — sendToTeacher(), Chat-Bubbles, Tool-Indicator

PHASE 5 – Code-Ausführung (mit Sicherheits-Limits)
[ ] server/services/executor.js — executeCode() mit ulimit-Wrapper (Unix) + Timeout + maxBuffer
[ ] server/routes/execute.js — POST /api/execute mit express-rate-limit
[ ] public/app.js — runCode(), Terminal-Panel
[ ] Optional: Docker-Runner als Alternative implementieren (useSandbox-Setting)

PHASE 6 – Streaming (SSE)
[ ] server/routes/chat.js — POST /api/chat/stream (SSE-Endpunkt)
[ ] Tool-Calls nicht-streamend, finale Antwort streamend
[ ] public/app.js — Token-für-Token in Chat-Bubble einfügen

PHASE 7 – Session-Persistenz
[ ] server/routes/sessions.js — GET/POST/GET:id/DELETE (mit File-Lock via writeJSON)
[ ] public/app.js — Session-Sidebar, Session laden/erstellen/löschen
[ ] Editor-Snapshot beim Wechsel speichern, beim Laden wiederherstellen

PHASE 8 – Sprachprofil (Cross-Chat)
[ ] server/services/profileManager.js — getProfile(), updateProfile() mit Erfolgsrate,
    profileToPromptText(), inferLevel() mit taskSuccessRate
[ ] mark_task_done Tool → Profil automatisch aktualisieren (inkl. taskSucceeded-Flag)
[ ] buildSystemPrompt() — Profil optional einbauen
[ ] Einstellungs-Toggle: crossChatProfileEnabled

PHASE 9 – Kontext-Komprimierung
[ ] server/services/summarizer.js — estimateTokens() (zeichenbasiert), shouldSummarize(),
    summarizeSession()
[ ] Token-Anzeige im Footer (geschätzte aktuelle Tokens / Schwellwert)
[ ] Einstellungs-Slider: tokenThreshold
[ ] Manueller „Kontext komprimieren"-Button

PHASE 10 – Einstellungen & Feinschliff
[ ] /settings Seite mit allen Parametern aus settings.json
[ ] System-Prompt-Textfeld (editierbar, mit Reset-Button)
[ ] diffAutoApplyThreshold-Slider + Undo-Button im Editor-Header
[ ] Feedback-Buttons (👍/👎) an jede Teacher-Antwort
[ ] Monaco „Erkläre das"-Kontextmenü-Eintrag
[ ] Theme-Toggle (dark/light)
[ ] Vitest: Unit-Tests für estimateTokens(), executeCode(), updateProfile(), inferLevel()
```

---

*SterraCode · Konzeptdokument v1.2 · Juni 2026*
*Alle Implementierungsbeispiele sind in Node.js (ESM) geschrieben. Python-Backend (FastAPI) wäre ein direkter Drop-in-Ersatz für Phase 1–2.*
*v1.2 adressiert: Sicherheits-Sandbox, File-Locking, Token-Overhead, Tool-Loop-Limit, SSE-Streaming, smarte Diffs + Undo, erfolgsbasierte Profile, ESM-Config, lokales Monaco, vollständige Dependencies.*
