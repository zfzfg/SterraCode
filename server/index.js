// server/index.js
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import chatRoutes    from './routes/chat.js';
import modelsRoutes  from './routes/models.js';
import executeRoutes from './routes/execute.js';
import terminalRoutes from './routes/terminal.js';
import sessionsRoutes from './routes/sessions.js';
import { ensureDataDirs } from './services/storage.js';

const app     = express();
const PORT    = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// Serve Monaco Editor from node_modules (no copy step needed)
app.use('/monaco', express.static(path.join(__dirname, '../node_modules/monaco-editor/min')));

// Ensure data directories and default settings exist
await ensureDataDirs();

// API routes
app.use('/api/chat',     chatRoutes);
app.use('/api/models',   modelsRoutes);
app.use('/api/execute',  executeRoutes);
app.use('/api/terminal', terminalRoutes);
app.use('/api/sessions', sessionsRoutes);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  🌌 SterraCode läuft auf → http://localhost:${PORT}\n`);
});
