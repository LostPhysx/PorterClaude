// OWNER: F1. Settings -> Images sub-panel: recipe list, builds, job log polling,
// tools-volume sync. Not a top-level view; settings.js drives its lifecycle.
import { api } from './api.js';
import { byId, toast, toastError, escapeHtml, fmtBytes, fmtDate } from './util.js';

/** Poll interval for a running job (api.md: builds are polled, not streamed). */
export const JOB_POLL_MS = 1000;

/**
 * TODO(F1): render #recipes-list from GET /api/images/recipes - one card per recipe with
 * title, baseImage, size, builtAt, claudeVersion and a state pill:
 *   building -> spinner + "View log" (opens #job-modal on job.id)
 *   !built   -> "Build"
 *   outdated -> warning "Rebuild (context changed)"
 *   built    -> "Rebuild" (dropdown: no-cache / pull base)
 * Build -> POST /api/images/recipes/:name/build -> 202 {job} -> openJob(job.id).
 * 409 conflict means a build is already running: just open its job instead of erroring.
 */
export async function reloadRecipes() {
  throw new Error('TODO(F1): implement reloadRecipes()');
}

/**
 * TODO(F1): GET /api/images/tools -> #tools-status line
 * ("tools volume porterclaude-tools - claude 1.2.3, synced <date>" / "not populated").
 * #btn-tools-sync -> POST /api/images/tools/sync -> openJob(job.id).
 */
export async function reloadTools() {
  throw new Error('TODO(F1): implement reloadTools()');
}

/** TODO(F1): GET /api/images/jobs -> #jobs-list (newest first, click opens #job-modal). */
export async function reloadJobs() {
  throw new Error('TODO(F1): implement reloadJobs()');
}

/**
 * Open #job-modal and tail a job.
 * TODO(F1): poll GET /api/images/jobs/:id?since=<cursor> every JOB_POLL_MS while
 * status === 'running'; append `lines` to #job-body, keep the cursor from `nextIndex`,
 * auto-scroll unless the user scrolled up. Stop on finished/failed/cancelled, then
 * reloadRecipes(). #btn-job-cancel -> POST /api/images/jobs/:id/cancel.
 * The poll MUST stop when the modal hides and on hide()/AUTH_REQUIRED.
 * @param {string} jobId
 */
export function openJob(jobId) {
  void jobId;
  throw new Error('TODO(F1): implement openJob()');
}

const imagesPanel = {
  /** TODO(F1): wire #btn-images-refresh / #btn-tools-sync / #btn-job-cancel. */
  async init(ctx) { void ctx; throw new Error('TODO(F1): implement imagesPanel.init()'); },
  /** TODO(F1): reloadRecipes() + reloadTools() + reloadJobs(). */
  show() { throw new Error('TODO(F1): implement imagesPanel.show()'); },
  /** TODO(F1): clear the job poll timer. */
  hide() {},
};

export default imagesPanel;

void api; void byId; void toast; void toastError; void escapeHtml; void fmtBytes; void fmtDate;
