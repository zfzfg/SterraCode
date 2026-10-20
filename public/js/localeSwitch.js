import { api, getPendingMutationCount } from "./api.js";
import { state, emit } from "./state.js";
import {
  t,
  getLocale,
  normalizeLocale,
  preloadLocale,
  changeLocale,
  localeSelector,
} from "./i18n.js";
import { flushAll, captureEditorState, restoreEditorState } from "./editor.js";
import {
  chatWorkActive,
  captureChatDrafts,
  restoreChatDrafts,
} from "./chat.js";
import {
  captureJournalDrafts,
  restoreJournalDrafts,
} from "./learningSupport.js";
import { captureTaskSections, restoreTaskSections } from "./taskSections.js";
import { captureWorkspaceState, restoreWorkspaceState } from "./workspace.js";
import {
  terminalWorkActive,
  captureTerminalState,
  restoreTerminalState,
  showTerminal,
} from "./terminal.js";
import { testsWorkActive } from "./taskTests.js";
import { tracesWorkActive } from "./tracer.js";
import { previewWorkActive } from "./preview.js";
import { toast } from "./ui.js";

const recoveryKey = "sterracode.localeRecovery.v1";
let openSession;
let switching = false;
let selector;
const historyRecoveryKey = "sterracodeLocaleRecovery";
function clearRecovery() {
  try {
    sessionStorage.removeItem(recoveryKey);
  } catch {
    /* History fallback remains available. */
  }
  try {
    if (history.state?.[historyRecoveryKey]) {
      const next = { ...history.state };
      delete next[historyRecoveryKey];
      history.replaceState(next, "");
    }
  } catch {
    /* Expiry and locale validation also prevent stale recovery. */
  }
}
function storeRecovery(saved) {
  clearRecovery();
  try {
    sessionStorage.setItem(recoveryKey, JSON.stringify(saved));
    return;
  } catch {
    /* Browsers can deny Web Storage while allowing tab history. */
  }
  try {
    history.replaceState(
      { ...(history.state || {}), [historyRecoveryKey]: saved },
      "",
    );
  } catch {
    throw new Error(t("features:locale.storageUnavailable"));
  }
}

function assertIdle() {
  if (chatWorkActive()) throw new Error(t("features:locale.chatActive"));
  if (getPendingMutationCount())
    throw new Error(t("features:locale.actionActive"));
  if (document.querySelector("dialog[open]"))
    throw new Error(t("features:locale.dialogOpen"));
  if (document.getElementById("terminal-input")?.value)
    throw new Error(t("features:locale.terminalInput"));
  if (terminalWorkActive())
    throw new Error(t("features:locale.terminalActive"));
  if (previewWorkActive()) throw new Error(t("features:locale.actionActive"));
}
async function assertJobsIdle() {
  if (await testsWorkActive())
    throw new Error(t("features:locale.testsActive"));
  if (await tracesWorkActive())
    throw new Error(t("features:locale.traceActive"));
  try {
    const programs = await api("/api/programs");
    if (programs.activeJob)
      throw new Error(t("features:locale.programsActive"));
  } catch (error) {
    // A remote runner can also be configured outside Docker app mode.
    if (error.code !== "LOCAL_MODE") throw error;
  }
}
function capture() {
  const app = document.getElementById("app");
  return {
    version: 1,
    createdAt: Date.now(),
    sessionId: state.session?.id || null,
    editor: captureEditorState(),
    chat: captureChatDrafts(),
    journals: captureJournalDrafts(),
    journalOpen: Boolean(document.querySelector(".task-reflection")?.open),
    sections: captureTaskSections(),
    expanded: captureWorkspaceState(),
    terminals: captureTerminalState(),
    view: app.dataset.view,
    sidebarTab: document.querySelector('.sidebar-tabs [aria-selected="true"]')
      ?.id,
    sidebarOpen: app.classList.contains("sidebar-open"),
    sidebarCollapsed: app.classList.contains("sidebar-collapsed"),
    terminalOpen: !document.getElementById("terminal-panel").hidden,
    terminalScroll: document.getElementById("terminal-output").scrollTop,
    chatScroll: document.getElementById("chat-messages").scrollTop,
    focusId: document.activeElement?.id,
  };
}
export async function requestLocaleChange(value) {
  const target = normalizeLocale(value);
  if (target === getLocale() || switching) return;
  switching = true;
  const previous = getLocale();
  const app = document.getElementById("app");
  try {
    try {
      await preloadLocale(target);
    } catch {
      throw new Error(t("features:locale.catalogUnavailable"));
    }
    assertIdle();
    app.inert = true;
    await assertJobsIdle();
    assertIdle();
    await flushAll();
    assertIdle();
    await assertJobsIdle();
    assertIdle();
    const saved = { ...capture(), locale: target };
    storeRecovery(saved);
    try {
      await changeLocale(target);
    } catch {
      throw new Error(t("features:locale.catalogUnavailable"));
    }
    location.reload();
  } catch (error) {
    clearRecovery();
    if (getLocale() !== previous) await changeLocale(previous);
    throw error;
  } finally {
    app.inert = false;
    switching = false;
  }
}
export function initLocaleSwitch(options) {
  openSession = options.openSession;
  if (selector) return;
  selector = localeSelector(requestLocaleChange);
  selector.id = "ui-locale";
  document.querySelector(".header-actions").prepend(selector);
}
export async function restoreLocaleSwitch() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(recoveryKey) || "null");
  } catch {
    /* Read the tab history fallback below. */
  }
  saved ||= history.state?.[historyRecoveryKey];
  if (
    !saved ||
    saved.version !== 1 ||
    !normalizeLocale(saved.locale, null) ||
    !Number.isFinite(saved.createdAt) ||
    Date.now() - saved.createdAt > 30 * 60 * 1000 ||
    Date.now() < saved.createdAt
  ) {
    clearRecovery();
    return;
  }
  restoreChatDrafts(saved.chat);
  restoreJournalDrafts(saved.journals);
  restoreTaskSections(saved.sections);
  restoreWorkspaceState(saved.expanded);
  if (
    saved.sessionId &&
    !state.sessions.some(
      (session) => session.id === saved.sessionId && session.deleting,
    )
  ) {
    try {
      await openSession(saved.sessionId);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    restoreEditorState(saved.editor);
    const reflection = document.querySelector(".task-reflection");
    if (reflection) reflection.open = Boolean(saved.journalOpen);
  }
  await restoreTerminalState(saved.terminals);
  const app = document.getElementById("app");
  if (["editor", "chat"].includes(saved.view))
    document.getElementById(`view-${saved.view}`)?.click();
  if (["tab-sessions", "tab-files", "tab-plan"].includes(saved.sidebarTab))
    document.getElementById(saved.sidebarTab)?.click();
  app.classList.toggle("sidebar-open", Boolean(saved.sidebarOpen));
  app.classList.toggle("sidebar-collapsed", Boolean(saved.sidebarCollapsed));
  if (saved.terminalOpen && state.session) showTerminal(true);
  emit("layout");
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  document.getElementById("chat-messages").scrollTop =
    Number(saved.chatScroll) || 0;
  document.getElementById("terminal-output").scrollTop =
    Number(saved.terminalScroll) || 0;
  if (typeof saved.focusId === "string")
    document.getElementById(saved.focusId)?.focus();
  clearRecovery();
  toast(t("features:locale.restored"));
}
