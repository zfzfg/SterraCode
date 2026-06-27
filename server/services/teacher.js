// server/services/teacher.js
import path from 'path';
import { readJSON, writeJSON, getSettings, DATA_DIR } from './storage.js';
import { callLMStudio } from './lmStudio.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { executeTool } from './toolExecutor.js';
import { estimateTokens, shouldSummarize, summarizeSession } from './summarizer.js';
import { getProfile, profileToPromptText } from './profileManager.js';
import { v4 as uuid } from 'uuid';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

// ─── Session helpers ───────────────────────────────────────────────────────

export async function loadSession(sessionId) {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  const session = await readJSON(filePath);
  if (!session.summaries) session.summaries = [];
  return session;
}

export async function saveSession(sessionId, session) {
  session.updatedAt = new Date().toISOString();
  await writeJSON(path.join(SESSIONS_DIR, `${sessionId}.json`), session);
}

// ─── System prompt builder ─────────────────────────────────────────────────

const LANGUAGE_PROMPTS = {
  python: `Du unterrichtest gerade PYTHON.
- Alle deine Codebeispiele MÜSSEN in Python verfasst sein.
- Wenn du eine neue Aufgabe erstellst, erstelle danach immer ein Python-Skelett mit \`write_editor\`.
- Beispiel für eine Python-Funktion:
\`\`\`python
def begruessen(name):
    print("Hallo " + name)

begruessen("Anna")
\`\`\`
`,
  javascript: `Du unterrichtest gerade JAVASCRIPT (Node.js/Frontend).
- Alle deine Codebeispiele MÜSSEN in JavaScript verfasst sein.
- Wenn du eine neue Aufgabe erstellst, erstelle danach immer ein Javascript-Skelett mit \`write_editor\`.
- Beispiel für eine Javascript-Funktion:
\`\`\`javascript
function begruessen(name) {
    console.log("Hallo " + name);
}

begruessen("Anna");
\`\`\`
`,
  bash: `Du unterrichtest gerade BASH (Shell-Scripting).
- Alle deine Codebeispiele MÜSSEN in Bash verfasst sein.
- Wenn du eine neue Aufgabe erstellst, erstelle danach ein Bash-Skelett mit \`write_editor\`.
- Beispiel für ein Shell-Script:
\`\`\`bash
begruessen() {
    local name="$1"
    echo "Hallo $name"
}

begruessen "Anna"
\`\`\`
`,
  go: `Du unterrichtest gerade GO (Golang).
- Alle deine Codebeispiele MÜSSEN in Go verfasst sein und eine vollständige 'package main' und 'func main()' Struktur haben, sofern es sinnvoll ist.
- Wenn du eine neue Aufgabe erstellst, erstelle danach ein Go-Skelett mit \`write_editor\`.
- Beispiel für eine Go-Struktur:
\`\`\`go
package main

import "fmt"

func begruessen(name string) {
    fmt.Println("Hallo " + name)
}

func main() {
    begruessen("Anna")
}
\`\`\`
`,
  rust: `Du unterrichtest gerade RUST.
- Alle deine Codebeispiele MÜSSEN in Rust verfasst sein. Achte auf Typsicherheit und sicheren Memory-Umgang (Ownership, Borrowing).
- Wenn du eine neue Aufgabe erstellst, erstelle danach ein Rust-Skelett mit \`write_editor\`.
- Beispiel für Rust:
\`\`\`rust
fn begruessen(name: &str) {
    println!("Hallo {}", name);
}

fn main() {
    begruessen("Anna");
}
\`\`\`
`,
  cpp: `Du unterrichtest gerade C++.
- Alle deine Codebeispiele MÜSSEN in modernem C++ (C++17 oder neuer) verfasst sein. Verwende std::cout, std::string usw.
- Wenn du eine neue Aufgabe erstellst, erstelle danach ein C++-Skelett mit \`write_editor\`.
- Beispiel für C++:
\`\`\`cpp
#include <iostream>
#include <string>

void begruessen(std::string name) {
    std::cout << "Hallo " << name << std::endl;
}

int main() {
    begruessen("Anna");
    return 0;
}
\`\`\`
`,
  csharp: `Du unterrichtest gerade C# (C-Sharp).
- Alle deine Codebeispiele MÜSSEN in C# verfasst sein. Verwende moderne C#-Konventionen.
- Wenn du eine neue Aufgabe erstellst, erstelle danach ein C#-Skelett mit \`write_editor\`.
- Beispiel für C#:
\`\`\`csharp
using System;

class Program {
    static void Begruessen(string name) {
        Console.WriteLine("Hallo " + name);
    }

    static void Main() {
        Begruessen("Anna");
    }
}
\`\`\`
`,
  lua: `Du unterrichtest gerade LUA.
- Alle deine Codebeispiele MÜSSEN in Lua verfasst sein.
- Wenn du eine neue Aufgabe erstellst, erstelle danach ein Lua-Skelett mit \`write_editor\`.
- Beispiel für Lua:
\`\`\`lua
local function begruessen(name)
    print("Hallo " .. name)
end

begruessen("Anna")
\`\`\`
`,
  java: `Du unterrichtest gerade JAVA.
- Alle deine Codebeispiele MÜSSEN in Java verfasst sein. Verwende Klassenstrukturen (z.B. öffentliche Klasse Main mit public static void main).
- Wenn du eine neue Aufgabe erstellst, erstelle danach ein Java-Skelett mit \`write_editor\`.
- Beispiel für Java:
\`\`\`java
public class Main {
    public static void begruessen(String name) {
        System.out.println("Hallo " + name);
    }

    public static void main(String[] args) {
        begruessen("Anna");
    }
}
\`\`\`
`
};

async function buildSystemPrompt(settings, language) {
  let prompt = settings.systemPrompt || '';

  // Appending language-specifc instruction to guide choice of code blocks
  const lowerLang = (language || 'python').toLowerCase();
  const langPrompt = LANGUAGE_PROMPTS[lowerLang] || LANGUAGE_PROMPTS['python'];

  prompt += `\n\n=== AKTUELLE SESSON-SPRACHE ===\n${langPrompt}`;

  if (settings.crossChatProfileEnabled) {
    try {
      const profile = await getProfile();
      prompt += profileToPromptText(profile, language);
    } catch {
      // Profile unavailable — proceed without it
    }
  }

  return prompt;
}

// ─── Main Teacher loop (non-streaming) ────────────────────────────────────

/**
 * Processes a user message through the Teacher agent.
 *
 * IMPORTANT: Editor code is NOT sent automatically with every message.
 * The LM uses read_editor tool when it needs to see the current code.
 * The user can explicitly include the code via includeEditor=true (Ctrl+Shift+Enter).
 */
export async function runTeacher({ sessionId, userMessage, includeEditor = false, editorCode = '', language = 'python' }) {
  const settings = await getSettings();
  const session  = await loadSession(sessionId);

  // Only attach editor code if user explicitly requested it
  const messageContent = (includeEditor && editorCode)
    ? `${userMessage}\n\n[CODE]\n\`\`\`${language}\n${editorCode}\n\`\`\``
    : userMessage;

  session.messages.push({ role: 'user', content: messageContent });

  // Auto-summarize if token threshold reached
  if (shouldSummarize(session.messages, settings.tokenThreshold)) {
    await summarizeSession(session, settings);
  }

  const systemPrompt   = await buildSystemPrompt(settings, language);
  const messagesForAPI = [{ role: 'system', content: systemPrompt }, ...session.messages];
  const toolResults    = [];
  const context        = { sessionId, editorCode, language, session, settings };

  let response      = await callLMStudio({
    messages:    messagesForAPI,
    tools:       TOOL_DEFINITIONS,
    model:       settings.activeModel,
    lmStudioUrl: settings.lmStudioUrl,
    temperature: settings.temperature,
    maxTokens:   settings.maxTokensResponse
  });

  let toolCallCount = 0;
  const MAX_TOOL_CALLS = settings.maxToolCallsPerTurn ?? 10;

  // Tool-calling loop
  while (response.choices?.[0]?.finish_reason === 'tool_calls') {
    if (toolCallCount >= MAX_TOOL_CALLS) {
      console.warn(`[SterraCode] Tool-Call-Limit (${MAX_TOOL_CALLS}) erreicht. Loop abgebrochen.`);
      break;
    }

    const toolCalls          = response.choices[0].message.tool_calls ?? [];
    const toolResultMessages = [];

        for (const call of toolCalls) {
      toolCallCount++;
      let args = {};
      try { args = JSON.parse(call.function.arguments); } catch {}

      const result = await executeTool(call.function.name, args, context);
      toolResults.push({ tool: call.function.name, args, result });
      toolResultMessages.push({
        role:        'tool',
        tool_call_id: call.id,
        content:     JSON.stringify(result)
      });
    }

    const assistantToolMessage = response.choices[0].message;
    messagesForAPI.push(assistantToolMessage, ...toolResultMessages);
    session.messages.push(assistantToolMessage, ...toolResultMessages);
    await saveSession(sessionId, session);

    response = await callLMStudio({
      messages:    messagesForAPI,
      tools:       TOOL_DEFINITIONS,
      model:       settings.activeModel,
      lmStudioUrl: settings.lmStudioUrl,
      temperature: settings.temperature,
      maxTokens:   settings.maxTokensResponse
    });
  }

  const assistantMessage = response.choices?.[0]?.message?.content ?? '';
  session.messages.push({ role: 'assistant', content: assistantMessage });
  await saveSession(sessionId, session);

  return {
    message:     assistantMessage,
    toolResults,
    tokenCount:  estimateTokens(session.messages)
  };
}

// ─── Streaming Teacher (tool-calls non-streaming, final text streaming) ───

/**
 * Like runTeacher but streams the final text response.
 * Returns { toolResults, streamResponse } where streamResponse is the raw fetch response.
 * The route handler reads the stream and forwards SSE tokens to the client.
 */
export async function runTeacherStream({ sessionId, userMessage, includeEditor = false, editorCode = '', language = 'python', onToolCall }) {
  const settings = await getSettings();
  const session  = await loadSession(sessionId);

  const messageContent = (includeEditor && editorCode)
    ? `${userMessage}\n\n[CODE]\n\`\`\`${language}\n${editorCode}\n\`\`\``
    : userMessage;

  session.messages.push({ role: 'user', content: messageContent });

  if (shouldSummarize(session.messages, settings.tokenThreshold)) {
    await summarizeSession(session, settings);
  }

  const systemPrompt   = await buildSystemPrompt(settings, language);
  const messagesForAPI = [{ role: 'system', content: systemPrompt }, ...session.messages];
  const toolResults    = [];
  const context        = { sessionId, editorCode, language, session, settings };

  let response      = await callLMStudio({
    messages:    messagesForAPI,
    tools:       TOOL_DEFINITIONS,
    model:       settings.activeModel,
    lmStudioUrl: settings.lmStudioUrl,
    temperature: settings.temperature,
    maxTokens:   settings.maxTokensResponse
  });

  let toolCallCount = 0;
  const MAX_TOOL_CALLS = settings.maxToolCallsPerTurn ?? 10;

  while (response.choices?.[0]?.finish_reason === 'tool_calls') {
    if (toolCallCount >= MAX_TOOL_CALLS) {
      console.warn(`[SterraCode] Tool-Call-Limit (${MAX_TOOL_CALLS}) erreicht.`);
      break;
    }

    const toolCalls          = response.choices[0].message.tool_calls ?? [];
    const toolResultMessages = [];

        for (const call of toolCalls) {
      toolCallCount++;
      if (onToolCall) onToolCall(call.function.name);

      let args = {};
      try { args = JSON.parse(call.function.arguments); } catch {}

      const result = await executeTool(call.function.name, args, context);
      toolResults.push({ tool: call.function.name, args, result });
      toolResultMessages.push({
        role:        'tool',
        tool_call_id: call.id,
        content:     JSON.stringify(result)
      });
    }

    const assistantToolMessage = response.choices[0].message;
    messagesForAPI.push(assistantToolMessage, ...toolResultMessages);
    session.messages.push(assistantToolMessage, ...toolResultMessages);
    await saveSession(sessionId, session);

    response = await callLMStudio({
      messages:    messagesForAPI,
      tools:       TOOL_DEFINITIONS,
      model:       settings.activeModel,
      lmStudioUrl: settings.lmStudioUrl,
      temperature: settings.temperature,
      maxTokens:   settings.maxTokensResponse
    });
  }

  // Stream the final text response
  const streamResponse = await callLMStudio({
    messages:    messagesForAPI,
    tools:       [],
    model:       settings.activeModel,
    lmStudioUrl: settings.lmStudioUrl,
    temperature: settings.temperature,
    maxTokens:   settings.maxTokensResponse,
    stream:      true
  });

  return { toolResults, streamResponse, session, sessionId };
}

export async function appendAssistantMessage(session, sessionId, text) {
  session.messages.push({ role: 'assistant', content: text });
  await saveSession(sessionId, session);
  return estimateTokens(session.messages);
}
