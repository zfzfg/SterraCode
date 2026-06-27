// server/services/summarizer.js
import { callLMStudio } from './lmStudio.js';

/**
 * Character-based token estimation.
 * Rule of thumb: 1 token ≈ 4 characters — works reasonably for Llama, Mistral, Phi, Qwen.
 * More accurate than word-count heuristics, no external dependency needed.
 */
export function estimateTokens(messages) {
  const totalChars = messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    return sum + content.length;
  }, 0);
  return Math.ceil(totalChars / 4);
}

export function shouldSummarize(messages, threshold) {
  return estimateTokens(messages) >= threshold;
}

/**
 * Compresses the conversation history:
 * - Last N messages stay verbatim (continuity)
 * - Older messages are summarized via LLM call
 * - Summary is stored as a system message at the start
 */
export async function summarizeSession(session, settings) {
  const KEEP_RECENT = settings.keepRecentMessages ?? 6;
  const messages    = session.messages;

  if (messages.length <= KEEP_RECENT) return session;

  const toSummarize = messages.slice(0, messages.length - KEEP_RECENT);
  const keepFull    = messages.slice(messages.length - KEEP_RECENT);

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

  let summaryText = '';
  try {
    const response = await callLMStudio({
      messages: [{ role: 'user', content: summaryPrompt }],
      tools: [],
      model: settings.activeModel,
      lmStudioUrl: settings.lmStudioUrl,
      temperature: 0.3,
      maxTokens: 1024
    });
    summaryText = response.choices[0].message.content;
  } catch (err) {
    console.warn('[SterraCode] Zusammenfassung fehlgeschlagen:', err.message);
    // Fallback: just remove old messages without summarizing
    summaryText = `[${toSummarize.length} ältere Nachrichten wurden entfernt um Kontext-Platz zu sparen.]`;
  }

  session.messages = [
    { role: 'system', content: `[KONTEXT-ZUSAMMENFASSUNG]\n${summaryText}` },
    ...keepFull
  ];

  if (!session.summaries) session.summaries = [];
  session.summaries.push({
    createdAt:          new Date().toISOString(),
    text:               summaryText,
    messagesCompressed: toSummarize.length
  });

  return session;
}
