// OWNER: B2. Feature tests: container spec building, terminal command matrix, recipe
// status logic, tar context hashing. All must run WITHOUT a docker host (stub DockerBackend).
import { describe, it, expect } from 'vitest';

describe('porterclaude sessions/terminals/images', () => {
  it('placeholder until B2 implements the feature package', () => {
    expect(true).toBe(true);
  });
});

// TODO(B2):
//  - buildContainerSpec: labels, shared claude mounts, workspace volume naming,
//    custom-image entrypoint override + tools mount, shareHistory=false extra volume,
//    cpus/memory translation, restart policy
//  - specHash is stable across key order and changes when the image changes
//  - buildTerminalCommand covers all 6 combinations (tmux x shell, no-tmux fallbacks)
//    and shell-quotes the terminal name
//  - SessionService.list with a stubbed backend merges config + containers, marks orphans
//    and needsRecreate
//  - hashContext is deterministic and changes when a context file changes
