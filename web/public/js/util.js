// OWNER: F1. Shared helpers. The exported SIGNATURES are FROZEN - F2 imports
// toast(), escapeHtml(), fmtDuration(), debounce() and byId(). Adding exports is fine.

/** @param {string} id @returns {HTMLElement|null} */
export function byId(id) {
  return document.getElementById(id);
}

/** HTML-escape untrusted text (session names, docker output, error messages). TODO(F1) */
export function escapeHtml(value) {
  void value;
  throw new Error('TODO(F1): implement escapeHtml');
}

/**
 * Show a Bootstrap toast in #toast-area.
 * TODO(F1): build `.toast` markup, append to #toast-area, `new bootstrap.Toast(el,{delay})`,
 * dispose on 'hidden.bs.toast'. Must never throw (it is used inside catch blocks).
 * @param {string} message
 * @param {{variant?:'success'|'danger'|'warning'|'info', title?:string, delay?:number}} [opts]
 */
export function toast(message, opts = {}) {
  void message; void opts;
  throw new Error('TODO(F1): implement toast');
}

/** Convenience wrapper: toast(err.message, {variant:'danger'}), ApiError-aware. TODO(F1) */
export function toastError(err, fallback = 'Request failed') {
  void err; void fallback;
  throw new Error('TODO(F1): implement toastError');
}

/**
 * Promise-based confirm using #confirm-modal.
 * TODO(F1): fill #confirm-title/#confirm-body, set the #confirm-ok label+variant,
 * resolve(true) on click, resolve(false) on dismiss; always resolve exactly once.
 * @param {{title:string, body:string, confirmLabel?:string, variant?:'danger'|'primary'}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts) {
  void opts;
  throw new Error('TODO(F1): implement confirmDialog');
}

/** "3h 12m" / "45s" from seconds; '-' for null/undefined. TODO(F1) */
export function fmtDuration(seconds) {
  void seconds;
  throw new Error('TODO(F1): implement fmtDuration');
}

/** "1.2 GB" from bytes. TODO(F1) */
export function fmtBytes(bytes) {
  void bytes;
  throw new Error('TODO(F1): implement fmtBytes');
}

/** ISO string -> locale short datetime; '-' when falsy. TODO(F1) */
export function fmtDate(iso) {
  void iso;
  throw new Error('TODO(F1): implement fmtDate');
}

/**
 * Trailing-edge debounce.
 * TODO(F1): return a wrapper with a `.cancel()` and a `.flush()` method.
 * @template {(...args:any[])=>void} F
 * @param {F} fn @param {number} waitMs @returns {F & {cancel():void, flush():void}}
 */
export function debounce(fn, waitMs) {
  void fn; void waitMs;
  throw new Error('TODO(F1): implement debounce');
}

/** Bootstrap badge class for a SessionView.status. TODO(F1) */
export function statusBadgeClass(status) {
  void status;
  throw new Error('TODO(F1): implement statusBadgeClass');
}

/** localStorage JSON get/set that never throws (private mode, quota). TODO(F1) */
export const storage = {
  /** @param {string} key @param {any} fallback */
  get(key, fallback = null) { void key; return fallback; },
  /** @param {string} key @param {any} value @returns {boolean} */
  set(key, value) { void key; void value; return false; },
  remove(key) { void key; },
};

/** localStorage key namespace - F2 uses `${LS_PREFIX}layout.v1`. FROZEN. */
export const LS_PREFIX = 'porterclaude.';
