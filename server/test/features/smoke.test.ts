// OWNER: B2. Feature tests: container spec building, session command matrix, recipe
// status logic, tar context hashing. All must run WITHOUT a docker host (stub DockerBackend).
//
// The real coverage lives next to this file:
//   container.test.ts        buildContainerSpec / workspaceMountFor / specHash
//   sessionCommand.test.ts   the six-row tmux x shell matrix + shell-quoting safety
//   containerService.test.ts create/update/remove/list/reconcile against a stub backend
//   sessionWs.test.ts        the websocket bridge (401 upgrade, ready, ping/pong, close codes)
//   tarContext.test.ts       build-context packing + deterministic hashing
//   imageService.test.ts     recipe statuses, job registry/cursor, tools sync
//   routes.test.ts           every /api/containers and /api/images route from api.md
import { describe, expect, it } from 'vitest';
import { RECIPES } from '../../src/images/recipes.js';
import { createImagesRouter } from '../../src/images/routes.js';
import { createContainersRouter } from '../../src/containers/routes.js';
import { attachSessionWs } from '../../src/sessions/ws.js';

describe('porterclaude containers/sessions/images', () => {
  it('exposes the feature entry points B1 wires up', () => {
    expect(typeof createContainersRouter).toBe('function');
    expect(typeof createImagesRouter).toBe('function');
    expect(typeof attachSessionWs).toBe('function');
  });

  it('knows the six recipes the orchestration topic ships', () => {
    expect(RECIPES.map((r) => r.name)).toEqual(['node', 'dotnet', 'php', 'python', 'go', 'base']);
  });
});
