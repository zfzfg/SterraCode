// server/routes/sessions.js
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { readJSON, writeJSON, listFiles, DATA_DIR } from '../services/storage.js';

const router = express.Router();
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

// GET /api/sessions — list all sessions (id, title, language, updatedAt)
router.get('/', async (req, res) => {
  try {
    const files = await listFiles(SESSIONS_DIR, '.json');
    const sessions = await Promise.all(
      files.map(f => readJSON(f).then(s => ({
        id:        s.id,
        title:     s.title,
        language:  s.language,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt
      })).catch(() => null))
    );
    const valid = sessions.filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(valid);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions — create new session
router.post('/', async (req, res) => {
  const { title, language } = req.body;
  const now = new Date().toISOString();
  const session = {
    id:             uuid(),
    title:          title || 'Neue Session',
    language:       language || 'python',
    createdAt:      now,
    updatedAt:      now,
    messages:       [],
    summaries:      [],
    currentTask:    null,
    editorSnapshot: ''
  };
  await writeJSON(path.join(SESSIONS_DIR, `${session.id}.json`), session);
  res.json(session);
});

// GET /api/sessions/:id — load a single session
router.get('/:id', async (req, res) => {
  try {
    const session = await readJSON(path.join(SESSIONS_DIR, `${req.params.id}.json`));
    res.json(session);
  } catch {
    res.status(404).json({ error: 'Session nicht gefunden.' });
  }
});

// PATCH /api/sessions/:id — partial update (title, editorSnapshot, language)
router.patch('/:id', async (req, res) => {
  try {
    const filePath = path.join(SESSIONS_DIR, `${req.params.id}.json`);
    const session  = await readJSON(filePath);
    const allowed  = ['title', 'editorSnapshot', 'language'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) session[key] = req.body[key];
    }
    session.updatedAt = new Date().toISOString();
    await writeJSON(filePath, session);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Session nicht gefunden.' });
  }
});

// DELETE /api/sessions/:id
router.delete('/:id', async (req, res) => {
  try {
    await fs.unlink(path.join(SESSIONS_DIR, `${req.params.id}.json`));
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Session nicht gefunden.' });
  }
});

export default router;
