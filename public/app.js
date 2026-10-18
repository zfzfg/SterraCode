// public/app.js
// ═══════════════════════════════════════════════════════════════════════════
//  SterraCode — Frontend Application
// ═══════════════════════════════════════════════════════════════════════════

// ── State ──────────────────────────────────────────────────────────────────
let currentSessionId  = null;
let currentLanguage   = 'python';
let appSettings       = {};
let editorReady       = false;
let isSending         = false;

// Undo history for AI editor changes
const editorHistory   = [];   // { code, reason, timestamp }[]
const MAX_HISTORY     = 20;

// Diff modal state
let pendingDiffResolve = null;
let diffEditorInstance = null;

// ── Helpers ────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function showToast(message, type = 'info', duration = 3000) {
  const container = el('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

function md(text) {
  if (!text) return '';
  // Strip raw tool-call XML that some models output as plain text
  text = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`)
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Unordered lists (collect consecutive li then wrap)
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(\n<li>[\s\S]*?<\/li>)*/g, m => `<ul>${m}</ul>`)
    // Ordered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Headings
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm,  '<h3>$1</h3>')
    .replace(/^# (.+)$/gm,   '<h2>$1</h2>')
    // Line breaks and paragraphs
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^(?!<[hupol])(.*\S.*)$/, '<p>$1</p>');
}

function renderBubbleContent(thinking, content) {
  let html = '';
  if (thinking) {
    // If the thinking process has concluded, show it collapsed by default. Otherwise open.
    const isOpen = content ? '' : ' open';
    html += `<details class="thinking-details"${isOpen}>
      <summary>Denkprozess...</summary>
      <div class="thinking-content">${md(thinking)}</div>
    </details>`;
  }
  if (content) {
    html += md(content);
  }
  return html;
}

// ── Monaco Editor ──────────────────────────────────────────────────────────
require.config({ paths: { vs: '/monaco/vs' } });

require(['vs/editor/editor.main'], function () {
  window.monacoLoaded = true;
  window.editor = monaco.editor.create(el('editor-container'), {
    value:               '# Willkommen bei SterraCode!\n# Erstelle eine neue Session um zu beginnen.\n',
    language:            'python',
    theme:               'vs-dark',
    fontSize:            14,
    minimap:             { enabled: false },
    automaticLayout:     true,
    formatOnType:        false,
    formatOnPaste:       false,
    tabSize:             4,
    scrollBeyondLastLine: false,
    wordWrap:            'on'
  });

  editorReady = true;

  // Auto-save editor content to session (debounced, 1.5s after last keystroke)
  let editorSaveTimer = null;
  window.editor.onDidChangeModelContent(() => {
    if (!currentSessionId) return;
    clearTimeout(editorSaveTimer);
    editorSaveTimer = setTimeout(() => {
      fetch(`/api/sessions/${currentSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editorSnapshot: window.editor.getValue() })
      }).catch(() => {});
    }, 1500);
  });

  // Keyboard shortcuts
  editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
    () => runCode()
  );
  editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
    () => handleSendMessage(true)
  );
  editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK,
    () => triggerSummarize()
  );

  // Context menu action
  editor.addAction({
    id:                  'explain-selection',
    label:               '🤖 Teacher: Erkläre das',
    contextMenuGroupId:  'sterracode',
    contextMenuOrder:    1,
    run: (ed) => {
      const selection = ed.getModel().getValueInRange(ed.getSelection());
      if (selection.trim()) {
        handleSendMessageText(`Erkläre mir diesen Code:\n\`\`\`\n${selection}\n\`\`\``);
      }
    }
  });

  init();
});

// ── Files Sidebar ────────────────────────────────────────────────────────────
async function loadFilesList() {
  if (!currentSessionId) return;
  const container = el('files-list');
  try {
    const files = await fetch(`/api/workspaces/${currentSessionId}/files`).then(r => r.json());
    container.innerHTML = '';
    if (files.error) {
      container.innerHTML = `<div style="padding: 10px; color: var(--danger)">${files.error}</div>`;
      return;
    }
    renderFileTree(files, container, 0);
  } catch (err) {
    container.innerHTML = `<div style="padding: 10px; color: var(--danger)">Fehler beim Laden der Dateien</div>`;
  }
}

function renderFileTree(files, container, depth) {
  files.forEach(f => {
    const item = document.createElement('div');
    item.className = 'file-tree-item';
    item.style.paddingLeft = `${depth * 12 + 10}px`;
    
    const icon = f.type === 'folder' ? '📁' : '📄';
    item.innerHTML = `
      <span class="file-tree-icon">${icon}</span>
      <span class="file-tree-name" title="${f.path}">${f.name}</span>
      <div class="file-tree-actions">
        <button class="icon-btn" onclick="renameFileOrFolder('${f.path}')" title="Umbenennen">✏️</button>
        <button class="icon-btn" onclick="deleteFileOrFolder('${f.path}')" title="Löschen">🗑</button>
      </div>
    `;

    if (f.type === 'file') {
      item.onclick = (e) => {
        if (e.target.tagName !== 'BUTTON') {
          openFileInEditor(f.path);
        }
      };
      if (window.currentFilePath === f.path) {
        item.classList.add('active');
      }
    }

    container.appendChild(item);

    if (f.type === 'folder' && f.children) {
      renderFileTree(f.children, container, depth + 1);
    }
  });
}

window.currentFilePath = null;

async function openFileInEditor(filePath) {
  if (!currentSessionId) return;
  try {
    const res = await fetch(`/api/workspaces/${currentSessionId}/files/content?path=${encodeURIComponent(filePath)}`).then(r => r.json());
    if (res.error) throw new Error(res.error);
    window.currentFilePath = filePath;
    if (window.editor) {
      window.editor.setValue(res.content || '');
      // Try to guess language
      const ext = filePath.split('.').pop().toLowerCase();
      const langMap = { 'js': 'javascript', 'ts': 'typescript', 'py': 'python', 'java': 'java', 'html': 'html', 'css': 'css', 'json': 'json', 'md': 'markdown' };
      if (langMap[ext]) {
        monaco.editor.setModelLanguage(window.editor.getModel(), langMap[ext]);
      }
    }
    loadFilesList(); // Update active state
  } catch (err) {
    showToast(`Fehler beim Öffnen: ${err.message}`, 'error');
  }
}

async function promptCreateFileOrFolder(type) {
  if (!currentSessionId) {
    showToast('Bitte erst eine Session auswählen.', 'error');
    return;
  }
  const name = prompt(`Neuer ${type === 'folder' ? 'Ordner' : 'Datei'} (Pfad):`);
  if (!name) return;
  try {
    const res = await fetch(`/api/workspaces/${currentSessionId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: name, type })
    }).then(r => r.json());
    if (res.error) throw new Error(res.error);
    loadFilesList();
    if (type === 'file') openFileInEditor(name);
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
}

window.renameFileOrFolder = async function(oldPath) {
  if (!currentSessionId) return;
  const newName = prompt(`Umbenennen von "${oldPath}":`, oldPath);
  if (!newName || newName === oldPath) return;
  try {
    const res = await fetch(`/api/workspaces/${currentSessionId}/files`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath, newPath: newName })
    }).then(r => r.json());
    if (res.error) throw new Error(res.error);
    if (window.currentFilePath === oldPath) {
      window.currentFilePath = newName;
    }
    loadFilesList();
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
};

window.deleteFileOrFolder = async function(filePath) {
  if (!currentSessionId) return;
  if (!confirm(`Möchtest du "${filePath}" wirklich löschen?`)) return;
  try {
    const res = await fetch(`/api/workspaces/${currentSessionId}/files?path=${encodeURIComponent(filePath)}`, {
      method: 'DELETE'
    }).then(r => r.json());
    if (res.error) throw new Error(res.error);
    if (window.currentFilePath === filePath) {
      window.currentFilePath = null;
      if (window.editor) window.editor.setValue('');
    }
    loadFilesList();
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
};

// ── Learning Plan ──────────────────────────────────────────────────────────
function showLearningPlan(plan) {
  if (!plan) return;
  el('plan-goal').textContent = plan.goal || 'Lernziel';
  const container = el('plan-topics');
  container.innerHTML = '';
  if (plan.topics && plan.topics.length) {
    plan.topics.forEach(topic => {
      const div = document.createElement('div');
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.gap = '8px';
      
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = topic.done;
      cb.disabled = true; // KI verwaltet das Abhaken
      
      const span = document.createElement('span');
      span.textContent = topic.title;
      if (topic.done) span.style.textDecoration = 'line-through';
      
      div.appendChild(cb);
      div.appendChild(span);
      container.appendChild(div);
    });
  } else {
    container.innerHTML = '<span style="color: var(--text-muted); font-size: 12px;">Noch keine Themen definiert.</span>';
  }
  
  // Flash tab to indicate update
  const tab = el('tab-plan');
  tab.style.transition = 'color 0.3s';
  tab.style.color = 'var(--success)';
  setTimeout(() => tab.style.color = '', 1500);
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  await loadSettings();
  applyTheme(appSettings.theme || 'dark');
  applyFontSize(appSettings.fontSize || 14);
  applyLayoutSizes(appSettings);
  await loadModels();
  await loadSessionsList();
  bindEvents();
}

// ── Settings ────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const res = await fetch('/api/chat/settings');
    appSettings = await res.json();
  } catch {
    appSettings = {};
  }
}

function applyLayoutSizes(settings) {
  if (settings.sidebarWidth) {
    document.documentElement.style.setProperty('--sidebar-w', settings.sidebarWidth);
  }
  if (settings.editorWidth) {
    document.documentElement.style.setProperty('--editor-w', settings.editorWidth);
  }
  if (settings.terminalHeight) {
    document.documentElement.style.setProperty('--terminal-h', settings.terminalHeight);
    const terminalPanel = el('terminal-panel');
    if (terminalPanel) terminalPanel.style.height = settings.terminalHeight;
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (window.monaco && window.editor) {
    let monacoTheme = 'vs-dark';
    if (theme === 'light') monacoTheme = 'vs';
    else if (theme === 'high-contrast') monacoTheme = 'hc-black';
    monaco.editor.setTheme(monacoTheme);
  }
}

function applyFontSize(size) {
  if (window.editor) window.editor.updateOptions({ fontSize: size });
}

async function saveSettings(fromModal = true) {
  const s = appSettings;
  let updates = {};
  
  if (fromModal) {
    updates = {
      lmStudioUrl:            el('s-lmUrl').value,
      activeModel:            el('s-model').value || s.activeModel,
      temperature:            parseFloat(el('s-temp').value),
      maxTokensResponse:      parseInt(el('s-maxTokens').value),
      fontSize:               parseInt(el('s-fontSize').value),
      diffAutoApplyThreshold: parseInt(el('s-diffThreshold').value),
      autoSendEditorOnMessage: el('s-autoSend').checked,
      tokenThreshold:         parseInt(el('s-tokenThreshold').value),
      keepRecentMessages:     parseInt(el('s-keepRecent').value),
      maxToolCallsPerTurn:    parseInt(el('s-maxTools').value),
      crossChatProfileEnabled:     el('s-crossChat').checked,
      autoUpdateProfileOnTaskDone: el('s-autoProfile').checked,
      executionTimeout:       parseInt(el('s-timeout').value),
      streaming:              el('s-streaming').checked,
      systemPrompt:           el('s-systemPrompt').value,
      theme:                  el('s-theme').value || 'dark'
    };
  } else {
    // Only update the layout sizes
    updates = {
      sidebarWidth: appSettings.sidebarWidth,
      editorWidth: appSettings.editorWidth,
      terminalHeight: appSettings.terminalHeight
    };
  }

  try {
    const res = await fetch('/api/chat/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    appSettings = await res.json();
    applyTheme(appSettings.theme);
    applyFontSize(appSettings.fontSize);
    if (fromModal) {
      closeSettings();
      showToast('Einstellungen gespeichert.', 'success');
    }
  } catch {
    if (fromModal) showToast('Fehler beim Speichern.', 'error');
  }
}

function openSettings() {
  const s = appSettings;
  el('s-lmUrl').value         = s.lmStudioUrl || 'http://localhost:1234';
  el('s-model').value         = s.activeModel || '';
  el('s-temp').value          = s.temperature ?? 0.4;
  el('s-temp-val').textContent = s.temperature ?? 0.4;
  el('s-maxTokens').value     = s.maxTokensResponse || 2048;
  el('s-theme').value         = s.theme || 'dark';
  el('s-fontSize').value      = s.fontSize || 14;
  el('s-diffThreshold').value = s.diffAutoApplyThreshold ?? 5;
  el('s-autoSend').checked    = s.autoSendEditorOnMessage || false;
  el('s-tokenThreshold').value = s.tokenThreshold || 8000;
  el('s-token-val').textContent = s.tokenThreshold || 8000;
  el('s-keepRecent').value    = s.keepRecentMessages || 6;
  el('s-maxTools').value      = s.maxToolCallsPerTurn || 10;
  el('s-crossChat').checked   = s.crossChatProfileEnabled || false;
  el('s-autoProfile').checked = s.autoUpdateProfileOnTaskDone !== false;
  el('s-timeout').value       = s.executionTimeout ?? 0;
  el('s-timeout-val').textContent = (s.executionTimeout ?? 0) === 0 ? 'kein Timeout' : (s.executionTimeout ?? 0);
  el('s-streaming').checked   = s.streaming !== false;
  el('s-systemPrompt').value  = s.systemPrompt || '';
  el('settings-modal').classList.remove('hidden');
}

function closeSettings() { el('settings-modal').classList.add('hidden'); }

// ── Models ──────────────────────────────────────────────────────────────────
async function loadModels() {
  try {
    const { models, connected, error } = await fetch('/api/models').then(r => r.json());
    const select = el('model-select');
    const badge  = el('connection-badge');

    if (!connected) {
      select.innerHTML = '<option disabled selected>LM Studio nicht erreichbar</option>';
      badge.className  = 'badge badge-disconnected';
      badge.textContent = '● Nicht verbunden';
      return;
    }

    badge.className   = 'badge badge-connected';
    badge.textContent = '● Verbunden';
    select.innerHTML  = '';

    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.id === appSettings.activeModel) opt.selected = true;
      select.appendChild(opt);
    });

    // Auto-select first model and save to settings if none active
    if (!appSettings.activeModel && models.length > 0) {
      appSettings.activeModel = models[0].id;
      await fetch('/api/chat/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeModel: models[0].id })
      });
    }
  } catch {
    // Silent fail — status badge already shows disconnected
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────
async function loadSessionsList() {
  try {
    const sessions = await fetch('/api/sessions').then(r => r.json());
    renderSessionsList(sessions);
  } catch {}
}

function renderSessionsList(sessions) {
  const list = el('sessions-list');
  list.innerHTML = '';

  if (!sessions.length) {
    list.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:12px;text-align:center">Noch keine Sessions.<br>Klicke + Neu um zu starten.</div>';
    return;
  }

  sessions.forEach(s => {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
    item.dataset.id = s.id;
    item.innerHTML = `
      <div class="session-item-info">
        <div class="session-item-title">${escHtml(s.title)}</div>
        <div class="session-item-lang">${s.language} · ${formatDate(s.updatedAt)}</div>
      </div>
      <button class="session-delete-btn" title="Session löschen">✕</button>`;
    item.querySelector('.session-item-info').onclick = () => openSession(s.id);
    item.querySelector('.session-delete-btn').onclick = (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    };
    list.appendChild(item);
  });
}

async function createSession() {
  const title = prompt('Name der neuen Session:', 'Neue Session');
  if (title === null) return;
  try {
    const session = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title || 'Neue Session', language: currentLanguage })
    }).then(r => r.json());

    await openSession(session.id);
    await loadSessionsList();
    
    // Trigger initial AI greeting & learning plan question
    setTimeout(() => {
      handleSendMessageText('[SYSTEM: Neue Session gestartet. Begrüße den Nutzer kurz und frage ihn, ob du einen Lernplan für ihn erstellen sollst (nutze das ask_question Tool mit type="multiple-choice" und Optionen wie "Ja, bitte" / "Nein, danke").]');
    }, 500);
  } catch {
    showToast('Fehler beim Erstellen der Session.', 'error');
  }
}

async function openSession(sessionId) {
  // Save current editor snapshot before switching
  if (currentSessionId && window.editor) {
    saveEditorSnapshot(currentSessionId).catch(() => {});
  }

  try {
    const session = await fetch(`/api/sessions/${sessionId}`).then(r => r.json());
    currentSessionId = session.id;
    currentLanguage  = session.language || 'python';

    // Update language dropdown
    el('language-select').value = currentLanguage;
    if (window.editor) {
      monaco.editor.setModelLanguage(window.editor.getModel(), currentLanguage);
    }

    // Restore editor snapshot
    if (window.editor && session.editorSnapshot) {
      window.editor.setValue(session.editorSnapshot);
    } else if (window.editor) {
      window.editor.setValue('');
    }

    // Render chat history
    renderChatHistory(session.messages || []);
    
    // Load Workspace Files
    loadFilesList();

    // Load Learning Plan
    if (session.learningPlan) {
      showLearningPlan(session.learningPlan);
    } else {
      el('plan-goal').textContent = 'Kein Lernziel gesetzt';
      el('plan-topics').innerHTML = '';
    }

    // Add regenerate button to the last AI message
    updateRegenerateButtons();

    // Restore current task
    if (session.currentTask && !session.currentTask.done) {
      showTask(session.currentTask);
    } else {
      el('task-panel').classList.add('hidden');
    }

    // Update sidebar active state
    document.querySelectorAll('.session-item').forEach(el => {
      el.classList.toggle('active', el.dataset.id === sessionId);
    });

    // Clear terminal
    el('terminal-output').textContent = '$ Session geladen.\n';

    // Update token counter
    updateTokenCounter(session.messages || []);

    // Update title
    document.title = `${session.title} — SterraCode`;

  } catch {
    showToast('Session konnte nicht geladen werden.', 'error');
  }
}

async function deleteSession(sessionId) {
  if (!confirm('Session wirklich löschen?')) return;
  try {
    await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    if (currentSessionId === sessionId) {
      currentSessionId = null;
      el('chat-messages').innerHTML = renderWelcome();
      el('task-panel').classList.add('hidden');
    }
    await loadSessionsList();
    showToast('Session gelöscht.', 'success');
  } catch {
    showToast('Fehler beim Löschen.', 'error');
  }
}

async function saveEditorSnapshot(sessionId) {
  if (!window.editor) return;
  await fetch(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editorSnapshot: window.editor.getValue() })
  });
}

function renderWelcome() {
  return `<div class="welcome-msg">
    <h2>🌌 SterraCode</h2>
    <p>Wähle eine Session aus der Seitenleiste<br>oder erstelle eine neue mit <strong>+ Neu</strong>.</p>
  </div>`;
}

// ── Chat ─────────────────────────────────────────────────────────────────────
function renderChatHistory(messages) {
  const container = el('chat-messages');
  container.innerHTML = '';
  if (!messages.length) {
    container.innerHTML = '<div class="chat-bubble system">Session gestartet. Was moechtest du heute lernen?</div>';
    return;
  }
  // Find the last user message to associate with the last AI reply for regeneration
  let lastUserMsg = '';
  messages.forEach((msg, i) => {
    if (msg.role === 'user') lastUserMsg = msg.content;
    if (msg.role === 'system') return;
    
    // Handle tool messages to render as UI components
    if (msg.role === 'tool') {
      try {
        const result = JSON.parse(msg.content);
        if (result && result.type) {
          const toolBubble = createToolBubble(result);
          if (toolBubble) container.appendChild(toolBubble);
        }
      } catch (e) {
        // ignore parse error, just don't render raw JSON
      }
      return;
    }
    
    // Hide raw assistant tool_calls
    if (msg.role === 'assistant' && msg.tool_calls && !msg.content) {
      return;
    }

    const bubble = createChatBubble(msg.role, msg.content, i);
    if (msg.role === 'assistant') {
      bubble.dataset.regenerable   = '1';
      bubble.dataset.lastUserMsg   = lastUserMsg;
      bubble.dataset.includeEditor = '0';
    } else if (msg.role === 'user') {
      bubble.dataset.index = i;
      addEditButton(bubble, i, msg.content);
      
      // If it's the last message (or we don't know yet, we can just add delete button to all user messages)
      // Actually, deleting ANY user message could truncate from there.
      // Let's just implement the "Letzte Nachricht löschen" as a button in the chat input area.
    }
    if (msg.edited) {
      const editedSpan = document.createElement('span');
      editedSpan.className = 'edited-mark';
      editedSpan.textContent = ' (bearbeitet)';
      bubble.appendChild(editedSpan);
    }
    container.appendChild(bubble);
  });
  scrollToBottom();
}

function createToolBubble(result) {
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble system tool-bubble';
  
  switch (result.type) {
    case 'create_task':
      bubble.innerHTML = `<strong>📋 Aufgabe:</strong> ${result.task?.title || 'Neue Aufgabe'}`;
      break;
    case 'write_editor':
      bubble.innerHTML = `<em>[Schreibe Datei: ${result.reason || 'Code-Änderung'}]</em>`;
      break;
    case 'insert_at_line':
      bubble.innerHTML = `<em>[Bearbeite Zeile ${result.line}: ${result.reason || 'Einfügen'}]</em>`;
      break;
    case 'mark_task_done':
      bubble.innerHTML = `<strong>✅ Aufgabe abgeschlossen!</strong>`;
      break;
    case 'add_explanation':
      bubble.innerHTML = `<strong>💡 ${result.title}</strong><br/>${md(result.content || '')}`;
      break;
    case 'read_file':
      bubble.innerHTML = `<em>[Lese Datei: ${result.path || 'unbekannt'}]</em>`;
      break;
    case 'write_file':
      bubble.innerHTML = `<em>[Schreibe Datei: ${result.path || 'unbekannt'}] <button class="btn btn-sm" onclick="undoFileChange('${result.path}', \`${btoa(result.oldContent || '')}\`)">↩ Rückgängig</button></em>`;
      break;
    case 'run_terminal_command':
      bubble.innerHTML = `<strong>🖥 Terminal:</strong> <code>${result.command}</code>`;
      break;
    case 'ask_question':
      bubble.innerHTML = `<strong>❓ Frage:</strong> ${result.question}`;
      if (result.questionType === 'multiple-choice' && result.options) {
        const btnContainer = document.createElement('div');
        btnContainer.className = 'mc-options';
        btnContainer.style.marginTop = '8px';
        btnContainer.style.display = 'flex';
        btnContainer.style.flexDirection = 'column';
        btnContainer.style.gap = '4px';
        result.options.forEach(opt => {
          const btn = document.createElement('button');
          btn.className = 'btn btn-sm';
          btn.textContent = opt;
          btn.onclick = () => {
            btnContainer.innerHTML = `<em>Gewählt: ${opt}</em>`;
            handleSendMessageText(opt);
          };
          btnContainer.appendChild(btn);
        });
        bubble.appendChild(btnContainer);
      } else {
        const btnContainer = document.createElement('div');
        btnContainer.style.marginTop = '8px';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = 'Deine Antwort...';
        inp.className = 'freitext-input';
        inp.style.width = '100%';
        inp.onkeydown = (e) => {
          if (e.key === 'Enter') {
            const val = inp.value.trim();
            if (val) {
              btnContainer.innerHTML = `<em>Antwort: ${val}</em>`;
              handleSendMessageText(val);
            }
          }
        };
        btnContainer.appendChild(inp);
        bubble.appendChild(btnContainer);
      }
      break;
    case 'update_learning_plan':
      bubble.innerHTML = `<strong>🎓 Lernplan aktualisiert:</strong> ${result.goal}`;
      showLearningPlan(result);
      break;
    default:
      return null; // Do not render unknown tools
  }
  return bubble;
}

function addEditButton(bubble, index, content) {
  const btn = document.createElement('button');
  btn.className = 'icon-btn edit-msg-btn';
  btn.title = 'Nachricht bearbeiten';
  btn.textContent = '✏️';
  btn.style.position = 'absolute';
  btn.style.right = '5px';
  btn.style.top = '5px';
  btn.style.opacity = '0';
  btn.style.fontSize = '12px';
  
  bubble.addEventListener('mouseenter', () => btn.style.opacity = '1');
  bubble.addEventListener('mouseleave', () => btn.style.opacity = '0');
  
  btn.onclick = () => {
    const newContent = prompt('Nachricht bearbeiten:', content);
    if (newContent && newContent !== content) {
      editUserMessage(index, newContent);
    }
  };
  bubble.appendChild(btn);
}

async function editUserMessage(index, newContent) {
  if (!currentSessionId) return;
  try {
    const res = await fetch('/api/chat/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId, messageIndex: index, newContent })
    }).then(r => r.json());
    
    if (res.error) throw new Error(res.error);
    
    // Reload session locally
    const session = await fetch(`/api/sessions/${currentSessionId}`).then(r => r.json());
    renderChatHistory(session.messages || []);
    
    // Trigger new response
    const useStreaming = appSettings.streaming !== false;
    const editorCode = window.editor ? window.editor.getValue() : '';
    if (useStreaming) {
      await sendStreaming('', false, editorCode, true);
    } else {
      await sendNonStreaming('', false, editorCode, true);
    }
  } catch (err) {
    showToast(`Fehler beim Bearbeiten: ${err.message}`, 'error');
  }
}

async function deleteLastMessage() {
  if (!currentSessionId) return;
  if (!confirm('Letzte Nachricht und KI-Antwort löschen?')) return;
  try {
    const res = await fetch('/api/chat/last', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId })
    }).then(r => r.json());
    
    if (res.error) throw new Error(res.error);
    
    // Check if there are file changes in deleted messages
    const hasWriteTool = res.deletedMessages?.some(m => m.role === 'tool' && m.content && m.content.includes('"write_file"'));
    if (hasWriteTool) {
      if (confirm('Die gelöschte Antwort enthielt Datei-Änderungen. Möchtest du die letzte Datei-Änderung ebenfalls rückgängig machen? (Falls noch möglich)')) {
        // Find last write_file tool
        const writeMsg = res.deletedMessages.slice().reverse().find(m => m.role === 'tool' && m.content.includes('"write_file"'));
        if (writeMsg) {
          const t = JSON.parse(writeMsg.content);
          if (t && t.path) {
            undoFileChange(t.path, btoa(t.oldContent || ''));
          }
        }
      }
    }

    const session = await fetch(`/api/sessions/${currentSessionId}`).then(r => r.json());
    renderChatHistory(session.messages || []);
  } catch (err) {
    showToast(`Fehler beim Löschen: ${err.message}`, 'error');
  }
}

function createChatBubble(role, content, index) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  if (role === 'assistant') {
    bubble.innerHTML = md(content || '');
    if (index !== undefined) {
      bubble.appendChild(createFeedbackBar(index));
    }
  } else {
    bubble.textContent = content || '';
  }
  return bubble;
}

function createFeedbackBar(messageIndex) {
  const bar = document.createElement('div');
  bar.className = 'feedback-bar';
  bar.innerHTML = `<button class="thumb" data-val="1">👍</button>
                   <button class="thumb" data-val="-1">👎</button>`;
  bar.querySelectorAll('.thumb').forEach(btn => {
    btn.onclick = async () => {
      bar.innerHTML = '<span class="feedback-sent">Danke!</span>';
      const value = Number(btn.dataset.val);
      await fetch('/api/chat/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentSessionId, messageIndex, value })
      });
      if (value === -1) {
        handleSendMessageText('[SYSTEM: Letzte Erklärung war unklar. Bitte nochmal anders erklären — kürzer oder mit einem anderen Beispiel.]');
      }
    };
  });
  return bar;
}

async function handleSendMessage(includeEditor = false) {
  const input = el('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await handleSendMessageText(text, { includeEditor });
}

async function handleSendMessageText(text, { includeEditor = false } = {}) {
  if (!currentSessionId) {
    showToast('Bitte zuerst eine Session auswählen oder erstellen.', 'error');
    return;
  }
  if (isSending) return;
  isSending = true;
  el('send-btn').disabled = true;

  // Add user bubble
  const userBubble = createChatBubble('user', text);
  el('chat-messages').appendChild(userBubble);
  scrollToBottom();

  const useStreaming = appSettings.streaming !== false;
  const editorCode  = (includeEditor || appSettings.autoSendEditorOnMessage) && window.editor
    ? window.editor.getValue()
    : '';
  
  const currentFile = window.currentFilePath ? `\nAktuelle Datei im Editor: ${window.currentFilePath}` : '';

  try {
    if (useStreaming) {
      await sendStreaming(text + currentFile, includeEditor, editorCode);
    } else {
      await sendNonStreaming(text + currentFile, includeEditor, editorCode);
    }
  } finally {
    isSending = false;
    el('send-btn').disabled = false;
    scrollToBottom();
  }
}

async function sendStreaming(userMessage, includeEditor, editorCode, skipPushUserMessage = false) {
  const container  = el('chat-messages');
  const bubble     = createChatBubble('assistant', '');
  const cursor     = document.createElement('span');
  cursor.className = 'cursor';
  bubble.appendChild(cursor);
  container.appendChild(bubble);
  scrollToBottom();

  showToolIndicator(null);

  let fullText     = '';
  let thinkingText = '';
  let gotDoneEvent = false;

  const cleanup = () => {
    cursor.remove();
    hideToolIndicator();
  };

  try {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: currentSessionId,
        userMessage,
        includeEditor,
        editorCode,
        language: currentLanguage,
        skipPushUserMessage
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(err.error);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';

    const processSseBuffer = () => {
      if (!buffer) return;

      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const lines = part.split(/\r?\n/);
        let eventName = '';
        let dataText = '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataText = line.slice(5).trim();
          }
        }

        if (!dataText) continue;

        try {
          const data = JSON.parse(dataText);
          if (eventName === 'token') {
            fullText += data.token;
            bubble.innerHTML = renderBubbleContent(thinkingText, fullText);
            bubble.appendChild(cursor);
            scrollToBottom();
          } else if (eventName === 'reasoning') {
            thinkingText += data.token;
            bubble.innerHTML = renderBubbleContent(thinkingText, fullText);
            bubble.appendChild(cursor);
            scrollToBottom();
          } else if (eventName === 'tool') {
            showToolIndicator(data.tool);
          } else if (eventName === 'done') {
            gotDoneEvent = true;
            hideToolIndicator();
            if (data.toolResults) processToolResults(data.toolResults);
            if (data.tokenCount) updateTokenCounterRaw(data.tokenCount);

            const finalText = data.fullText !== undefined ? data.fullText : fullText;
            const rendered = renderBubbleContent(thinkingText, finalText);
            if (rendered) {
              bubble.innerHTML = rendered;
            } else {
              bubble.classList.add('system');
              bubble.innerHTML = '<em>Das Modell hat keine Antwort geliefert. Bitte erneut versuchen.</em>';
            }
            cursor.remove();
            bubble.appendChild(createFeedbackBar(container.querySelectorAll('.chat-bubble.assistant').length - 1));
            addRegenerateButton(bubble, userMessage, includeEditor);
            updateRegenerateButtons();
            scrollToBottom();
          } else if (eventName === 'error') {
            throw new Error(data.message);
          }
        } catch (parseErr) {
          if (parseErr.message !== 'Unexpected end of JSON input') throw parseErr;
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        processSseBuffer();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      processSseBuffer();
    }

    // Stream ended without 'done' event (model likely crashed or connection dropped)
    if (!gotDoneEvent) {
      const rendered = renderBubbleContent(thinkingText, fullText);
      cursor.remove();
      if (rendered) {
        bubble.innerHTML = rendered;
      } else {
        bubble.classList.add('system');
        bubble.innerHTML = '<em>Verbindung zum Modell unterbrochen. Bitte erneut versuchen.</em>';
      }
      bubble.appendChild(createFeedbackBar(container.querySelectorAll('.chat-bubble.assistant').length - 1));
      addRegenerateButton(bubble, userMessage, includeEditor);
      updateRegenerateButtons();
    }

  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'Zeitlimit ueberschritten (2 Min). Das Modell antwortet nicht.'
      : err.message;
    cursor.remove();
    bubble.classList.add('system');
    bubble.innerHTML = `<em>Fehler: ${escHtml(msg)}</em>`;
    addRegenerateButton(bubble, userMessage, includeEditor);
    updateRegenerateButtons();
    showToast(msg, 'error');
  } finally {
    cleanup();
    scrollToBottom();
  }

  await loadSessionsList();
}

function addRetryButton(bubble, userMessage, includeEditor) {
  const btn = document.createElement('button');
  btn.className   = 'btn btn-sm';
  btn.style.marginTop = '8px';
  btn.textContent = '↺ Nochmal versuchen';
  btn.onclick = () => {
    bubble.remove();
    handleSendMessageText(userMessage, { includeEditor });
  };
  bubble.appendChild(document.createElement('br'));
  bubble.appendChild(btn);
}

/** Marks a bubble as regenerable and stores the user message that triggered it */
function addRegenerateButton(bubble, lastUserMsg, includeEditor) {
  bubble.dataset.lastUserMsg   = lastUserMsg  || '';
  bubble.dataset.includeEditor = includeEditor ? '1' : '0';
  bubble.dataset.regenerable   = '1';
  updateRegenerateButtons();
}

/** Shows the ↺ Regenerate button ONLY on the last assistant bubble */
function updateRegenerateButtons() {
  const allRegen = Array.from(
    document.querySelectorAll('#chat-messages .chat-bubble[data-regenerable]')
  );
  allRegen.forEach((b, i) => {
    b.querySelectorAll('.regen-btn').forEach(btn => btn.remove());
    if (i === allRegen.length - 1) {
      const btn        = document.createElement('button');
      btn.className    = 'btn btn-sm regen-btn';
      btn.style.cssText = 'margin-top:8px;display:block;';
      btn.textContent  = '↺ Antwort neu generieren';
      const userMsg    = b.dataset.lastUserMsg  || '';
      const withEditor = b.dataset.includeEditor === '1';
      btn.onclick = () => {
        b.remove();
        updateRegenerateButtons();
        handleSendMessageText(userMsg, { includeEditor: withEditor });
      };
      b.appendChild(btn);
    }
  });
}

async function sendNonStreaming(userMessage, includeEditor, editorCode, skipPushUserMessage = false) {
  const container = el('chat-messages');
  const loadingBubble = createChatBubble('assistant', '⋯');
  container.appendChild(loadingBubble);

  try {
    const result = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: currentSessionId,
        userMessage,
        includeEditor,
        editorCode,
        language: currentLanguage,
        skipPushUserMessage
      })
    }).then(r => r.json());

    if (result.error) throw new Error(result.error);

    loadingBubble.innerHTML = md(result.message);
    const msgIndex = container.querySelectorAll('.chat-bubble.assistant').length - 1;
    loadingBubble.appendChild(createFeedbackBar(msgIndex));

    if (result.toolResults) processToolResults(result.toolResults);
    if (result.tokenCount)  updateTokenCounterRaw(result.tokenCount);

  } catch (err) {
    loadingBubble.classList.add('system');
    loadingBubble.textContent = `Fehler: ${err.message}`;
    showToast(err.message, 'error');
  }

  await loadSessionsList();
}

// ── Tool Results ────────────────────────────────────────────────────────────
function processToolResults(toolResults) {
  if (!toolResults || !toolResults.length) return;

  const container = el('chat-messages');

  for (const tr of toolResults) {
    const result = tr.result;
    if (!result) continue;

    // Append a UI bubble for the tool call
    const toolBubble = createToolBubble(result);
    if (toolBubble) {
      container.appendChild(toolBubble);
      scrollToBottom();
    }

    switch (result.type) {
      case 'write_file':
        if (window.currentFilePath === result.path && window.editor) {
          window.editor.setValue(result.code);
          flashEditor('green');
        }
        loadFilesList();
        break;

      case 'create_task':
        if (result.task) showTask(result.task);
        break;

      case 'mark_task_done': {
        const taskPanel = el('task-panel');
        if (!taskPanel.classList.contains('hidden')) {
          el('task-done-btn').textContent = '✓ Erledigt!';
          el('task-done-btn').disabled = true;
          showToast('Aufgabe abgeschlossen! 🎉', 'success', 4000);
        }
        break;
      }

      case 'add_explanation':
        if (result.title && result.content) {
          showExplanation(result.title, result.content);
        }
        break;

      case 'trigger_summarize':
        showToast('Kontext wird komprimiert…', 'info', 2000);
        break;
    }

    // Run code result → show in terminal
    if (tr.tool === 'run_terminal_command' && (result.stdout !== undefined || result.stderr !== undefined)) {
      displayTerminalResult(result);
    }
  }
}

// ── Editor change / Diff ────────────────────────────────────────────────────
function applyEditorChange(newCode, reason) {
  if (!window.editor) return;
  const oldCode = window.editor.getValue();

  // Estimate changed lines
  const oldLines     = oldCode.split('\n');
  const newLines     = newCode.split('\n');
  const changedLines = newLines.filter((l, i) => l !== oldLines[i]).length
    + Math.abs(newLines.length - oldLines.length);

  // Save to undo history
  editorHistory.push({ code: oldCode, reason, timestamp: Date.now() });
  if (editorHistory.length > MAX_HISTORY) editorHistory.shift();
  updateUndoButton();

  const threshold = appSettings.diffAutoApplyThreshold ?? 5;

  if (changedLines <= threshold) {
    window.editor.setValue(newCode);
    flashEditor('green');
  } else {
    showDiffPreview(newCode, reason);
  }
}

function undoLastAIChange() {
  const last = editorHistory.pop();
  if (!last || !window.editor) return;
  window.editor.setValue(last.code);
  updateUndoButton();
  showToast(`↩ Rückgängig: "${last.reason}"`, 'info');
}

function updateUndoButton() {
  const btn = el('undo-ai-btn');
  btn.disabled = editorHistory.length === 0;
  btn.title = editorHistory.length > 0
    ? `↩ Rückgängig: "${editorHistory.at(-1).reason}"`
    : 'Keine KI-Änderungen zum Rückgängigmachen';
}

function showDiffPreview(newCode, reason) {
  if (!window.monaco) return;

  el('diff-reason').textContent = reason;
  el('diff-modal').classList.remove('hidden');

  const oldCode = window.editor.getValue();

  // Destroy previous diff editor if exists
  if (diffEditorInstance) {
    diffEditorInstance.dispose();
    diffEditorInstance = null;
  }

  el('diff-modal-editor').innerHTML = '';
  diffEditorInstance = monaco.editor.createDiffEditor(el('diff-modal-editor'), {
    readOnly:         true,
    renderSideBySide: true,
    theme:            'vs-dark'
  });
  diffEditorInstance.setModel({
    original: monaco.editor.createModel(oldCode,  currentLanguage),
    modified: monaco.editor.createModel(newCode, currentLanguage)
  });

  el('diff-confirm').onclick = () => {
    window.editor.setValue(newCode);
    closeDiff();
    flashEditor('green');
  };
}

function cancelDiff() {
  // Remove undo history entry since change was rejected
  editorHistory.pop();
  updateUndoButton();
  closeDiff();
}

function closeDiff() {
  el('diff-modal').classList.add('hidden');
  if (diffEditorInstance) {
    diffEditorInstance.dispose();
    diffEditorInstance = null;
  }
}

window.undoFileChange = async function(filePath, oldContentBase64) {
  if (!currentSessionId) return;
  const oldContent = atob(oldContentBase64);
  try {
    if (!oldContent) {
      // Wenn die Datei neu war, löschen
      await fetch(`/api/workspaces/${currentSessionId}/files?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
    } else {
      // Alten Inhalt wiederherstellen
      await fetch(`/api/workspaces/${currentSessionId}/files/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content: oldContent })
      });
    }
    showToast(`Änderung an ${filePath} rückgängig gemacht.`, 'success');
    if (window.currentFilePath === filePath && window.editor) {
      window.editor.setValue(oldContent || '');
    }
    loadFilesList();
  } catch (err) {
    showToast('Fehler beim Rückgängigmachen.', 'error');
  }
};

function flashEditor(color) {
  const editorPanel = el('editor-panel');
  editorPanel.classList.remove('flash-green', 'flash-blue');
  void editorPanel.offsetWidth; // reflow
  editorPanel.classList.add(`flash-${color}`);
  setTimeout(() => editorPanel.classList.remove(`flash-${color}`), 700);
}

// ── Task Panel ───────────────────────────────────────────────────────────────
function showTask(task) {
  el('task-title').textContent       = task.title;
  el('task-description').textContent = task.description;
  el('task-done-btn').disabled       = task.done || false;
  el('task-done-btn').textContent    = task.done ? '✓ Erledigt!' : '✓ Erledigt';

  const diffBadge = el('task-difficulty-badge');
  diffBadge.textContent = task.difficulty;
  diffBadge.className   = `badge badge-${task.difficulty}`;

  const hintsPanel = el('task-hints');
  const hintList   = el('hint-list');
  if (task.hints && task.hints.length > 0) {
    hintsPanel.classList.remove('hidden');
    hintList.innerHTML = '';
    let hintIndex = 0;
    el('hint-btn').onclick = () => {
      if (hintIndex < task.hints.length) {
        const hintEl = document.createElement('div');
        hintEl.className = 'hint-item';
        hintEl.textContent = `💡 ${task.hints[hintIndex++]}`;
        hintList.appendChild(hintEl);
        hintList.classList.remove('hidden');
        if (hintIndex >= task.hints.length) el('hint-btn').disabled = true;
      }
    };
  } else {
    hintsPanel.classList.add('hidden');
  }

  el('task-panel').classList.remove('hidden');
}

// ── Explanation Panel ────────────────────────────────────────────────────────
function showExplanation(title, content) {
  el('explanation-title').textContent  = title;
  el('explanation-content').innerHTML  = md(content);
  el('explanation-panel').classList.remove('hidden');
}

// ── Tool Indicator ────────────────────────────────────────────────────────────
const TOOL_LABELS = {
  read_editor:       'Editor wird gelesen…',
  write_editor:      'Code wird vorbereitet…',
  insert_at_line:    'Code wird eingefügt…',
  run_code:          'Code wird ausgeführt…',
  create_task:       'Aufgabe wird erstellt…',
  mark_task_done:    'Aufgabe wird abgeschlossen…',
  add_explanation:   'Erklärung wird vorbereitet…',
  get_language_profile: 'Profil wird geladen…',
  trigger_summarize: 'Kontext wird komprimiert…'
};

function showToolIndicator(toolName) {
  const indicator = el('tool-indicator');
  el('tool-indicator-text').textContent = TOOL_LABELS[toolName] || 'Denkt nach…';
  indicator.classList.remove('hidden');
}

function hideToolIndicator() {
  el('tool-indicator').classList.add('hidden');
}

// ── Code Execution ────────────────────────────────────────────────────────────
async function runCode() {
  if (!window.editor) return;
  const code = window.editor.getValue();
  const terminal = el('terminal-output');
  terminal.textContent = `${terminal.textContent || ''}$ ${currentLanguage} (${code.split(/\r?\n/).length} Zeilen)\n`;

  try {
    const result = await fetch('/api/terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, language: currentLanguage })
    }).then(r => r.json());

    if (result.sessionId) {
      activeTerminalSessionId = result.sessionId;
      if (result.output) {
        terminal.textContent = `${terminal.textContent}${result.output}`;
      }
      if (!result.exited) {
        startTerminalPolling();
      } else {
        activeTerminalSessionId = null;
        stopTerminalPolling();
      }
    } else {
      terminal.textContent = `${terminal.textContent}Fehler: ${result.error || 'Unbekannter Fehler'}`;
    }
  } catch (err) {
    terminal.textContent = `${terminal.textContent}Fehler: ${err.message}`;
  }
}

let activeTerminalSessionId = null;
let terminalPollTimer = null;

function stopTerminalPolling() {
  if (terminalPollTimer) {
    clearInterval(terminalPollTimer);
    terminalPollTimer = null;
  }
}

function startTerminalPolling() {
  stopTerminalPolling();
  terminalPollTimer = setInterval(() => {
    if (!activeTerminalSessionId) return;
    fetch(`/api/terminal/${activeTerminalSessionId}/output`)
      .then(r => r.json())
      .then((data) => {
        if (data.output !== undefined) {
          el('terminal-output').textContent = data.output;
        }
        if (data.exited) {
          activeTerminalSessionId = null;
          stopTerminalPolling();
        }
      })
      .catch(() => {});
  }, 250);
}

async function runTerminalCommand() {
  const input = el('terminal-input');
  const text = input.value.trim();
  if (!text) return;

  const terminal = el('terminal-output');
  if (!activeTerminalSessionId) {
    terminal.textContent = `${terminal.textContent || ''}$ ${text}\n`;
    input.value = '';

    try {
      const result = await fetch('/api/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: text })
      }).then(r => r.json());

      if (result.sessionId) {
        activeTerminalSessionId = result.sessionId;
        if (result.output) {
          terminal.textContent = `${terminal.textContent}${result.output}`;
        }
        if (!result.exited) {
          startTerminalPolling();
        } else {
          activeTerminalSessionId = null;
          stopTerminalPolling();
        }
      } else {
        terminal.textContent = `${terminal.textContent}Fehler: ${result.error || 'Unbekannter Fehler'}`;
      }
    } catch (err) {
      terminal.textContent = `${terminal.textContent}Fehler: ${err.message}`;
    }
    return;
  }

  const payload = text;
  input.value = '';
  terminal.textContent = `${terminal.textContent || ''}${payload}\n`;

  try {
    const result = await fetch('/api/terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: activeTerminalSessionId, input: payload })
    }).then(r => r.json());

    if (result.output !== undefined) {
      terminal.textContent = result.output;
    }
    if (result.exited) {
      activeTerminalSessionId = null;
      stopTerminalPolling();
    }
  } catch (err) {
    terminal.textContent = `${terminal.textContent}Fehler: ${err.message}`;
  }
}

function displayTerminalResult(result) {
  const terminal = el('terminal-output');
  const out      = result.stdout || '';
  const err      = result.stderr ? `\n[stderr]\n${result.stderr}` : '';
  const exit     = `\n[Exit: ${result.exitCode ?? '?'}]`;
  terminal.textContent = (out + err + exit).trimStart();
}

// ── Summarize ────────────────────────────────────────────────────────────────
async function triggerSummarize() {
  if (!currentSessionId) return;
  showToast('Kontext wird komprimiert…', 'info', 2000);
  // Send a system-level message to trigger the summarizer
  await handleSendMessageText('[SYSTEM: trigger_summarize]');
}

// ── Token Counter ─────────────────────────────────────────────────────────────
function updateTokenCounter(messages) {
  const totalChars = messages.reduce((s, m) =>
    s + (typeof m.content === 'string' ? m.content.length : 0), 0);
  updateTokenCounterRaw(Math.ceil(totalChars / 4));
}

function updateTokenCounterRaw(count) {
  const threshold = appSettings.tokenThreshold || 8000;
  const pct = Math.round((count / threshold) * 100);
  el('token-counter').textContent = `${count.toLocaleString()} / ${threshold.toLocaleString()} Tokens (${pct}%)`;
  el('token-counter').style.color = pct > 80 ? 'var(--warning)' : pct > 95 ? 'var(--danger)' : '';
}

// ── Sidebar toggle ────────────────────────────────────────────────────────────
let sidebarOpen = true;
function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  el('sessions-sidebar').classList.toggle('collapsed', !sidebarOpen);
  el('main-content').classList.toggle('sidebar-collapsed', !sidebarOpen);
  el('terminal-panel').classList.toggle('sidebar-collapsed', !sidebarOpen);
  if (window.editor) window.editor.layout();
}

// ── Misc helpers ──────────────────────────────────────────────────────────────
function scrollToBottom() {
  const c = el('chat-messages');
  c.scrollTop = c.scrollHeight;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000)   return 'gerade eben';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  } catch { return ''; }
}

// ── Event Bindings ────────────────────────────────────────────────────────────
function bindEvents() {
  // Header
  el('sidebar-toggle').onclick = toggleSidebar;
  el('settings-btn').onclick   = openSettings;
  el('model-select').onchange  = async (e) => {
    appSettings.activeModel = e.target.value;
    await fetch('/api/chat/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeModel: e.target.value })
    });
  };
  el('language-select').onchange = (e) => {
    currentLanguage = e.target.value;
    if (window.editor) {
      monaco.editor.setModelLanguage(window.editor.getModel(), currentLanguage);
    }
    if (currentSessionId) {
      fetch(`/api/sessions/${currentSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: currentLanguage })
      }).catch(() => {});
    }
  };

  // Session sidebar
  el('new-session-btn').onclick = createSession;

  // Editor actions
  el('run-btn').onclick    = runCode;
  el('terminal-run-btn').onclick = runTerminalCommand;
  el('undo-ai-btn').onclick = undoLastAIChange;

  // Chat input — send on Enter (no Shift)
  el('send-btn').onclick = () => handleSendMessage();
  el('send-with-code-btn').onclick = () => handleSendMessage(true);
  el('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });
  el('terminal-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runTerminalCommand();
    }
  });

// ── Sidebar Tabs ────────────────────────────────────────────────────────────
  el('tab-sessions').onclick = () => {
    el('tab-sessions').classList.add('active');
    el('tab-files').classList.remove('active');
    el('tab-plan').classList.remove('active');
    el('sessions-view').classList.remove('hidden');
    el('files-view').classList.add('hidden');
    el('plan-view').classList.add('hidden');
  };
  el('tab-files').onclick = () => {
    el('tab-files').classList.add('active');
    el('tab-sessions').classList.remove('active');
    el('tab-plan').classList.remove('active');
    el('files-view').classList.remove('hidden');
    el('sessions-view').classList.add('hidden');
    el('plan-view').classList.add('hidden');
    loadFilesList();
  };
  el('tab-plan').onclick = () => {
    el('tab-plan').classList.add('active');
    el('tab-sessions').classList.remove('active');
    el('tab-files').classList.remove('active');
    el('plan-view').classList.remove('hidden');
    el('sessions-view').classList.add('hidden');
    el('files-view').classList.add('hidden');
  };

  el('new-file-btn').onclick = () => promptCreateFileOrFolder('file');
  el('new-folder-btn').onclick = () => promptCreateFileOrFolder('folder');

  el('delete-last-msg-btn').onclick = () => deleteLastMessage();

  // Task done button
  el('task-done-btn').onclick = () => {
    const editorCode = window.editor ? window.editor.getValue() : '';
    const message = `[SYSTEM: Ich glaube ich habe die Aufgabe gelöst. Bitte überprüfe meinen Code und markiere die Aufgabe als erledigt wenn alles korrekt ist.\n\nCode-Editor-Inhalt:\n\n${editorCode}]`;
    handleSendMessageText(message);
  };

  // Terminal clear
  el('clear-terminal-btn').onclick = () => {
    stopTerminalPolling();
    activeTerminalSessionId = null;
    el('terminal-output').textContent = '';
  };

  // Settings range sliders — live preview
  el('s-temp').oninput          = (e) => { el('s-temp-val').textContent    = e.target.value; };
  el('s-tokenThreshold').oninput = (e) => { el('s-token-val').textContent   = e.target.value; };
  el('s-timeout').oninput       = (e) => { el('s-timeout-val').textContent  = e.target.value === '0' ? 'kein Timeout' : e.target.value; };

  // Settings reset prompt
  el('reset-prompt-btn').onclick = async () => {
    const res = await fetch('/api/chat/settings').then(r => r.json());
    // Re-fetch default from storage (settings endpoint returns current, not default)
    // Just clear the textarea to signal user should use the stored default
    if (confirm('System-Prompt auf Standard zurücksetzen?')) {
      el('s-systemPrompt').value = appSettings.systemPrompt || '';
    }
  };

  const terminalPanel = el('terminal-panel');
  const terminalResizer = el('terminal-resizer');
  const sidebarResizer = el('sidebar-resizer');
  const editorResizer = el('editor-resizer');
  
  let resizingTerminal = false;
  let resizingSidebar = false;
  let resizingEditor = false;

  terminalResizer.addEventListener('mousedown', (e) => {
    resizingTerminal = true;
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });
  sidebarResizer.addEventListener('mousedown', (e) => {
    resizingSidebar = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  if (editorResizer) {
    editorResizer.addEventListener('mousedown', (e) => {
      resizingEditor = true;
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });
  }

  document.addEventListener('mousemove', (e) => {
    if (resizingTerminal) {
      const nextHeight = Math.min(Math.max(window.innerHeight - e.clientY, 140), 480);
      document.documentElement.style.setProperty('--terminal-h', `${nextHeight}px`);
      terminalPanel.style.height = `${nextHeight}px`;
      if (window.editor) window.editor.layout();
    }
    if (resizingSidebar) {
      const nextWidth = Math.min(Math.max(e.clientX, 150), 500);
      document.documentElement.style.setProperty('--sidebar-w', `${nextWidth}px`);
      if (window.editor) window.editor.layout();
    }
    if (resizingEditor) {
      const sidebarW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 260;
      const availableW = window.innerWidth - sidebarW;
      const nextW = Math.min(Math.max(e.clientX - sidebarW, 200), availableW - 300);
      document.documentElement.style.setProperty('--editor-w', `${nextW}px`);
      if (window.editor) window.editor.layout();
    }
  });

  document.addEventListener('mouseup', () => {
    if (resizingTerminal) {
      resizingTerminal = false;
      appSettings.terminalHeight = terminalPanel.style.height;
      saveSettings(false);
    }
    if (resizingSidebar) {
      resizingSidebar = false;
      appSettings.sidebarWidth = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w');
      saveSettings(false);
    }
    if (resizingEditor) {
      resizingEditor = false;
      appSettings.editorWidth = getComputedStyle(document.documentElement).getPropertyValue('--editor-w');
      saveSettings(false);
    }
    document.body.style.cursor = '';
  });

  // Window beforeunload — save editor snapshot
  window.addEventListener('beforeunload', () => {
    if (currentSessionId && window.editor) {
      navigator.sendBeacon(`/api/sessions/${currentSessionId}`,
        JSON.stringify({ editorSnapshot: window.editor.getValue() }));
    }
  });

  // Auto-refresh models every 30s
  setInterval(loadModels, 30000);

  // Initial welcome
  if (!currentSessionId) {
    el('chat-messages').innerHTML = renderWelcome();
  }
}

// Make closeSettings globally accessible (called from HTML)
window.closeSettings = closeSettings;
window.saveSettings  = saveSettings;
