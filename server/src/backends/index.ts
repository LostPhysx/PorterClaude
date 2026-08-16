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
 * TODO(B1): move the body of the old `BackendManager.test()` here (it already had the
 * portainer-endpoint fallback and the "log the message, never the api key" rule).
 */
export async function testConnection(
  conn: ResolvedConnection,
  deps: { log: Logger },
): Promise<BackendTestResult> {
  void conn;
  void deps;
  throw new Error('TODO(B1): testConnection');
}

/**
 * Portainer endpoint picker used by the credentials screen and by
 * `POST /api/credentials/portainer/:id/import`.
 *
 * TODO(B1): build a PortainerBackend (endpointId 0 is fine, the call does not use it),
 * `listEndpoints()`, close it in a finally.
 */
export async function listPortainerEndpoints(cred: {
  url: string;
  apiKey: string;
  insecureTls?: boolean;
}): Promise<PortainerEndpoint[]> {
  void cred;
  throw new Error('TODO(B1): listPortainerEndpoints');
}

/** `SocketBackend.isAvailable`, re-exported so routes do not import the transport directly. */
export async function socketAvailable(socketPath: string): Promise<boolean> {
  return SocketBackend.isAvailable(socketPath);
}

export { PortainerBackend, SocketBackend };
