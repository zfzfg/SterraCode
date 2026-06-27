// server/services/profileManager.js
import path from 'path';
import { readJSON, writeJSON, DATA_DIR } from './storage.js';

const PROFILE_PATH = path.join(DATA_DIR, 'profiles', 'user.json');

export async function getProfile() {
  try {
    return await readJSON(PROFILE_PATH);
  } catch {
    return { profileVersion: 1, updatedAt: new Date().toISOString(), languages: {} };
  }
}

/**
 * Updates the user's language profile after a task is completed.
 * Uses success rate + known concept count for level inference — prevents
 * inflated levels from many partially-understood concepts.
 */
export async function updateProfile({ language, newConcepts = [], strengths = [], weaknesses = [], taskSucceeded = true }) {
  const profile = await getProfile();

  if (!profile.languages[language]) {
    profile.languages[language] = {
      level:           'beginner',
      knownConcepts:   [],
      strengths:       [],
      weaknesses:      [],
      tasksAttempted:  0,
      tasksSucceeded:  0,
      sessionCount:    0,
      lastActive:      null
    };
  }

  const lang = profile.languages[language];
  lang.knownConcepts  = [...new Set([...lang.knownConcepts, ...newConcepts])];
  lang.strengths      = [...new Set([...lang.strengths, ...strengths])];
  lang.weaknesses     = [...new Set([...lang.weaknesses, ...weaknesses])];
  lang.tasksAttempted = (lang.tasksAttempted ?? 0) + 1;
  lang.tasksSucceeded = (lang.tasksSucceeded ?? 0) + (taskSucceeded ? 1 : 0);
  lang.sessionCount  += 1;
  lang.lastActive     = new Date().toISOString().split('T')[0];

  const successRate = lang.tasksAttempted > 0 ? lang.tasksSucceeded / lang.tasksAttempted : 0;
  lang.level = inferLevel(lang.knownConcepts.length, successRate);

  profile.updatedAt = new Date().toISOString();
  await writeJSON(PROFILE_PATH, profile);
  return profile;
}

/** Level inference: combines concept breadth with task success rate */
function inferLevel(knownConceptCount, taskSuccessRate) {
  if (knownConceptCount < 5  || taskSuccessRate < 0.40) return 'beginner';
  if (knownConceptCount < 15 || taskSuccessRate < 0.65) return 'intermediate';
  return 'advanced';
}

/**
 * Generates a short profile summary for the system prompt.
 * Only included when cross-chat profiling is enabled.
 */
export function profileToPromptText(profile, currentLanguage) {
  const entries = Object.entries(profile.languages || {})
    .filter(([lang]) => lang !== currentLanguage);

  if (entries.length === 0) return '';

  const lines = entries.map(([lang, data]) => {
    const concepts = data.knownConcepts.slice(0, 5).join(', ') + (data.knownConcepts.length > 5 ? ' u.a.' : '');
    const strs = data.strengths.join(', ') || '–';
    return `- ${lang.toUpperCase()} (${data.level}): Kennt ${concepts}. Stärken: ${strs}`;
  }).join('\n');

  return `\n\n[LERNSTAND DES NUTZERS IN ANDEREN SPRACHEN]\n${lines}\n\nNutze dieses Wissen für Vergleiche (z.B. "In Java machst du das so, in Python geht es kürzer so"). Erkläre Konzepte über Analogien zur bekannten Sprache.`;
}
