// server/services/tools.js

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Liest eine Datei aus dem Workspace des Nutzers.',
      parameters: { 
        type: 'object', 
        properties: {
          path: { type: 'string', description: 'Pfad zur Datei relativ zum Workspace, z.B. Main.java' }
        }, 
        required: ['path'] 
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Schreibt oder überschreibt eine Datei im Workspace. Änderungen werden sofort angewendet.',
      parameters: {
        type: 'object',
        properties: {
          path:   { type: 'string', description: 'Pfad zur Datei, z.B. Main.java' },
          code:   { type: 'string', description: 'Der vollständige neue Code-Inhalt' },
          reason: { type: 'string', description: 'Kurze Erklärung was geändert wurde' }
        },
        required: ['path', 'code', 'reason']
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
      name: 'run_terminal_command',
      description: 'Führt einen Shell-Befehl im Terminal aus und gibt die Ausgabe zurück. Verwende dies zum Kompilieren, Ausführen von Code, oder für Paketmanager.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Der auszuführende Befehl, z.B. javac Main.java oder node script.js' }
        },
        required: ['command']
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
      name: 'ask_question',
      description: 'Stellt dem Nutzer eine interaktive Frage (Multiple-Choice oder Freitext).',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Die Frage an den Nutzer' },
          type:     { type: 'string', enum: ['multiple-choice', 'text'], description: 'Art der Frage' },
          options:  { type: 'array', items: { type: 'string' }, description: 'Antwortoptionen (nur bei multiple-choice)' }
        },
        required: ['question', 'type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_learning_plan',
      description: 'Erstellt oder aktualisiert den Lernplan für die aktuelle Session.',
      parameters: {
        type: 'object',
        properties: {
          goal:   { type: 'string', description: 'Das übergeordnete Lernziel' },
          topics: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id:    { type: 'string' },
                title: { type: 'string' },
                done:  { type: 'boolean' }
              },
              required: ['id', 'title', 'done']
            }
          }
        },
        required: ['goal', 'topics']
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
