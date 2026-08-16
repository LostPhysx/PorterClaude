// OWNER: F1. Shared helpers. The exported SIGNATURES are FROZEN - F2 imports
// toast(), escapeHtml(), fmtDuration(), debounce() and byId(). Adding exports is fine.

/** @param {string} id @returns {HTMLElement|null} */
export function byId(id) {
  return document.getElementById(id);
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escape untrusted text (session names, docker output, error messages). */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

const TOAST_VARIANTS = {
  success: { bg: 'text-bg-success', icon: 'bi-check-circle', title: 'Done' },
  danger: { bg: 'text-bg-danger', icon: 'bi-exclamation-octagon', title: 'Error' },
  warning: { bg: 'text-bg-warning', icon: 'bi-exclamation-triangle', title: 'Warning' },
  info: { bg: 'text-bg-secondary', icon: 'bi-info-circle', title: 'Info' },
};

/**
 * Show a Bootstrap toast in #toast-area. Never throws (used inside catch blocks).
 * @param {string} message
 * @param {{variant?:'success'|'danger'|'warning'|'info', title?:string, delay?:number}} [opts]
 */
export function toast(message, opts = {}) {
  try {
    const variant = TOAST_VARIANTS[opts.variant] ? opts.variant : 'info';
    const spec = TOAST_VARIANTS[variant];
    const area = byId('toast-area');
    if (!area) {
      console.log(`[toast:${variant}]`, message);
      return;
    }
    const el = document.createElement('div');
    el.className = `toast align-items-center border-0 ${spec.bg}`;
    el.setAttribute('role', variant === 'danger' ? 'alert' : 'status');
    el.setAttribute('aria-live', variant === 'danger' ? 'assertive' : 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.innerHTML =
      '<div class="toast-header">' +
      `<i class="bi ${spec.icon} me-2"></i>` +
      `<strong class="me-auto">${escapeHtml(opts.title || spec.title)}</strong>` +
      '<button type="button" class="btn-close" data-bs-dismiss="toast" aria-label="Close"></button>' +
      '</div>' +
      `<div class="toast-body">${escapeHtml(message)}</div>`;
    area.appendChild(el);
    const delay = typeof opts.delay === 'number' ? opts.delay : variant === 'danger' ? 9000 : 5000;
    if (typeof bootstrap !== 'undefined' && bootstrap.Toast) {
      const t = new bootstrap.Toast(el, { delay });
      el.addEventListener('hidden.bs.toast', () => {
        try { t.dispose(); } catch { /* ignore */ }
        el.remove();
      });
      t.show();
    } else {
      el.classList.add('show');
      setTimeout(() => el.remove(), delay);
    }
  } catch (err) {
    console.error('[util.toast] failed', err, message);
  }
}

/** Convenience wrapper: toast(err.message, {variant:'danger'}), ApiError-aware. */
export function toastError(err, fallback = 'Request failed') {
  try {
    const message = (err && (err.message || err.statusText)) || fallback;
    const code = err && err.code ? String(err.code) : null;
    const title = code && code !== 'internal' ? code.replace(/_/g, ' ') : 'Error';
    toast(message, { variant: 'danger', title });
  } catch (inner) {
    console.error('[util.toastError] failed', inner, err);
  }
}

/** Serialises confirmDialog() calls so a second dialog waits for the first to finish hiding. */
let confirmQueue = Promise.resolve();

/**
 * Promise-based confirm using #confirm-modal. Always resolves exactly once.
 *
 * The promise settles from `hidden.bs.modal`, i.e. only once the modal has finished
 * hiding and Bootstrap is no longer transitioning. That is what makes back-to-back
 * dialogs (`await confirmDialog(...)` then `await confirmDialog(...)` on the same
 * element) work: `Modal.show()` is a no-op while the instance is still transitioning,
 * so a dialog opened straight from the OK click of the previous one would never
 * appear. Concurrent callers are serialised through `confirmQueue`.
 *
 * @param {{title:string, body:string, confirmLabel?:string, variant?:'danger'|'primary'}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts) {
  const modalEl = byId('confirm-modal');
  const titleEl = byId('confirm-title');
  const bodyEl = byId('confirm-body');
  const okEl = byId('confirm-ok');
  if (!modalEl || !titleEl || !bodyEl || !okEl || typeof bootstrap === 'undefined') {
    // Degrade gracefully rather than blocking the caller forever.
    return Promise.resolve(false);
  }

  const run = () =>
    new Promise((resolve) => {
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      let confirmed = false;
      let settled = false;
      const onOk = () => {
        confirmed = true;
        modal.hide();
      };
      const onHidden = () => {
        if (settled) return;
        settled = true;
        okEl.removeEventListener('click', onOk);
        modalEl.removeEventListener('hidden.bs.modal', onHidden);
        resolve(confirmed);
      };
      const start = () => {
        titleEl.textContent = opts.title || 'Are you sure?';
        // `body` may contain markup built by the caller; callers escape their own data.
        bodyEl.innerHTML = opts.body || '';
        okEl.textContent = opts.confirmLabel || 'OK';
        okEl.className = `btn btn-${opts.variant === 'primary' ? 'primary' : 'danger'}`;
        okEl.addEventListener('click', onOk);
        modalEl.addEventListener('hidden.bs.modal', onHidden);
        modal.show();
      };
      if (modalEl.classList.contains('show')) {
        // Someone else still owns the element - wait it out, then take over.
        modalEl.addEventListener('hidden.bs.modal', () => setTimeout(start, 0), { once: true });
      } else {
        start();
      }
    });

  const pending = confirmQueue.then(run, run);
  confirmQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

/** "3h 12m" / "45s" from seconds; '-' for null/undefined. */
export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return '-';
  let s = Math.max(0, Math.floor(Number(seconds)));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** "1.2 GB" from bytes. */
export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (bytes === null || bytes === undefined || Number.isNaN(n)) return '-';
  if (n < 1024) return `${Math.round(n)} B`;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** ISO string -> locale short datetime; '-' when falsy/invalid. */
export function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  try {
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return d.toISOString();
  }
}

/**
 * Trailing-edge debounce with cancel()/flush().
 * @template {(...args:any[])=>void} F
 * @param {F} fn @param {number} waitMs @returns {F & {cancel():void, flush():void}}
 */
export function debounce(fn, waitMs) {
  let timer = null;
  let lastArgs = null;
  const invoke = () => {
    timer = null;
    const args = lastArgs || [];
    lastArgs = null;
    fn(...args);
  };
  const wrapped = (...args) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(invoke, waitMs);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      invoke();
    }
  };
  return /** @type {any} */ (wrapped);
}

/** Bootstrap badge class for a SessionView.status. */
export function statusBadgeClass(status) {
  switch (status) {
    case 'running':
      return 'text-bg-success';
    case 'restarting':
    case 'created':
    case 'removing':
      return 'text-bg-warning';
    case 'paused':
      return 'text-bg-info';
    case 'dead':
      return 'text-bg-danger';
    case 'exited':
      return 'text-bg-secondary';
    case 'absent':
      return 'text-bg-dark';
    default:
      return 'text-bg-secondary';
  }
}

/** localStorage JSON get/set that never throws (private mode, quota). */
export const storage = {
  /** @param {string} key @param {any} fallback */
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  /** @param {string} key @param {any} value @returns {boolean} */
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/** localStorage key namespace - F2 uses `${LS_PREFIX}layout.v1`. FROZEN. */
export const LS_PREFIX = 'porterclaude.';

// ---------------------------------------------------------------------------
// Small extras used across the F1 views (additive, safe for F2 to ignore).
// ---------------------------------------------------------------------------

/** True while any Bootstrap modal is on screen (used to pause polling). */
export function anyModalOpen() {
  return document.querySelectorAll('.modal.show').length > 0;
}

/** Render an inline Bootstrap alert (already-escaped html allowed) into a container. */
export function renderAlert(container, html, variant = 'warning') {
  if (!container) return;
  container.innerHTML = html ? `<div class="alert alert-${variant} py-2 small mb-3">${html}</div>` : '';
}
