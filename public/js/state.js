export const state = {
  settings: {},
  session: null,
  sessions: [],
  models: [],
  runtimes: [],
  connected: false,
  ready: false,
  busy: false,
  turnId: null,
  terminal: null,
};
const events = new EventTarget();
export function emit(name, detail) {
  events.dispatchEvent(new CustomEvent(name, { detail }));
}
export function on(name, handler) {
  events.addEventListener(name, (event) => {
    try {
      Promise.resolve(handler(event.detail)).catch((error) =>
        window.dispatchEvent(new CustomEvent("app-error", { detail: error })),
      );
    } catch (error) {
      window.dispatchEvent(new CustomEvent("app-error", { detail: error }));
    }
  });
}
