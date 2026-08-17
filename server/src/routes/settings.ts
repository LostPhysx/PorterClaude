// OWNER: B1. Mounted at /api/settings behind requireAuth.
//
// v0.2: the backend section is GONE from here. Connections live at /api/hosts (+
// /api/credentials); what is left is the global defaults (general), the UI state and the
// password. `general` is still the base every host inherits — a host may override any of
// its fields (hosts/model.ts HostOverridesSchema).
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { vendorMountResults } from '../vendor.js';
import type { VendorMountResult } from '../vendor.js';
import { asyncHandler } from '../http/async.js';
import { parseBody } from '../http/validate.js';
import {
  GeneralSettingsInputSchema,
  PasswordChangeInputSchema,
  UiSettingsInputSchema,
} from '../config/schema.js';
import type { SanitizedSettings } from '../config/schema.js';
import { socketAvailable } from '../backends/index.js';
import { AUTH_COOKIE, shouldUseSecureCookie } from '../auth/index.js';

/**
 * GET  /api/settings                      -> SanitizedSettings
 * PUT  /api/settings/general              GeneralSettingsInput (partial) -> SanitizedSettings
 * PUT  /api/settings/ui                   { layout?, theme? } -> { ui }
 * POST /api/settings/password             { currentPassword, newPassword } -> { ok: true } + fresh cookie
 * GET  /api/settings/vendor               -> { routes: VendorMountResult[] }  (debug aid)
 *
 * REMOVED in v0.2 (see api.md "v0.2 change list"):
 *   PUT  /api/settings/backend            -> POST/PUT /api/hosts[/:hostId]
 *   POST /api/settings/backend/test       -> POST /api/hosts/test | /api/hosts/:hostId/test
 *   POST /api/settings/backend/endpoints  -> GET  /api/credentials/portainer/:id/endpoints
 */
export function createSettingsRouter(ctx: AppContext, vendor?: VendorMountResult[]): Router {
  const router = Router();

  const sanitized = async (): Promise<SanitizedSettings> => {
    const available = await socketAvailable(ctx.env.DOCKER_SOCKET);
    return ctx.config.sanitized({ socketAvailable: available });
  };

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json(await sanitized());
    }),
  );

  router.get('/vendor', (_req, res) => {
    res.json({ routes: vendor ?? vendorMountResults(ctx.paths) });
  });

  router.put(
    '/general',
    asyncHandler(async (req, res) => {
      const input = parseBody(GeneralSettingsInputSchema, req);
      await ctx.config.update((draft) => {
        draft.general = { ...draft.general, ...input };
      });
      res.json(await sanitized());
    }),
  );

  router.put(
    '/ui',
    asyncHandler(async (req, res) => {
      const input = parseBody(UiSettingsInputSchema, req);
      // `layout` is z.unknown(): only touch it when the client actually sent the key.
      const sentLayout = Object.prototype.hasOwnProperty.call((req.body ?? {}) as object, 'layout');
      const next = await ctx.config.update((draft) => {
        if (sentLayout) draft.ui.layout = input.layout ?? null;
        if (input.theme !== undefined) draft.ui.theme = input.theme;
      });
      res.json({ ui: { layout: next.ui.layout ?? null, theme: next.ui.theme } });
    }),
  );

  router.post(
    '/password',
    asyncHandler(async (req, res) => {
      const input = parseBody(PasswordChangeInputSchema, req);
      await ctx.auth.changePassword(input.currentPassword, input.newPassword);
      const secure = shouldUseSecureCookie(ctx, req as unknown as { secure?: boolean; headers: Record<string, unknown> });
      res.cookie(AUTH_COOKIE, ctx.auth.issueToken(), ctx.auth.cookieOptions(secure));
      res.json({ ok: true });
    }),
  );

  return router;
}
