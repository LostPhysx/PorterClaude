// OWNER: F1. Settings -> Images sub-panel: recipe list, builds, job log polling,
// tools-volume sync. Not a top-level view; settings.js drives its lifecycle.
import { api } from './api.js';
import { byId, toast, toastError, escapeHtml, fmtBytes, fmtDate } from './util.js';

/** Poll interval for a running job (api.md: builds are polled, not streamed). */
export const JOB_POLL_MS = 1000;

/** @type {any[]} */
let recipes = [];
/** @type {any|null} */
let toolsStatus = null;
let initialised = false;

/** job modal state */
const jobState = { id: null, cursor: 0, timer: null, autoScroll: true, status: null };

function stopJobPoll() {
  if (jobState.timer) clearTimeout(jobState.timer);
  jobState.timer = null;
}

function recipeCard(r) {
  const state = r.building
    ? '<span class="badge text-bg-info"><span class="spinner-border spinner-border-sm me-1"></span>building</span>'
    : r.outdated
      ? '<span class="badge text-bg-warning">outdated</span>'
      : r.built
        ? '<span class="badge text-bg-success">built</span>'
        : '<span class="badge text-bg-secondary">not built</span>';

  const meta = [];
  if (r.claudeVersion) meta.push(`claude ${escapeHtml(r.claudeVersion)}`);
  if (r.sizeBytes) meta.push(escapeHtml(fmtBytes(r.sizeBytes)));
  if (r.builtAt) meta.push(`built ${escapeHtml(fmtDate(r.builtAt))}`);

  const buildLabel = r.outdated ? 'Rebuild (context changed)' : r.built ? 'Rebuild' : 'Build';
  const actions = r.building
    ? `<button class="btn btn-sm btn-outline-info" type="button" data-job="${escapeHtml(r.jobId || '')}" ${r.jobId ? '' : 'disabled'}>View log</button>`
    : '<div class="btn-group btn-group-sm">' +
      `<button class="btn btn-outline-primary" type="button" data-build="${escapeHtml(r.name)}">${escapeHtml(buildLabel)}</button>` +
      '<button class="btn btn-outline-primary dropdown-toggle dropdown-toggle-split" type="button" data-bs-toggle="dropdown" aria-expanded="false"><span class="visually-hidden">More build options</span></button>' +
      '<ul class="dropdown-menu dropdown-menu-end">' +
      `<li><button class="dropdown-item" type="button" data-build="${escapeHtml(r.name)}" data-nocache="1">Build without cache</button></li>` +
      `<li><button class="dropdown-item" type="button" data-build="${escapeHtml(r.name)}" data-pull="1">Pull the base image first</button></li>` +
      '</ul></div>';

  return (
    '<div class="col-12 col-lg-6 col-xxl-4"><div class="card h-100 pc-recipe-card"><div class="card-body">' +
    `<div class="d-flex align-items-start gap-2"><h6 class="card-title mb-1 me-auto">${escapeHtml(r.title || r.name)}</h6>${state}</div>` +
    `<div class="small text-secondary font-monospace">${escapeHtml(r.imageRef || r.name)}</div>` +
    `<div class="small text-secondary">${escapeHtml(r.description || '')}</div>` +
    `<div class="small text-secondary mt-1">base: ${escapeHtml(r.baseImage || '-')}</div>` +
    (meta.length ? `<div class="small text-secondary">${meta.join(' · ')}</div>` : '') +
    `<div class="mt-2">${actions}</div>` +
    '</div></div></div>'
  );
}

/** Render #recipes-list from GET /api/images/recipes. */
export async function reloadRecipes() {
  const list = byId('recipes-list');
  if (!list) return;
  try {
    const res = await api.images.recipes();
    recipes = Array.isArray(res && res.recipes) ? res.recipes : [];
    list.innerHTML = recipes.length
      ? recipes.map(recipeCard).join('')
      : '<div class="col-12 text-secondary small">No recipes reported by the server.</div>';
  } catch (err) {
    recipes = [];
    const message = err && err.code === 'backend_not_configured'
      ? 'No Docker backend is configured yet - pick one under "Docker backend" first.'
      : `Could not load the recipes: ${escapeHtml((err && err.message) || 'unknown error')}`;
    list.innerHTML = `<div class="col-12"><div class="alert alert-warning py-2 small mb-0">${message}</div></div>`;
  }
}

/** GET /api/images/tools -> #tools-status. */
export async function reloadTools() {
  const el = byId('tools-status');
  if (!el) return;
  try {
    const res = await api.images.tools();
    const s = (res && res.status) || {};
    toolsStatus = s;
    if (s.syncing) {
      el.innerHTML =
        `<span class="spinner-border spinner-border-sm me-1"></span>syncing tools volume <code>${escapeHtml(s.volume || '')}</code>` +
        (s.jobId ? ` · <a href="#" data-job="${escapeHtml(s.jobId)}">view log</a>` : '');
    } else if (s.present) {
      const badge = s.outdated
        ? ' <span class="badge text-bg-warning">outdated</span>'
        : '';
      const hint = s.outdated
        ? '<div class="small text-secondary">the tools image no longer matches <code>docker/tools</code> - sync to rebuild it and refresh the volume</div>'
        : '';
      el.innerHTML =
        `tools volume <code>${escapeHtml(s.volume || '')}</code> · claude ${escapeHtml(s.claudeVersion || '?')} · synced ${escapeHtml(fmtDate(s.lastSyncedAt))}${badge}${hint}`;
    } else {
      el.innerHTML = `tools volume <code>${escapeHtml(s.volume || 'porterclaude-tools')}</code> is not populated - custom images cannot bootstrap Claude Code yet.`;
    }
  } catch (err) {
    toolsStatus = null;
    el.textContent = err && err.code === 'backend_not_configured'
      ? 'tools volume status unavailable (no Docker backend configured)'
      : `tools volume status unavailable: ${(err && err.message) || 'unknown error'}`;
  }
}

function jobRow(job) {
  const badge =
    job.status === 'running'
      ? 'text-bg-info'
      : job.status === 'success'
        ? 'text-bg-success'
        : job.status === 'cancelled'
          ? 'text-bg-secondary'
          : 'text-bg-danger';
  return (
    `<button type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-2" data-job="${escapeHtml(job.id)}">` +
    `<span class="badge ${badge}">${escapeHtml(job.status)}</span>` +
    `<span class="fw-semibold">${escapeHtml(job.kind)}</span>` +
    `<span class="text-secondary">${escapeHtml(job.target || '')}</span>` +
    `<span class="small text-secondary ms-auto">${escapeHtml(fmtDate(job.startedAt))} · ${escapeHtml(String(job.lineCount ?? 0))} lines</span>` +
    '</button>'
  );
}

/** GET /api/images/jobs -> #jobs-list (newest first, click opens #job-modal). */
export async function reloadJobs() {
  const list = byId('jobs-list');
  if (!list) return;
  try {
    const res = await api.images.jobs();
    const jobs = Array.isArray(res && res.jobs) ? res.jobs : [];
    list.innerHTML = jobs.length
      ? jobs.map(jobRow).join('')
      : '<div class="small text-secondary px-1">No jobs yet.</div>';
  } catch (err) {
    list.innerHTML = `<div class="small text-secondary px-1">${escapeHtml((err && err.message) || 'jobs unavailable')}</div>`;
  }
}

function appendJobLines(lines) {
  const body = byId('job-body');
  if (!body || !lines || !lines.length) return;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.textContent += `${lines.join('\n')}\n`;
  if (jobState.autoScroll && atBottom) body.scrollTop = body.scrollHeight;
}

function setJobTitle(job) {
  const title = byId('job-modal-title');
  if (title) title.textContent = job ? `${job.kind} ${job.target || ''} · ${job.status}` : 'Job';
  const cancel = byId('btn-job-cancel');
  if (cancel) cancel.disabled = !job || job.status !== 'running';
}

async function pollJob() {
  if (!jobState.id) return;
  try {
    const res = await api.images.job(jobState.id, jobState.cursor);
    const job = (res && res.job) || null;
    appendJobLines((res && res.lines) || []);
    if (res && typeof res.nextIndex === 'number') jobState.cursor = res.nextIndex;
    jobState.status = job ? job.status : null;
    setJobTitle(job);
    if (job && job.status === 'running') {
      jobState.timer = setTimeout(() => { void pollJob(); }, JOB_POLL_MS);
      return;
    }
    stopJobPoll();
    if (job && job.error) appendJobLines([`[${job.status}] ${job.error}`]);
    else if (job) appendJobLines([`[${job.status}]`]);
    await reloadRecipes();
    await reloadTools();
    await reloadJobs();
  } catch (err) {
    stopJobPoll();
    appendJobLines([`[error] ${(err && err.message) || 'job polling failed'}`]);
  }
}

/**
 * Open #job-modal and tail a job. The poll stops when the modal hides, when the job
 * finishes, and on hide()/AUTH_REQUIRED (settings.js calls hide()).
 * @param {string} jobId
 */
export function openJob(jobId) {
  if (!jobId) return;
  const modalEl = byId('job-modal');
  const body = byId('job-body');
  if (!modalEl || typeof bootstrap === 'undefined') return;
  stopJobPoll();
  jobState.id = jobId;
  jobState.cursor = 0;
  jobState.autoScroll = true;
  jobState.status = 'running';
  if (body) body.textContent = '';
  setJobTitle(null);
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
  void pollJob();
}

async function buildRecipe(name, opts) {
  try {
    const res = await api.images.buildRecipe(name, opts);
    const job = res && res.job;
    if (job && job.id) openJob(job.id);
    await reloadRecipes();
  } catch (err) {
    if (err && err.code === 'conflict') {
      // a build is already running: open its job instead of erroring
      await reloadRecipes();
      const running = recipes.find((r) => r.name === name && r.jobId);
      if (running) {
        openJob(running.jobId);
        return;
      }
      try {
        const res = await api.images.jobs();
        const jobs = (res && res.jobs) || [];
        const match = jobs.find((j) => j.target === name && j.status === 'running');
        if (match) {
          openJob(match.id);
          return;
        }
      } catch {
        /* fall through to the toast */
      }
    }
    toastError(err, `Could not build ${name}`);
  }
}

async function syncTools() {
  const btn = byId('btn-tools-sync');
  if (btn) btn.disabled = true;
  try {
    const res = await api.images.syncTools(false);
    const job = res && res.job;
    if (job && job.id) openJob(job.id);
    await reloadTools();
  } catch (err) {
    if (err && err.code === 'conflict' && toolsStatus && toolsStatus.jobId) {
      openJob(toolsStatus.jobId);
    } else {
      toastError(err, 'Could not sync the tools volume');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function cancelJob() {
  if (!jobState.id) return;
  try {
    await api.images.cancelJob(jobState.id);
    toast('Cancellation requested', { variant: 'info' });
  } catch (err) {
    toastError(err, 'Could not cancel the job');
  }
}

const imagesPanel = {
  async init(ctx) {
    void ctx;
    if (initialised) return;
    initialised = true;

    const refresh = byId('btn-images-refresh');
    if (refresh) {
      refresh.addEventListener('click', () => {
        void reloadRecipes();
        void reloadTools();
        void reloadJobs();
      });
    }
    const sync = byId('btn-tools-sync');
    if (sync) sync.addEventListener('click', () => { void syncTools(); });

    const cancel = byId('btn-job-cancel');
    if (cancel) cancel.addEventListener('click', () => { void cancelJob(); });

    const modalEl = byId('job-modal');
    if (modalEl) {
      modalEl.addEventListener('hidden.bs.modal', () => {
        stopJobPoll();
        jobState.id = null;
      });
    }

    const list = byId('recipes-list');
    if (list) {
      list.addEventListener('click', (e) => {
        const jobBtn = e.target.closest('[data-job]');
        if (jobBtn) {
          e.preventDefault();
          openJob(jobBtn.getAttribute('data-job'));
          return;
        }
        const buildBtn = e.target.closest('[data-build]');
        if (!buildBtn) return;
        const opts = {};
        if (buildBtn.getAttribute('data-nocache')) opts.noCache = true;
        if (buildBtn.getAttribute('data-pull')) opts.pull = true;
        void buildRecipe(buildBtn.getAttribute('data-build'), opts);
      });
    }

    const jobs = byId('jobs-list');
    if (jobs) {
      jobs.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-job]');
        if (btn) openJob(btn.getAttribute('data-job'));
      });
    }

    const tools = byId('tools-status');
    if (tools) {
      tools.addEventListener('click', (e) => {
        const link = e.target.closest('[data-job]');
        if (link) {
          e.preventDefault();
          openJob(link.getAttribute('data-job'));
        }
      });
    }
  },
  show() {
    void reloadRecipes();
    void reloadTools();
    void reloadJobs();
  },
  hide() {
    stopJobPoll();
  },
};

export default imagesPanel;
