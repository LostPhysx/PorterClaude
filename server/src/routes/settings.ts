// OWNER: B1. Mounted at /api/settings behind requireAuth.
import { Router } from 'express';
import type { AppContext } from '../context.js';
import type { VendorMountResult } from '../vendor.js';

/**
 * GET  /api/settings                      -> SanitizedSettings
 * PUT  /api/settings/backend              BackendSettingsInput -> SanitizedSettings
 *        - portainer.apiKey omitted keeps the stored key; empty string clears it
 *        - persists, then ctx.backends.invalidate()
 * POST /api/settings/backend/test         BackendTestInput -> BackendTestResult (always 200)
 * POST /api/settings/backend/endpoints    { url?, apiKey?, insecureTls? } -> { endpoints: PortainerEndpoint[] }
 * PUT  /api/settings/general              GeneralSettingsInput (partial) -> SanitizedSettings
 * PUT  /api/settings/ui                   { layout?, theme? } -> UiConfig
 * POST /api/settings/password             { currentPassword, newPassword } -> { ok: true } + fresh cookie
 * GET  /api/settings/vendor               -> { routes: VendorMountResult[] }  (debug aid)
 * TODO(B1)
 */
export function createSettingsRouter(ctx: AppContext, vendor?: VendorMountResult[]): Router {
  throw new Error('TODO(B1): implement createSettingsRouter');
}
