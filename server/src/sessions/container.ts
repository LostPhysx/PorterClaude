// OWNER: B2. Pure translation SessionConfig -> CreateContainerSpec. No I/O, no docker
// calls: this file must stay unit-testable without a docker host.
import type { CreateContainerSpec, MountSpec } from '../backends/types.js';
import type { GeneralConfig } from '../config/schema.js';
import type { SessionConfig } from './model.js';

export interface BuildSpecInput {
  session: SessionConfig;
  general: GeneralConfig;
  /** concrete image ref: recipes resolve to <imageNamespace>/<recipe>:latest */
  resolvedImage: string;
  /** custom images get the tools-volume bootstrap entrypoint */
  imageType: 'recipe' | 'custom';
}

/**
 * Contract (docs/design/backend.md "Container layout"):
 *   name        <containerPrefix><session>            e.g. pc-web
 *   labels      porterclaude.managed=true
 *               porterclaude.session=<slug>
 *               porterclaude.image-type=recipe|custom
 *               porterclaude.recipe=<name>            (recipes only)
 *               porterclaude.spec-hash=<sha256>
 *               porterclaude.created-at=<iso>
 *   mounts      <sharedClaudeVolume>      -> <containerHome>/.claude
 *               <sharedClaudeHomeVolume>  -> <containerHome>/.claude-home
 *               workspace                 -> <workspaceMount>            (bind or volume)
 *               <toolsVolume> (ro)        -> <toolsMount>                (custom images only)
 *               porterclaude-hist-<slug>  -> <containerHome>/.claude/projects  (shareHistory=false)
 *               ...extraMounts
 *   env         PORTERCLAUDE_SESSION=<slug>, TERM=xterm-256color, ...session.env
 *               custom images additionally: PORTERCLAUDE_TOOLS=<toolsMount>,
 *               PORTERCLAUDE_HOME=<containerHome>
 *   custom      entrypoint ["<toolsMount>/entrypoint.sh"], cmd ["sleep","infinity"]
 *   recipes     entrypoint/cmd left to the image
 *   workingDir  <workspaceMount>;  init true;  tty false;  pidsLimit 4096
 *   restart     autoStart ? 'unless-stopped' : 'no'
 *   resources   cpus -> NanoCpus, memoryMb -> Memory
 * TODO(B2)
 */
export function buildContainerSpec(input: BuildSpecInput): CreateContainerSpec {
  throw new Error('TODO(B2): implement buildContainerSpec');
}

/** The workspace mount for a session (creating the volume is the service's job). TODO(B2) */
export function workspaceMountFor(session: SessionConfig, general: GeneralConfig): MountSpec {
  throw new Error('TODO(B2)');
}

/**
 * Stable sha256 over the fields that require a container recreate (image, mounts, env,
 * ports, limits, user, network, shareHistory). Stored in the porterclaude.spec-hash label;
 * SessionView.needsRecreate compares the stored config's hash with the container's label.
 * TODO(B2)
 */
export function specHash(spec: CreateContainerSpec): string {
  throw new Error('TODO(B2)');
}
