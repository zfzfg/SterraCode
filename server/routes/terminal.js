import express from 'express';
import { getSettings } from '../services/storage.js';
import { readTerminalSession, sendTerminalInput, startCodeSession, startTerminalSession, stopTerminalSession } from '../services/terminal.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const { command, sessionId, input, code, language } = req.body;

  if (sessionId) {
    try {
      const result = sendTerminalInput({ sessionId, input: input ? `${input}\n` : '\n' });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
    return;
  }

  if (code && language) {
    try {
      const settings = await getSettings();
      const result = await startCodeSession({ code, language, timeoutMs: settings.executionTimeout ?? 10000 });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (!command) {
    return res.status(400).json({ error: 'command ist erforderlich.' });
  }

  try {
    const result = startTerminalSession({ command });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:sessionId/output', (req, res) => {
  try {
    const result = readTerminalSession(req.params.sessionId);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.delete('/:sessionId', (req, res) => {
  const result = stopTerminalSession(req.params.sessionId);
  res.json(result);
});

export default router;
