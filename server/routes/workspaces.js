import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR, readJSON, getSessionTitle, getWorkspacePath } from '../services/storage.js';

const router = express.Router();
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');

// Rekursive Funktion zum Einlesen eines Verzeichnisses
async function readDirRecursive(dirPath, basePath = '') {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const relativePath = path.join(basePath, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      result.push({
        type: 'folder',
        name: entry.name,
        path: relativePath,
        children: await readDirRecursive(path.join(dirPath, entry.name), relativePath)
      });
    } else {
      result.push({
        type: 'file',
        name: entry.name,
        path: relativePath
      });
    }
  }
  // Sortiere Ordner nach oben, dann alphabetisch
  return result.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'folder' ? -1 : 1;
  });
}

// GET /api/workspaces/:sessionId/files — Liste alle Dateien im Workspace
router.get('/:sessionId/files', async (req, res) => {
  try {
    const wp = await getWorkspacePath(req.params.sessionId);
    const files = await readDirRecursive(wp);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workspaces/:sessionId/files/content?path=... — Lese Dateiinhalt
router.get('/:sessionId/files/content', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    const wp = await getWorkspacePath(req.params.sessionId);
    const fullPath = path.join(wp, filePath);
    // Security check: must be inside workspace
    if (!fullPath.startsWith(wp)) return res.status(403).json({ error: 'Access denied' });
    const content = await fs.readFile(fullPath, 'utf-8');
    res.json({ content });
  } catch (err) {
    res.status(404).json({ error: 'Datei nicht gefunden.' });
  }
});

// POST /api/workspaces/:sessionId/files — Datei oder Ordner erstellen
router.post('/:sessionId/files', async (req, res) => {
  try {
    const { path: reqPath, type, content = '' } = req.body;
    const wp = await getWorkspacePath(req.params.sessionId);
    const fullPath = path.join(wp, reqPath);
    if (!fullPath.startsWith(wp)) return res.status(403).json({ error: 'Access denied' });
    
    if (type === 'folder') {
      await fs.mkdir(fullPath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/workspaces/:sessionId/files/content — Datei aktualisieren
router.put('/:sessionId/files/content', async (req, res) => {
  try {
    const { path: reqPath, content } = req.body;
    const wp = await getWorkspacePath(req.params.sessionId);
    const fullPath = path.join(wp, reqPath);
    if (!fullPath.startsWith(wp)) return res.status(403).json({ error: 'Access denied' });
    await fs.writeFile(fullPath, content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/workspaces/:sessionId/files — Datei/Ordner umbenennen oder verschieben
router.patch('/:sessionId/files', async (req, res) => {
  try {
    const { oldPath, newPath } = req.body;
    const wp = await getWorkspacePath(req.params.sessionId);
    const fullOld = path.join(wp, oldPath);
    const fullNew = path.join(wp, newPath);
    if (!fullOld.startsWith(wp) || !fullNew.startsWith(wp)) return res.status(403).json({ error: 'Access denied' });
    
    await fs.rename(fullOld, fullNew);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/workspaces/:sessionId/files — Datei/Ordner löschen
router.delete('/:sessionId/files', async (req, res) => {
  try {
    const reqPath = req.query.path;
    const wp = await getWorkspacePath(req.params.sessionId);
    const fullPath = path.join(wp, reqPath);
    if (!fullPath.startsWith(wp)) return res.status(403).json({ error: 'Access denied' });
    
    await fs.rm(fullPath, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;