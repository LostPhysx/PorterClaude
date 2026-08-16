// OWNER: B1. v0.2: the single global `BackendManager` is GONE — hosts own their backends
// (hosts/manager.ts, per-host instance cache). What is left here is the transport factory
// plus the two probe helpers that need to know about Portainer specifics.
//
// ADDING A CONNECTION TYPE is local to two places: `HostConnectionSchema` (hosts/model.ts)
// and the switch in `createBackend()` below. Nothing else in the server branches on it.
import type { Logger } from '../logger.js';
import { AppError } from '../http/errors.js';
import { PortainerBackend } from './portainer.js';
import { SocketBackend } from './socket.js';
import type { BackendTestResult, DockerBackend, PortainerEndpoint } from './types.js';

export * from './types.js';

/**
 * A host connection with every secret already resolved. `HostManager` builds this from
 * `HostConfig.connection` + the referenced credential; nothing below it reads the config.
 */
export type ResolvedConnection =
  | { type: 'socket'; socketPath: string }
  | { type: 'portainer'; url: string; apiKey: string; endpointId: number; insecureTls: boolean }
  /** RESERVED (hosts/model.ts): accepted by the schema, refused here with `not_implemented` */
  | { type: 'tcp'; url: string; insecureTls: boolean }
  | { type: 'ssh'; url: string; socketPath: string };

/**
 * Build a transport for one resolved connection. Never cached here — `HostManager` owns the
 * per-host cache and the lifecycle (invalidate on config change, close on shutdown).
 *
 * @throws AppError.notImplemented for a connection type this version cannot talk to.
 */
export function createBackend(conn: ResolvedConnection): DockerBackend {
  switch (conn.type) {
    case 'socket':
      return new SocketBackend({ socketPath: conn.socketPath });
    case 'portainer':
      return new PortainerBackend({
        url: conn.url,
        apiKey: conn.apiKey,
        endpointId: conn.endpointId,
        insecureTls: conn.insecureTls,
      });
    case 'tcp':
    case 'ssh':
      throw AppError.notImplemented(
        `connection type '${conn.type}' is reserved for a later release and cannot be used yet`,
      );
    default: {
      const exhaustive: never = conn;
      throw AppError.badRequest(`unknown connection type ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * `info()` (and, for portainer, the endpoint list) on a throw-away transport. NEVER throws
 * for connection problems: a failure is reported as `{ ok:false, error }` so the Settings /
 * Hosts screens can show it inline. Always closes the backend it built.
 *
 * The api key is never part of the result and never logged - only the error message is.
 */
export async function testConnection(
  conn: ResolvedConnection,
  deps: { log: Logger },
): Promise<BackendTestResult> {
  let backend: DockerBackend | null = null;
  try {
    backend = createBackend(conn);
    const info = await backend.info();
    const result: BackendTestResult = { ok: true, info };
    if (conn.type === 'portainer' && backend instanceof PortainerBackend) {
      try {
        result.endpoints = await backend.listEndpoints();
      } catch (err) {
        deps.log.warn(
          { err: (err as Error).message },
          'portainer endpoint listing failed during test',
        );
        result.endpoints = [];
      }
    }
    return result;
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_implemented') throw err;
    const e = err as { code?: string; message?: string };
    deps.log.warn({ type: conn.type, err: e.message }, 'host connection test failed');
    return {
      ok: false,
      error: {
        code: typeof e.code === 'string' ? e.code : 'backend_error',
        message: e.message ?? String(err),
      },
    };
  } finally {
    await backend?.close().catch(() => undefined);
  }
}

/**
 * Portainer endpoint picker used by the credentials screen and by
 * `POST /api/credentials/portainer/:id/import`.
 */
export async function listPortainerEndpoints(cred: {
  url: string;
  apiKey: string;
  insecureTls?: boolean;
}): Promise<PortainerEndpoint[]> {
  if (!cred.url) throw AppError.badRequest('a portainer url is required');
  if (!cred.apiKey) throw AppError.badRequest('a portainer api key is required');
  // endpointId is irrelevant for /api/endpoints, but the transport wants one
  const backend = new PortainerBackend({
    url: cred.url,
    apiKey: cred.apiKey,
    endpointId: 0,
    insecureTls: cred.insecureTls ?? false,
  });
  try {
    return await backend.listEndpoints();
  } finally {
    await backend.close().catch(() => undefined);
  }
}

/** `SocketBackend.isAvailable`, re-exported so routes do not import the transport directly. */
export async function socketAvailable(socketPath: string): Promise<boolean> {
  return SocketBackend.isAvailable(socketPath);
}

export { PortainerBackend, SocketBackend };
