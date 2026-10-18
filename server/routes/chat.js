// server/routes/chat.js
import express from 'express';
import { runTeacher, runTeacherStream, appendAssistantMessage, editUserMessage, deleteLastUserMessage } from '../services/teacher.js';
import { getSettings, updateSettings } from '../services/storage.js';

const router = express.Router();

// POST /api/chat/edit — edit a message and re-run
router.post('/edit', async (req, res) => {
  const { sessionId, messageIndex, newContent, includeEditor = false, editorCode = '', language = 'python' } = req.body;
  if (!sessionId || messageIndex === undefined || !newContent) {
    return res.status(400).json({ error: 'Fehlende Parameter' });
  }
  try {
    await editUserMessage({ sessionId, messageIndex, newContent });
    
    // Wir rufen runTeacher(Stream) nicht direkt hier auf, sondern lassen den Client /api/chat/stream aufrufen
    // mit skipPushUserMessage=true, damit das Streaming normal über SSE läuft.
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/chat/last — delete last message
router.delete('/last', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId fehlt' });
  try {
    const result = await deleteLastUserMessage({ sessionId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat — standard (non-streaming) chat
router.post('/', async (req, res) => {
  const { sessionId, userMessage, includeEditor = false, editorCode = '', language = 'python', skipPushUserMessage = false } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId ist erforderlich.' });
  }

  try {
    const result = await runTeacher({ sessionId, userMessage, includeEditor, editorCode, language, skipPushUserMessage });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat/stream — SSE streaming chat
router.post('/stream', async (req, res) => {
  const { sessionId, userMessage, includeEditor = false, editorCode = '', language = 'python', skipPushUserMessage = false } = req.body;
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId ist erforderlich.' });
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  // Cleanup if client disconnects
  res.on('close', () => {
    if (!res.writableEnded) res.end();
  });

  try {
    const { toolResults, streamResponse, session, sessionId: sid } = await runTeacherStream({
      sessionId,
      userMessage,
      includeEditor,
      editorCode,
      language,
      onToolCall: (toolName) => send('tool', { tool: toolName })
    });

    // Stream the final text token by token
    let fullText = '';
    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const delta  = parsed?.choices?.[0]?.delta?.content;
            const reasoning = parsed?.choices?.[0]?.delta?.reasoning_content;
            if (delta) {
              fullText += delta;
              send('token', { token: delta });
            }
            if (reasoning) {
              send('reasoning', { token: reasoning });
            }
          } catch (pe) {
            console.error('[SSE Stream] JSON parse error inside line loop:', pe);
          }
        }
      }
    }

    const finalSavedText = fullText.trim() || 'Entschuldigung, ich konnte keine Antwort vom Modell empfangen. Bitte stelle deine Frage noch einmal.';
    const tokenCount = await appendAssistantMessage(session, sid, finalSavedText);
    send('done', { toolResults, tokenCount, fullText: finalSavedText });
    res.end();

  } catch (err) {
    console.error('[SSE ERROR Router Chat/Stream]:', err);
    send('error', { message: err.message });
    res.end();
  }
});

// POST /api/chat/feedback — thumbs up/down for a teacher response
router.post('/feedback', async (req, res) => {
  const { sessionId, messageIndex, value } = req.body;
  // Feedback is logged but doesn't mutate session structure in v1
  console.log(`[Feedback] session=${sessionId} msg=${messageIndex} value=${value}`);
  res.json({ ok: true });
});

// GET /api/chat/settings — get current settings
router.get('/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/chat/settings — update settings
router.patch('/settings', async (req, res) => {
  try {
    const updated = await updateSettings(req.body);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
