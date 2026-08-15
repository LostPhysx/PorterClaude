// OWNER: B2. Session lifecycle. Public API FROZEN — terminals/ws.ts and routes depend on it.
import type { ServiceDeps } from '../context.js';
import type { SessionConfig, SessionInput, SessionView } from './model.js';

export interface RemoveOptions {
  /** also delete porterclaude-ws-<slug> / porterclaude-hist-<slug> */
  removeVolumes?: boolean;
  /** delete the stored config too (default true; false = keep definition, drop container) */
  forget?: boolean;
}

export interface ReconcileReport {
  known: number;
  running: number;
  /** containers labelled porterclaude.managed with no stored config */
  orphans: string[];
  /** stored sessions whose container is gone */
  missing: string[];
}

export class SessionService {
  constructor(private readonly deps: ServiceDeps) {}

  /** Stored configs merged with live container state. Never throws when the backend is
   *  down: returns configs with status 'absent' and a warning instead. TODO(B2) */
  async list(): Promise<SessionView[]> {
    throw new Error('TODO(B2)');
  }

  /** AppError.notFound when unknown. TODO(B2) */
  async get(name: string): Promise<SessionView> {
    throw new Error('TODO(B2)');
  }

  /**
   * Create: validate name is free (config + container), ensure volumes exist
   * (shared claude volumes, workspace volume, history volume), resolve the image
   * (recipe -> <ns>/<recipe>:latest, custom -> pull if absent), create the container,
   * start it when autoStart. Persists the config first so a failed docker create still
   * leaves an editable definition? NO -- persist only after a successful create, and roll
   * back the container on a persist failure. TODO(B2)
   */
  async create(input: SessionInput): Promise<SessionView> {
    throw new Error('TODO(B2)');
  }

  /** Edit = recreate: stop -> remove container (keep volumes) -> create -> start if it was
   *  running or autoStart. Named volumes and the workspace survive. TODO(B2) */
  async update(name: string, input: SessionInput): Promise<SessionView> {
    throw new Error('TODO(B2)');
  }

  /** Recreate from the stored config without changing it (e.g. after an image rebuild). TODO(B2) */
  async recreate(name: string): Promise<SessionView> {
    throw new Error('TODO(B2)');
  }

  async start(name: string): Promise<SessionView> { throw new Error('TODO(B2)'); }
  async stop(name: string): Promise<SessionView> { throw new Error('TODO(B2)'); }
  async restart(name: string): Promise<SessionView> { throw new Error('TODO(B2)'); }
  async remove(name: string, opts?: RemoveOptions): Promise<void> { throw new Error('TODO(B2)'); }

  async logs(name: string, opts?: { tail?: number; timestamps?: boolean }): Promise<string> {
    throw new Error('TODO(B2)');
  }

  /**
   * Rebuild the view from container labels: adopt containers labelled
   * porterclaude.managed=true that have no stored config (so /data loss is recoverable),
   * and flag stored sessions whose container disappeared. TODO(B2)
   */
  async reconcile(): Promise<ReconcileReport> {
    throw new Error('TODO(B2)');
  }

  /**
   * FROZEN SIGNATURE — used by TerminalService. Resolves a session name to a RUNNING
   * container id. Throws AppError.notFound / AppError.conflict('session not running').
   */
  async requireRunningContainer(name: string): Promise<{ containerId: string; config: SessionConfig }> {
    throw new Error('TODO(B2)');
  }

  /** Ensure the shared claude volumes exist on the current backend (idempotent). TODO(B2) */
  async ensureSharedVolumes(): Promise<void> {
    throw new Error('TODO(B2)');
  }
}
