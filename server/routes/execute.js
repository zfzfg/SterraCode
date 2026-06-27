// server/routes/execute.js
import express from 'express';
import rateLimit from 'express-rate-limit';
import { executeCode } from '../services/executor.js';
import { getSettings } from '../services/storage.js';

const router = express.Router();

// Rate-limit: max 30 code executions per minute per IP
const execLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Code-Ausführungen. Bitte warte kurz.' }
});

// POST /api/execute
router.post('/', execLimiter, async (req, res) => {
  const { code, language } = req.body;
  if (!code || !language) {
    return res.status(400).json({ error: 'code und language sind erforderlich.' });
  }

  const settings = await getSettings();

  if (settings.allowedLanguages && !settings.allowedLanguages.includes(language)) {
    return res.status(400).json({ error: `Sprache '${language}' ist nicht erlaubt.` });
  }

  try {
    const result = await executeCode({ code, language, timeoutMs: settings.executionTimeout ?? 0 });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
