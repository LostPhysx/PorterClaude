// OWNER: B2. Turns "session + shell" into a live ExecStream. No websocket knowledge here.
import type { ServiceDeps } from '../context.js';
import type { ExecStream } from '../backends/types.js';
import type { SessionService } from '../sessions/service.js';
import type { TerminalShell } from './protocol.js';

export interface OpenTerminalInput {
  session: string;
  shell: TerminalShell;
  /** stable pane name -> tmux session pc_<name> */
  name: string;
  cols: number;
  rows: number;
}

export interface OpenTerminalResult {
  terminalId: string;
  stream: ExecStream;
  containerId: string;
  tmux: boolean;
  reattached: boolean;
}

export class TerminalService {
  constructor(private readonly deps: ServiceDeps, private readonly sessions: SessionService) {}

  /**
   * 1. sessions.requireRunningContainer(session)
   * 2. hasTmux(containerId) (cached ~60s per container id)
   * 3. build the command (see buildTerminalCommand)
   * 4. backend.execCreate({ tty: true, attachStdin/out/err: true, env: TERM/COLORTERM/LANG,
   *    workingDir: /workspace, user: session.user ?? undefined })
   * 5. backend.execStart(execId, { tty: true, stdin: true })
   * 6. best-effort backend.execResize(execId, {cols, rows}) right after start
   * TODO(B2)
   */
  async open(input: OpenTerminalInput): Promise<OpenTerminalResult> {
    throw new Error('TODO(B2)');
  }

  /** `command -v tmux` probe, cached per container id. TODO(B2) */
  async hasTmux(containerId: string): Promise<boolean> {
    throw new Error('TODO(B2)');
  }

  /** true when a tmux session named pc_<name> already exists (drives `reattached`). TODO(B2) */
  async tmuxSessionExists(containerId: string, terminalName: string): Promise<boolean> {
    throw new Error('TODO(B2)');
  }

  /** Track open streams so shutdown can close them. TODO(B2) */
  register(terminalId: string, stream: ExecStream): void { throw new Error('TODO(B2)'); }
  unregister(terminalId: string): void { throw new Error('TODO(B2)'); }
  count(): number { throw new Error('TODO(B2)'); }
  closeAll(): void { throw new Error('TODO(B2)'); }
}

/**
 * Command matrix (docs/design/backend.md "Terminal command"):
 *   tmux + bash    sh -lc "exec tmux new-session -A -s pc_<name> bash -l"
 *   tmux + claude  sh -lc "exec tmux new-session -A -s pc_<name> sh -lc 'claude; exec bash -l'"
 *   tmux + sh      sh -lc "exec tmux new-session -A -s pc_<name> sh -l"
 *   no tmux bash   ["bash","-l"]  (fall back to ["sh","-l"] when bash is missing)
 *   no tmux claude ["sh","-lc","claude; exec bash -l"]
 * Quote every interpolated value with shQuote() from util/slug.js.
 * TODO(B2)
 */
export function buildTerminalCommand(opts: { shell: TerminalShell; name: string; tmux: boolean; hasBash: boolean }): string[] {
  throw new Error('TODO(B2)');
}
