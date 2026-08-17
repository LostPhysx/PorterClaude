// FROZEN (planner-authored, fully implemented). The ONLY cross-package channel between
// F1 (shell/settings/containers) and F2 (code/sessions). Nobody needs to edit this file:
// event names and payloads are a contract. Add events only via docs/design/frontend.md.
//
// v0.3 vocabulary (docs/design/users.md section 0): a CONTAINER is the long-lived project
// box, a SESSION is one shell connection into it. `sessions:changed` therefore no longer
// means "the container list changed" - that is `containers:changed` now.
//
// Usage:
//   import { bus, EVENTS } from './bus.js';
//   const off = bus.on(EVENTS.CONTAINERS_CHANGED, ({ containers }) => { ... });
//   bus.emit(EVENTS.CONTAINERS_CHANGED, { containers });

/** @typedef {Record<string, any>} Payload */

export const EVENTS = Object.freeze({
  /** emitted by containers.js (F1) after every list/poll/CRUD.
   *  payload: { containers: ContainerView[] } */
  CONTAINERS_CHANGED: 'containers:changed',
  /** emitted by api.js (F1) on any 401 from a non-auth endpoint. payload: {} */
  AUTH_REQUIRED: 'auth:required',
  /** emitted by app.js (F1) once the user is authenticated (first load and after login). payload: {} */
  AUTH_READY: 'auth:ready',
  /** emitted by app.js (F1) after logout, before the login modal opens. payload: {} */
  AUTH_LOST: 'auth:lost',
  /** emitted by settings.js (F1) after settings are saved/loaded. payload: { settings: SanitizedSettings } */
  SETTINGS_CHANGED: 'settings:changed',
  /** v0.2: emitted by hosts.js (F1) after every host list/CRUD.
   *  payload: { hosts: HostView[], defaultHostId: string|null } */
  HOSTS_CHANGED: 'hosts:changed',
  /** v0.2: emitted by agents.js (F1) after the agent registry is loaded/changed.
   *  payload: { agents: AgentView[] } */
  AGENTS_CHANGED: 'agents:changed',
  /** emitted by app.js (F1) when the effective theme changes. payload: { theme: 'dark'|'light' } */
  THEME_CHANGED: 'theme:changed',
  /** emitted by app.js (F1) on every route change. payload: { view: 'code'|'containers'|'settings' } */
  VIEW_CHANGED: 'view:changed',
  /** emitted by containers.js (F1) "open session" action -> code.js (F2) opens a pane.
   *  v0.3 payload: { container: string, shell: 'bash'|'sh'|'agent:<agentId>' }
   *  (the WIRE value, api.js `formatShellParam`; the legacy 'claude' is still tolerated
   *   by code.js but never emitted). */
  OPEN_SESSION: 'code:open-session',
  /** emitted by code.js (F2) when the open SESSION (pane) count changes.
   *  payload: { count: number } */
  SESSIONS_CHANGED: 'sessions:changed',
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
