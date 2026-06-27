// server/services/tools.js

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_editor',
      description: 'Liest den aktuellen Code aus dem Editor des Nutzers.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_editor',
      description: 'Ersetzt den gesamten Code im Editor. Wird mit Diff-Vorschau angezeigt (kleine Änderungen direkt, große mit Bestätigung).',
      parameters: {
        type: 'object',
        properties: {
          code:   { type: 'string', description: 'Der vollständige neue Code-Inhalt' },
          reason: { type: 'string', description: 'Kurze Erklärung was geändert wurde' }
        },
        required: ['code', 'reason']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'insert_at_line',
      description: 'Fügt Code-Zeilen ab einer bestimmten Zeilennummer ein.',
      parameters: {
        type: 'object',
        properties: {
          line:   { type: 'number', description: 'Zeilennummer (1-basiert)' },
          code:   { type: 'string', description: 'Einzufügender Code' },
          reason: { type: 'string', description: 'Warum wird dieser Code eingefügt?' }
        },
        required: ['line', 'code', 'reason']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_code',
      description: 'Führt den aktuellen Editor-Code im Terminal aus und gibt stdout/stderr zurück.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['python', 'javascript', 'bash', 'go'] }
        },
        required: ['language']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Erstellt eine neue Lernaufgabe im Aufgaben-Panel.',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string' },
          description: { type: 'string' },
          difficulty:  { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
          hints:       { type: 'array', items: { type: 'string' } }
        },
        required: ['title', 'description', 'difficulty']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mark_task_done',
      description: 'Markiert die aktuelle Aufgabe als abgeschlossen. Löst automatisch eine Lernprofil-Aktualisierung aus.',
      parameters: {
        type: 'object',
        properties: {
          feedback:       { type: 'string', description: 'Was hat der Nutzer gut gemacht / wo gab es Schwierigkeiten?' },
          newConcepts:    { type: 'array', items: { type: 'string' }, description: 'Neu gelernte Konzepte' },
          strengths:      { type: 'array', items: { type: 'string' } },
          weaknesses:     { type: 'array', items: { type: 'string' } },
          taskSucceeded:  { type: 'boolean', description: 'Hat der Nutzer die Aufgabe erfolgreich gelöst?' }
        },
        required: ['feedback']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_explanation',
      description: 'Zeigt eine strukturierte Erklärung im Erklärungs-Panel (neben dem Editor).',
      parameters: {
        type: 'object',
        properties: {
          title:   { type: 'string' },
          content: { type: 'string', description: 'Markdown-formatierter Erklärungstext' }
        },
        required: ['title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_language_profile',
      description: 'Ruft das gespeicherte Sprachprofil des Nutzers ab (bekannte Konzepte, Stärken, Schwächen in anderen Sprachen). Nur verfügbar wenn cross-chat-profil aktiviert ist.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', description: 'z.B. "java", "python", "javascript"' }
        },
        required: ['language']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'trigger_summarize',
      description: 'Komprimiert den Kontext manuell. Nützlich wenn der Kontext bald voll wird.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
];
