// FROZEN (planner-authored, fully implemented). The ONLY cross-package channel between
// F1 (shell/settings/sessions) and F2 (code/terminals). Nobody needs to edit this file:
// event names and payloads are a contract. Add events only via docs/design/frontend.md.
//
// Usage:
//   import { bus, EVENTS } from './bus.js';
//   const off = bus.on(EVENTS.SESSIONS_CHANGED, ({ sessions }) => { ... });
//   bus.emit(EVENTS.SESSIONS_CHANGED, { sessions });

/** @typedef {Record<string, any>} Payload */

export const EVENTS = Object.freeze({
  /** emitted by sessions.js (F1) after every list/poll/CRUD. payload: { sessions: SessionView[] } */
  SESSIONS_CHANGED: 'sessions:changed',
  /** emitted by api.js (F1) on any 401 from a non-auth endpoint. payload: {} */
  AUTH_REQUIRED: 'auth:required',
  /** emitted by app.js (F1) once the user is authenticated (first load and after login). payload: {} */
  AUTH_READY: 'auth:ready',
  /** emitted by app.js (F1) after logout, before the login modal opens. payload: {} */
  AUTH_LOST: 'auth:lost',
  /** emitted by settings.js (F1) after settings are saved/loaded. payload: { settings: SanitizedSettings } */
  SETTINGS_CHANGED: 'settings:changed',
  /** emitted by app.js (F1) when the effective theme changes. payload: { theme: 'dark'|'light' } */
  THEME_CHANGED: 'theme:changed',
  /** emitted by app.js (F1) on every route change. payload: { view: 'code'|'sessions'|'settings' } */
  VIEW_CHANGED: 'view:changed',
  /** emitted by sessions.js (F1) "open terminal" action -> code.js (F2) opens a pane.
   *  payload: { session: string, shell: 'bash'|'claude'|'sh' } */
  OPEN_TERMINAL: 'code:open-terminal',
  /** emitted by code.js (F2) when a pane count changes. payload: { count: number } */
  TERMINALS_CHANGED: 'terminals:changed',
});

class Bus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

  /**
   * @param {string} event
   * @param {(payload: Payload) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(event, handler) {
    let set = this._handlers.get(event);
    if (!set) {
      set = new Set();
      this._handlers.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /** @param {string} event @param {(payload: Payload) => void} handler */
  off(event, handler) {
    this._handlers.get(event)?.delete(handler);
  }

  /** @param {string} event @param {(payload: Payload) => void} handler */
  once(event, handler) {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  /** Handlers never throw into the emitter. @param {string} event @param {Payload} [payload] */
  emit(event, payload = {}) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[bus] handler for "${event}" threw`, err);
      }
    }
  }
}

export const bus = new Bus();
