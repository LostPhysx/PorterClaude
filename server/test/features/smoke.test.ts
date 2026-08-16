// OWNER: B2. Feature tests: container spec building, terminal command matrix, recipe
// status logic, tar context hashing. All must run WITHOUT a docker host (stub DockerBackend).
//
// The real coverage lives next to this file:
//   container.test.ts       buildContainerSpec / workspaceMountFor / specHash
//   terminalCommand.test.ts the six-row tmux x shell matrix + shell-quoting safety
//   sessionService.test.ts  create/update/remove/list/reconcile against a stub backend
//   terminalWs.test.ts      the websocket bridge (401 upgrade, ready, ping/pong, close codes)
//   tarContext.test.ts      build-context packing + deterministic hashing
//   imageService.test.ts    recipe statuses, job registry/cursor, tools sync
//   routes.test.ts          every /api/sessions and /api/images route from api.md
import { describe, expect, it } from 'vitest';
import { RECIPES } from '../../src/images/recipes.js';
import { createImagesRouter } from '../../src/images/routes.js';
import { createSessionsRouter } from '../../src/sessions/routes.js';
import { attachTerminalWs } from '../../src/terminals/ws.js';

describe('porterclaude sessions/terminals/images', () => {
  it('exposes the feature entry points B1 wires up', () => {
    expect(typeof createSessionsRouter).toBe('function');
    expect(typeof createImagesRouter).toBe('function');
    expect(typeof attachTerminalWs).toBe('function');
  });

  it('knows the six recipes the orchestration topic ships', () => {
    expect(RECIPES.map((r) => r.name)).toEqual(['node', 'dotnet', 'php', 'python', 'go', 'base']);
  });
});
