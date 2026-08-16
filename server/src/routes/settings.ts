// OWNER: B1. Mounted at /api/settings behind requireAuth.
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { vendorMountResults } from '../vendor.js';
import type { VendorMountResult } from '../vendor.js';
import { asyncHandler } from '../http/async.js';
import { parseBody } from '../http/validate.js';
import {
  BackendSettingsInputSchema,
  BackendTestInputSchema,
  GeneralSettingsInputSchema,
  PasswordChangeInputSchema,
  PortainerEndpointsInputSchema,
  UiSettingsInputSchema,
} from '../config/schema.js';
import type { SanitizedSettings } from '../config/schema.js';
import { SocketBackend } from '../backends/socket.js';
import { SESSION_COOKIE, shouldUseSecureCookie } from '../auth/index.js';

/**
 * GET  /api/settings                      -> SanitizedSettings
 * PUT  /api/settings/backend              BackendSettingsInput -> SanitizedSettings
 *        - portainer.apiKey omitted keeps the stored key; switching kind away from
 *          portainer clears it (api.md: the key can never be read back or blanked)
 *        - persists, then ctx.backends.invalidate()
 * POST /api/settings/backend/test         BackendTestInput -> BackendTestResult (always 200)
 * POST /api/settings/backend/endpoints    { url?, apiKey?, insecureTls? } -> { endpoints }
 * PUT  /api/settings/general              GeneralSettingsInput (partial) -> SanitizedSettings
 * PUT  /api/settings/ui                   { layout?, theme? } -> { ui }
 * POST /api/settings/password             { currentPassword, newPassword } -> { ok: true } + fresh cookie
 * GET  /api/settings/vendor               -> { routes: VendorMountResult[] }  (debug aid)
 */
export function createSettingsRouter(ctx: AppContext, vendor?: VendorMountResult[]): Router {
  const router = Router();

  const sanitized = async (): Promise<SanitizedSettings> => {
    const socketPath = ctx.config.get().backend.socket.socketPath || ctx.env.DOCKER_SOCKET;
    const socketAvailable = await SocketBackend.isAvailable(socketPath);
    return ctx.config.sanitized({ socketAvailable });
  };

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json(await sanitized());
    }),
  );

  // --- literal sub-routes first --------------------------------------------

  router.get('/vendor', (_req, res) => {
    res.json({ routes: vendor ?? vendorMountResults(ctx.paths) });
  });

  router.put(
    '/backend',
    asyncHandler(async (req, res) => {
      const input = parseBody(BackendSettingsInputSchema, req);
      const apiKeyEnc =
        input.kind === 'portainer' && input.portainer?.apiKey
          ? ctx.secrets.encrypt(input.portainer.apiKey)
          : null;

      await ctx.config.update((draft) => {
        draft.backend.kind = input.kind;
        if (input.portainer) {
          draft.backend.portainer.url = input.portainer.url.replace(/\/+$/, '');
          if (input.portainer.endpointId !== undefined) {
            draft.backend.portainer.endpointId = input.portainer.endpointId;
          }
          if (input.portainer.insecureTls !== undefined) {
            draft.backend.portainer.insecureTls = input.portainer.insecureTls;
          }
        }
        if (input.socket?.socketPath) draft.backend.socket.socketPath = input.socket.socketPath;

        if (input.kind === 'portainer') {
          // omitted apiKey => keep whatever is stored
          if (apiKeyEnc) draft.backend.portainer.apiKeyEnc = apiKeyEnc;
        } else {
          // switching away from portainer is the documented way to clear the key
          draft.backend.portainer.apiKeyEnc = null;
        }
      });

      ctx.backends.invalidate();
      res.json(await sanitized());
    }),
  );

  router.post(
    '/backend/test',
    asyncHandler(async (req, res) => {
      const input = parseBody(BackendTestInputSchema, req);
      const result = await ctx.backends.test({
        kind: input.kind,
        portainer: input.portainer
          ? {
              url: input.portainer.url,
              apiKey: input.portainer.apiKey,
              endpointId: input.portainer.endpointId ?? undefined,
              insecureTls: input.portainer.insecureTls,
            }
          : undefined,
        socket: input.socket,
      });
      res.json(result);
    }),
  );

  router.post(
    '/backend/endpoints',
    asyncHandler(async (req, res) => {
      const input = parseBody(PortainerEndpointsInputSchema, req);
      const endpoints = await ctx.backends.listPortainerEndpoints({
        url: input.url ?? '',
        apiKey: input.apiKey,
        insecureTls: input.insecureTls,
      });
      res.json({ endpoints });
    }),
  );

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
      res.cookie(SESSION_COOKIE, ctx.auth.issueToken(), ctx.auth.cookieOptions(secure));
      res.json({ ok: true });
    }),
  );

  return router;
}
