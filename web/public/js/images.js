// OWNER: F1. Settings -> Images sub-panel: recipe list, builds, job log polling and the
// tools volume (which in v0.2 is what installs the CODING AGENTS). Not a top-level view;
// settings.js drives its lifecycle.
//
// v0.2: everything here is PER HOST. `#images-host-select` picks it, the choice is
// remembered in localStorage, and every call goes to `/api/hosts/:hostId/images/...`.
// Job ids stay globally unique, but a job of another host answers 404 - so the host id is
// part of the job-tail state as well (`openJob(hostId, jobId)`).
import { api } from './api.js';
import { byId, toast, toastError, escapeHtml, fmtBytes, fmtDate, storage, LS_PREFIX } from './util.js';
import { getHosts, resolveHostId, hostOptionsHtml } from './hosts.js';

/** Poll interval for a running job (api.md: builds are polled, not streamed). */
export const JOB_POLL_MS = 1000;

/** localStorage key remembering which host the Images panel is pointed at. */
export const LS_IMAGES_HOST = `${LS_PREFIX}images.host`;

/** @type {any[]} */
let recipes = [];
/** @type {any|null} ToolsStatus of the selected host */
let toolsStatus = null;
/** @type {string} the host this panel is pointed at ('' when there is no host yet) */
let hostId = '';
let initialised = false;

/** job modal state (hostId is part of it: `/api/hosts/:hostId/images/jobs/:id`) */
const jobState = { hostId: '', id: null, cursor: 0, timer: null, autoScroll: true, status: null };

/** The host the panel currently shows. @returns {string} */
export function currentHostId() {
  return hostId;
}

/**
 * TODO(F1): fill #images-host-select with hostOptionsHtml(hostId) (no "All hosts" entry -
 * builds always target exactly one engine), preselect resolveHostId(storage.get(...)),
 * persist the choice under LS_IMAGES_HOST and reload the panel on change. With no host at
 * all: disable the select and render "No Docker host yet - add one under Settings -> Hosts"
 * into #tools-status, #tools-agents and #recipes-list instead of firing requests.
 */
export function renderHostSelect() {
  void getHosts;
  void resolveHostId;
  void hostOptionsHtml;
  // TODO(F1)
}

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

/** Render #recipes-list from GET /api/hosts/:hostId/images/recipes. */
export async function reloadRecipes() {
  const list = byId('recipes-list');
  if (!list) return;
  if (!hostId) {
    recipes = [];
    list.innerHTML = '<div class="col-12 text-secondary small">Pick a host first.</div>';
    return;
  }
  try {
    const res = await api.images.recipes(hostId);
    recipes = Array.isArray(res && res.recipes) ? res.recipes : [];
    list.innerHTML = recipes.length
      ? recipes.map(recipeCard).join('')
      : '<div class="col-12 text-secondary small">No recipes reported by the server.</div>';
  } catch (err) {
    recipes = [];
    // v0.2 copy: it is THIS host that has no usable connection, not "the backend".
    const message = err && err.code === 'backend_not_configured'
      ? 'This host has no usable connection yet - fix it under "Hosts".'
      : `Could not load the recipes: ${escapeHtml((err && err.message) || 'unknown error')}`;
    list.innerHTML = `<div class="col-12"><div class="alert alert-warning py-2 small mb-0">${message}</div></div>`;
  }
}

/**
 * TODO(F1): render #tools-agents from `ToolsStatus.agents` (AgentToolStatus[]): a small
 * table with one row per agent - the agent id in monospace (ids are the API identity; this
 * module deliberately does NOT import agents.js, see the module graph in frontend.md 12.2),
 * an "installed <version>" success badge / "not installed" secondary badge / the `error`
 * string in danger, and fmtDate(installedAt). Below it a one-liner:
 *   "Agents are installed into the tools volume of THIS host. There is no sync between
 *    hosts: every host needs its own login."
 * When `agents` is empty: "no agents installed yet - enable them under Agents, then sync".
 */
export function renderToolsAgents() {
  // TODO(F1)
}

/** GET /api/hosts/:hostId/images/tools -> #tools-status (+ renderToolsAgents). */
export async function reloadTools() {
  const el = byId('tools-status');
  if (!el) return;
  if (!hostId) {
    toolsStatus = null;
    el.textContent = 'Pick a host first.';
    return;
  }
  try {
    const res = await api.images.tools(hostId);
    const s = (res && res.status) || {};
    toolsStatus = s;
    if (s.syncing) {
      el.innerHTML =
        `<span class="spinner-border spinner-border-sm me-1"></span>syncing tools volume <code>${escapeHtml(s.volume || '')}</code>` +
        (s.jobId ? ` · <a href="#" data-job="${escapeHtml(s.jobId)}">view log</a>` : '');
    } else if (s.present) {
      const badge = s.outdated ? ' <span class="badge text-bg-warning">outdated</span>' : '';
      const hint = s.outdated
        ? '<div class="small text-secondary">the tools image no longer matches <code>docker/tools</code> - sync to rebuild it and refresh the volume</div>'
        : '';
      const installed = Array.isArray(s.agents) ? s.agents.filter((a) => a && a.installed).length : 0;
      el.innerHTML =
        `tools volume <code>${escapeHtml(s.volume || '')}</code> · ${escapeHtml(String(installed))} agent(s) installed · synced ${escapeHtml(fmtDate(s.lastSyncedAt))}${badge}${hint}`;
    } else {
      el.innerHTML = `tools volume <code>${escapeHtml(s.volume || 'porterclaude-tools')}</code> is not populated - sessions on this host have no coding agent yet.`;
    }
  } catch (err) {
    toolsStatus = null;
    el.textContent = err && err.code === 'backend_not_configured'
      ? 'tools volume status unavailable (this host has no usable connection)'
      : `tools volume status unavailable: ${(err && err.message) || 'unknown error'}`;
  }
  renderToolsAgents();
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

/** GET /api/hosts/:hostId/images/jobs -> #jobs-list (newest first, click opens #job-modal). */
export async function reloadJobs() {
  const list = byId('jobs-list');
  if (!list) return;
  if (!hostId) {
    list.innerHTML = '';
    return;
  }
  try {
    const res = await api.images.jobs(hostId);
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
  if (!jobState.id || !jobState.hostId) return;
  try {
    const res = await api.images.job(jobState.hostId, jobState.id, jobState.cursor);
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
 * Open #job-modal and tail a job of `jobHostId`. The poll stops when the modal hides, when
 * the job finishes, and on hide()/AUTH_REQUIRED (settings.js calls hide()).
 * Exported because agents.js opens the tools-sync job from the Agents panel.
 * @param {string} jobHostId
 * @param {string} jobId
 */
export function openJob(jobHostId, jobId) {
  if (!jobId || !jobHostId) return;
  const modalEl = byId('job-modal');
  const body = byId('job-body');
  if (!modalEl || typeof bootstrap === 'undefined') return;
  stopJobPoll();
  jobState.hostId = jobHostId;
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
    const res = await api.images.buildRecipe(hostId, name, opts);
    const job = res && res.job;
    if (job && job.id) openJob(hostId, job.id);
    await reloadRecipes();
  } catch (err) {
    if (err && err.code === 'conflict') {
      // a build is already running ON THIS HOST: open its job instead of erroring
      await reloadRecipes();
      const running = recipes.find((r) => r.name === name && r.jobId);
      if (running) {
        openJob(hostId, running.jobId);
        return;
      }
      try {
        const res = await api.images.jobs(hostId);
        const jobs = (res && res.jobs) || [];
        const match = jobs.find((j) => j.target === name && j.status === 'running');
        if (match) {
          openJob(hostId, match.id);
          return;
        }
      } catch {
        /* fall through to the toast */
      }
    }
    toastError(err, `Could not build ${name}`);
  }
}

/**
 * Sync the tools volume of the selected host: this is what installs/updates the coding
 * agents enabled on it. Exported so agents.js can trigger the same flow.
 * @returns {Promise<void>}
 */
export async function syncTools() {
  const btn = byId('btn-tools-sync');
  if (!hostId) {
    toast('Pick a host first.', { variant: 'warning' });
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const res = await api.images.syncTools(hostId, false);
    const job = res && res.job;
    if (job && job.id) openJob(hostId, job.id);
    await reloadTools();
  } catch (err) {
    if (err && err.code === 'conflict' && toolsStatus && toolsStatus.jobId) {
      openJob(hostId, toolsStatus.jobId);
    } else {
      toastError(err, 'Could not sync the tools volume');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function cancelJob() {
  if (!jobState.id || !jobState.hostId) return;
  try {
    await api.images.cancelJob(jobState.hostId, jobState.id);
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

    // TODO(F1): wire #images-host-select (change -> hostId = value, storage.set(
    //   LS_IMAGES_HOST, value), reload everything) and subscribe to EVENTS.HOSTS_CHANGED so
    //   the select follows host CRUD. `hostId` must never stay '' while a host exists.
    void storage;
    void LS_IMAGES_HOST;

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
          openJob(hostId, jobBtn.getAttribute('data-job'));
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
        if (btn) openJob(hostId, btn.getAttribute('data-job'));
      });
    }

    const tools = byId('tools-status');
    if (tools) {
      tools.addEventListener('click', (e) => {
        const link = e.target.closest('[data-job]');
        if (link) {
          e.preventDefault();
          openJob(hostId, link.getAttribute('data-job'));
        }
      });
    }
  },
  show() {
    renderHostSelect();
    void reloadRecipes();
    void reloadTools();
    void reloadJobs();
  },
  hide() {
    stopJobPoll();
  },
};

export default imagesPanel;
