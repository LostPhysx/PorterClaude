// OWNER: v0.4 profiles (issue #2). Mounted at /api/profiles behind requireAuth.
// Flat like /api/agents: profile ids are install-global, not host-scoped.
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../http/async.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { DEFAULT_LOGIN_SET, agentLoginVolumeFor, loginSetFor } from '../agents/model.js';
import { ProfileInputSchema } from './model.js';
import { verifyProfile } from './verify.js';

const IdParams = z.object({ id: z.string().min(1).max(64) });

/** `POST /api/profiles/:id/verify` — which container to run the read-only probes in. */
const VerifyBodySchema = z.object({ container: z.string().min(1).max(128) });

/**
 * Query flags. NOT `z.coerce.boolean()`: it is truthy-string coercion, so `?force=0` and
 * `?force=false` would both mean TRUE — the opposite of what the caller wrote.
 */
const FlagSchema = z
  .enum(['1', '0', 'true', 'false', 'yes', 'no'])
  .optional()
  .transform((v) => v === '1' || v === 'true' || v === 'yes');

const ForceQuery = z.object({
  force: FlagSchema,
  /** additionally remove the login-set volumes this profile is the SOLE owner of, on every
   *  reachable host, best effort. The default set and any set another profile references
   *  are never removed — see `removableVolumesFor`. */
  removeVolumes: FlagSchema,
});

/**
 * GET    /api/profiles           -> { profiles: SanitizedProfile[] }
 * POST   /api/profiles           ProfileInput -> 201 { profile }
 * GET    /api/profiles/:id       -> { profile } | 404
 * PUT    /api/profiles/:id       ProfileInput (omit a secret key to keep it) -> { profile }
 * POST   /api/profiles/:id/verify { container } -> { report } (read-only CLI probe, #4)
 * DELETE /api/profiles/:id       -> 204 | 409 { containers: [names] } while in use
 *                                  ?force=1 strips profileId from those containers first;
 *                                  &removeVolumes=1 also deletes the implicit volumes.
 */
export function createProfilesRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json({ profiles: ctx.profiles.list() });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = parseBody(ProfileInputSchema, req);
      res.status(201).json({ profile: await ctx.profiles.create(input) });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(IdParams, req);
      res.json({ profile: ctx.profiles.require(id) });
    }),
  );

  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(IdParams, req);
      const input = parseBody(ProfileInputSchema, req);
      res.json({ profile: await ctx.profiles.update(id, input) });
    }),
  );

  /**
   * v0.4 (#4): ask the claude CLI inside a RUNNING container whether it actually supports
   * what this profile assumes. Strictly read only, and the response never carries a byte of
   * the managed settings file beyond its top-level key names (profiles/verify.ts).
   */
  router.post(
    '/:id/verify',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(IdParams, req);
      const { container } = parseBody(VerifyBodySchema, req);
      res.json({ report: await verifyProfile(ctx, id, container) });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(IdParams, req);
      // the flags live in the QUERY STRING; parseParams would read req.params (only `id`)
      // and silently default both to false
      const query = parseQuery(ForceQuery, req);
      const profile = ctx.profiles.stored(id);
      // which login sets this profile is the sole owner of must be decided BEFORE the
      // profile is gone (the answer depends on the other stored profiles)
      const removable = query.removeVolumes && profile ? removableSetsFor(ctx, profile) : [];

      await ctx.profiles.remove(id, { force: query.force });

      for (const host of ctx.hosts.list()) {
        if (removable.length === 0) break;
        // the volume prefix is a per-host setting (hosts may override it)
        const prefix = ctx.hosts.settingsFor(host.id).volumePrefix;
        for (const { agentId, loginSet } of removable) {
          const volume = agentLoginVolumeFor(prefix, agentId, loginSet);
          try {
            await ctx.hosts.backendFor(host.id).removeVolume(volume, { force: true });
          } catch (err) {
            // best effort per VOLUME, not per host: one volume still in use must not skip
            // the rest. An unreachable host keeps its volumes (they stay labelled).
            ctx.log.warn(
              { hostId: host.id, volume, err: (err as Error).message },
              'could not remove a profile login-set volume',
            );
          }
        }
      }
      res.status(204).end();
    }),
  );

  return router;
}

/**
 * The (agent, loginSet) pairs whose volume belongs to THIS profile alone, i.e. what
 * `?removeVolumes=1` may delete. Deliberately conservative — deleting a login volume
 * destroys an agent login, its history and its plugins:
 *
 *   * the `default` set is never removable (it is the host-wide v0.2 volume every
 *     unprofiled container mounts);
 *   * a set ANY other stored profile still resolves to is never removable, whether it
 *     names the set explicitly or inherits it as its own implicit set.
 */
function removableSetsFor(
  ctx: AppContext,
  profile: { id: string; agents: Record<string, { loginSet: string | null }> },
): Array<{ agentId: string; loginSet: string }> {
  const others = ctx.profiles.list().filter((p) => p.id !== profile.id);
  const out: Array<{ agentId: string; loginSet: string }> = [];

  for (const agentId of Object.keys(profile.agents)) {
    const loginSet = loginSetFor(profile.id, profile, agentId);
    if (loginSet === DEFAULT_LOGIN_SET) continue;
    const usedByAnotherProfile = others.some((other) => {
      // `other.agents` only lists the agents that profile configures; an agent it does not
      // mention resolves to `default`, which is already excluded above.
      if (!other.agents[agentId]) return false;
      return loginSetFor(other.id, other as never, agentId) === loginSet;
    });
    if (!usedByAnotherProfile) out.push({ agentId, loginSet });
  }
  return out;
}
