// server/routes/models.js
import express from 'express';
import { getSettings } from '../services/storage.js';

const router = express.Router();

// GET /api/models — Query all available models from LM Studio
router.get('/', async (req, res) => {
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return res.json({ models: [], connected: false, error: 'Einstellungen konnten nicht geladen werden.' });
  }

  try {
    const response = await fetch(`${settings.lmStudioUrl}/v1/models`, {
      headers: { 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw new Error(`LM Studio antwortet nicht (${response.status})`);
    const data = await response.json();
    const models = (data.data ?? []).map(m => ({ id: m.id, name: m.id }));
    res.json({ models, connected: true });
  } catch (err) {
    res.json({ models: [], connected: false, error: err.message });
  }
});

export default router;
