// OWNER: B1. AgentRegistry: built-ins ∪ custom definitions, and how they resolve per
// host / per session (that resolution is what sessions/container.ts mounts).
import { describe, it, expect, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { buildContext } from './helpers.js';
import { BUILTIN_AGENTS, DEFAULT_ENABLED_AGENT_IDS } from '../../src/agents/builtin.js';
import {
  AgentDefinitionInputSchema,
  AgentDefinitionSchema,
  agentAuthVolumeFor,
  agentDataDir,
  agentHistoryTarget,
  agentLinks,
  agentPathSlug,
} from '../../src/agents/model.js';
import type { AgentDefinition } from '../../src/agents/model.js';
import type { AppContext } from '../../src/context.js';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await (closers.pop() as () => Promise<void>)();
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true });
});

async function ctxFor(): Promise<AppContext> {
  const built = await buildContext();
  dirs.push(built.dataDir);
  closers.push(async () => {
    await built.ctx.hosts.close().catch(() => undefined);
  });
  return built.ctx;
}

const custom: AgentDefinition = {
  id: 'mycoder',
  name: 'My Coder',
  command: 'mycoder',
  args: ['--no-color'],
  versionCommand: ['mycoder', '--version'],
  install: { kind: 'npm', package: 'mycoder' },
  sharedPaths: [
    { path: '~/.mycoder', kind: 'dir' },
    { path: '~/.config/mycoder', kind: 'dir' },
  ],
  historyPath: '~/.mycoder/chats',
  env: {},
};

async function hostWith(ctx: AppContext, agents: string[]): Promise<ReturnType<AppContext['hosts']['require']>> {
  await ctx.hosts.create({
    name: 'Local',
    connection: { type: 'socket', socketPath: '/x.sock' },
    agents,
  });
  return ctx.hosts.require('local');
}

describe('AgentRegistry', () => {
  it('lists the built-ins first and marks custom definitions', async () => {
    const ctx = await ctxFor();
    expect(ctx.agents.list().map((a) => a.id)).toEqual(BUILTIN_AGENTS.map((a) => a.id));
    expect(ctx.agents.list().every((a) => a.builtin)).toBe(true);
    expect(DEFAULT_ENABLED_AGENT_IDS).toEqual(['claude']);

    await ctx.agents.create(custom);
    const list = ctx.agents.list();
    expect(list.at(-1)).toMatchObject({ id: 'mycoder', builtin: false });
    expect(ctx.agents.get('mycoder')?.command).toBe('mycoder');
    expect(ctx.agents.isBuiltin('mycoder')).toBe(false);
    expect(ctx.agents.isBuiltin('claude')).toBe(true);
    expect(ctx.agents.require('claude').command).toBe('claude');
    expect(() => ctx.agents.require('nope')).toThrow(/unknown agent/);
  });

  it('refuses an id that collides with a built-in and two shared paths with the same slug', async () => {
    const ctx = await ctxFor();
    await expect(ctx.agents.create({ ...custom, id: 'claude' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await ctx.agents.create(custom);
    await expect(ctx.agents.create(custom)).rejects.toMatchObject({ code: 'conflict' });

    await expect(
      ctx.agents.create({
        ...custom,
        id: 'dupe',
        sharedPaths: [
          { path: '~/.dupe', kind: 'dir' },
          { path: '~/dupe', kind: 'file' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('never edits or deletes a built-in', async () => {
    const ctx = await ctxFor();
    await expect(ctx.agents.update('claude', { ...custom, id: 'claude' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(ctx.agents.remove('claude')).rejects.toMatchObject({ code: 'conflict' });
    await expect(ctx.agents.update('nope', { ...custom, id: 'nope' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('updates a custom agent but keeps its id immutable', async () => {
    const ctx = await ctxFor();
    await ctx.agents.create(custom);
    const updated = await ctx.agents.update('mycoder', { ...custom, name: 'Renamed' });
    expect(updated).toMatchObject({ id: 'mycoder', name: 'Renamed', builtin: false });
    await expect(ctx.agents.update('mycoder', { ...custom, id: 'other' })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('blocks a delete while it is in use and strips the id everywhere with force', async () => {
    const ctx = await ctxFor();
    await ctx.agents.create(custom);
    await hostWith(ctx, ['claude', 'mycoder']);
    await ctx.config.putSession({
      name: 'web',
      hostId: 'local',
      agents: ['claude', 'mycoder'],
      image: { type: 'recipe', recipe: 'node' },
      workspace: { type: 'volume' },
      env: {},
      ports: [],
      extraMounts: [],
      limits: {},
      shareHistory: true,
      autoStart: true,
      network: null,
      user: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await expect(ctx.agents.remove('mycoder')).rejects.toMatchObject({ code: 'conflict' });
    await ctx.agents.remove('mycoder', { force: true });
    expect(ctx.agents.get('mycoder')).toBeNull();
    expect(ctx.hosts.require('local').agents.enabled).toEqual(['claude']);
    expect(ctx.config.getSession('web')?.agents).toEqual(['claude']);
  });

  it('resolves the agents of a host and of a session, sorted and filtered to known ids', async () => {
    const ctx = await ctxFor();
    await ctx.agents.create(custom);
    const host = await hostWith(ctx, ['opencode', 'claude', 'ghost']);

    expect(ctx.agents.enabledForHost(host).map((a) => a.id)).toEqual(['claude', 'opencode']);
    expect(ctx.agents.resolveForSession(host, { agents: null }).map((a) => a.id)).toEqual([
      'claude',
      'opencode',
    ]);
    // an explicit session list wins over the host's, unknown ids are dropped
    expect(
      ctx.agents.resolveForSession(host, { agents: ['mycoder', 'gone', 'claude'] }).map((a) => a.id),
    ).toEqual(['claude', 'mycoder']);
    expect(ctx.agents.resolveForSession(host, { agents: [] })).toEqual([]);

    expect(ctx.agents.installSpecsForHost(host)).toEqual([
      {
        id: 'claude',
        command: 'claude',
        install: { kind: 'script', url: 'https://claude.ai/install.sh', binPath: 'bin/claude' },
        versionCommand: ['claude', '--version'],
      },
      {
        id: 'opencode',
        command: 'opencode',
        install: { kind: 'script', url: 'https://opencode.ai/install', binPath: 'bin/opencode' },
        versionCommand: ['opencode', '--version'],
      },
    ]);
  });
});

describe('agent layout helpers (the naming contract with B2)', () => {
  it('derives the auth volume, the agent dir and the symlinks', () => {
    expect(agentAuthVolumeFor('porterclaude-', 'claude')).toBe('porterclaude-auth-claude');
    expect(agentDataDir('/home/dev', 'claude')).toBe('/home/dev/.porterclaude/agents/claude');
    expect(agentPathSlug('~/.local/share/opencode')).toBe('local-share-opencode');
    expect(agentPathSlug('~/.claude.json')).toBe('claude.json');

    const claude = BUILTIN_AGENTS.find((a) => a.id === 'claude') as AgentDefinition;
    expect(agentLinks(claude, '/home/dev')).toEqual([
      { target: '/home/dev/.claude', source: '/home/dev/.porterclaude/agents/claude/claude', kind: 'dir' },
      {
        target: '/home/dev/.claude.json',
        source: '/home/dev/.porterclaude/agents/claude/claude.json',
        kind: 'file',
      },
    ]);
    // the private history volume mounts INSIDE the agent volume, never through the symlink
    expect(agentHistoryTarget(claude, '/home/dev')).toBe(
      '/home/dev/.porterclaude/agents/claude/claude/projects',
    );
  });
});

// ---------------------------------------------------------------------------
// QA R1-INT2-4 / R2-INT2-7: the API input schema is stricter than the STORED one on
// purpose — tightening the stored shape would drop definitions an older build accepted
// (ConfigStore.dropInvalidCustomAgents) and take the agent away from every host that
// enables it.
// ---------------------------------------------------------------------------
describe('AgentDefinition schemas', () => {
  const lax = {
    ...custom,
    command: 'my coder',
    sharedPaths: [{ path: '~/.my coder', kind: 'dir' as const }],
    historyPath: '~/.other/hist',
    env: { 'BAD KEY': '1' },
  };

  it('keeps loading a stored definition the API would refuse today', () => {
    expect(AgentDefinitionSchema.safeParse(lax).success).toBe(true);
    expect(AgentDefinitionInputSchema.safeParse(lax).success).toBe(false);
  });

  it('accepts every built-in definition as API input', () => {
    for (const builtin of BUILTIN_AGENTS) {
      const parsed = AgentDefinitionInputSchema.safeParse(builtin);
      expect(parsed.success, `${builtin.id}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
    }
  });

  it('names the offending field', () => {
    const parsed = AgentDefinitionInputSchema.safeParse({ ...custom, historyPath: '~/.elsewhere/x' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['historyPath']);
  });
});
