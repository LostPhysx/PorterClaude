// OWNER: F1. Settings tab: backend picker (portainer|socket), general config, account,
// plus the Images sub-panel which lives in ./images.js (same package, same owner).
// CROSS-PACKAGE CONTRACT (FROZEN):
//   * after every successful GET/PUT of settings, emit
//     bus.emit(EVENTS.SETTINGS_CHANGED, { settings }) with the full SanitizedSettings object
//   * getSettings() returns the last known SanitizedSettings (or null) - F2 reads
//     `settings.ui.layout` from it on first paint.
import { api } from './api.js';
import { bus, EVENTS } from './bus.js';
import { byId, toast, toastError, escapeHtml, fmtBytes } from './util.js';
import imagesPanel from './images.js';

/** @type {any|null} */
let settings = null;

/** FROZEN: F2 reads ui.layout / ui.theme from here. @returns {any|null} SanitizedSettings */
export function getSettings() {
  return settings;
}

/** GET /api/settings -> store + render + emit SETTINGS_CHANGED. TODO(F1) */
export async function reload() {
  throw new Error('TODO(F1): implement settings reload()');
}

/**
 * TODO(F1) backend panel:
 *  - radios toggle #backend-socket-fields / #backend-portainer-fields
 *  - #socket-available-hint shows "detected" when settings.backend.socketAvailable
 *  - the API key field stays EMPTY; #portainer-key-hint shows "stored ...a1b2" when
 *    apiKeySet. Sending an empty apiKey means "keep the stored key" -> omit the property.
 *  - #btn-backend-test -> POST /api/settings/backend/test with the CURRENT form values
 *    (never saves). On ok:true render info (name/serverVersion/os/architecture/ncpu/
 *    memTotalBytes/containers) and, for portainer, fill #portainer-endpoint from
 *    `endpoints[]` (label "<name> (#<id>)"). On ok:false render the error.
 *  - #btn-backend-save -> PUT /api/settings/backend, then reload() and toast.
 *  - endpoint list can also be refreshed alone via POST /api/settings/backend/endpoints.
 */
function renderBackend() {
  throw new Error('TODO(F1): implement renderBackend()');
}

/**
 * TODO(F1) general panel: build #general-form inputs for every GeneralConfig key -
 * workspacesRoot, sharedClaudeVolume, sharedClaudeHomeVolume, toolsVolume, defaultRecipe
 * (<select> of recipes), containerPrefix, sessionNetwork, imageNamespace, containerHome,
 * workspaceMount, toolsMount. Save with PUT /api/settings/general (partial is fine).
 */
function renderGeneral() {
  throw new Error('TODO(F1): implement renderGeneral()');
}

/**
 * TODO(F1) account panel: #password-form -> POST /api/settings/password (min 8 chars,
 * confirm client-side), #theme-select -> app.applyTheme + PUT /api/settings/ui {theme}.
 */
function renderAccount() {
  throw new Error('TODO(F1): implement renderAccount()');
}

/** Sub-tab switcher for #settings-subtabs / .pc-subview. TODO(F1) */
function showSubtab(name) {
  void name;
  throw new Error('TODO(F1): implement showSubtab()');
}

/** @type {import('./app.js').ViewModule} */
const settingsView = {
  /** TODO(F1): wire sub-tabs + forms, `await imagesPanel.init(ctx)`, first reload(). */
  async init(ctx) {
    void ctx;
    throw new Error('TODO(F1): implement settingsView.init()');
  },
  /** TODO(F1): reload() and imagesPanel.show() when the images sub-tab is active. */
  show() { throw new Error('TODO(F1): implement settingsView.show()'); },
  hide() { /* TODO(F1): stop the images job poll via imagesPanel.hide() */ },
  refresh() { void reload(); },
};

export default settingsView;

void api; void bus; void EVENTS; void byId; void toast; void toastError; void escapeHtml;
void fmtBytes; void imagesPanel; void renderBackend; void renderGeneral; void renderAccount; void showSubtab;
