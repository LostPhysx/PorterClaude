// OWNER: B2. ImageService: recipe statuses, job registry/cursor, tools sync (stub backend).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImageService, parseAgentManifest, parseClaudeVersion } from '../../src/images/service.js';
import { RECIPES } from '../../src/images/recipes.js';
import { IMAGE_LABELS } from '../../src/sessions/model.js';
import { hashContext } from '../../src/images/tarContext.js';
import {
  generalConfig,
  hostConfig,
  imageInspect,
  otherHostConfig,
  serviceDeps,
  stubBackend,
  stubHostManager,
  stubHosts,
  stubConfigStore,
  testPaths,
  TEST_HOST_ID,
} from './helpers.js';
import { TOOLS_AGENTS_ENV } from '../../src/agents/model.js';
import { stubAgentRegistry } from './helpers.js';

let dockerDir: string;

async function makeDockerDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-img-'));
  await fs.mkdir(path.join(root, 'recipes', 'node'), { recursive: true });
  await fs.writeFile(path.join(root, 'recipes', 'common.sh'), '#!/bin/sh\n');
  await fs.writeFile(path.join(root, 'recipes', 'node', 'Dockerfile'), 'FROM node:22-bookworm\n');
  await fs.mkdir(path.join(root, 'tools'), { recursive: true });
  await fs.writeFile(path.join(root, 'tools', 'Dockerfile'), 'FROM alpine\n');
  return root;
}

function imagePaths() {
  return testPaths({
    dockerDir,
    recipesDir: path.join(dockerDir, 'recipes'),
    toolsDir: path.join(dockerDir, 'tools'),
  });
}

function makeService(backend = stubBackend(), opts: { host?: ReturnType<typeof hostConfig> } = {}) {
  const cfg = stubConfigStore([]);
  const hosts = stubHostManager(backend.backend, opts.host ? { host: opts.host } : {});
  const service = new ImageService(serviceDeps({ config: cfg.store, hosts, paths: imagePaths() }));
  return { service, sb: backend };
}

/** two hosts with their own engines - jobs, images and tools volumes are per host. */
function makeTwoHosts() {
  const cfg = stubConfigStore([]);
  const home = stubBackend();
  const edge = stubBackend();
  const hosts = stubHosts([
    { host: hostConfig(), backend: home.backend },
    { host: otherHostConfig(), backend: edge.backend, general: generalConfig({ volumePrefix: 'edge-' }) },
  ]);
  const service = new ImageService(serviceDeps({ config: cfg.store, hosts, paths: imagePaths() }));
  return { service, home, edge };
}

async function settle(service: ImageService, jobId: string, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    const job = service.getJob(jobId);
    if (job && job.status !== 'running' && job.status !== 'queued') return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  dockerDir = await makeDockerDir();
});

afterEach(async () => {
  await fs.rm(dockerDir, { recursive: true, force: true });
});

describe('recipeStatuses', () => {
  it('lists every recipe with built:false when nothing is built', async () => {
    const { service } = makeService();
    const statuses = await service.recipeStatuses(TEST_HOST_ID);
    expect(statuses.map((s) => s.name)).toEqual(RECIPES.map((r) => r.name));
    expect(statuses.every((s) => !s.built && !s.outdated && !s.building)).toBe(true);
    expect(statuses[0]?.imageRef).toBe('porterclaude/node:latest');
  });

  it('reports built + outdated from the context-hash label', async () => {
    const { service, sb } = makeService();
    const hash = await hashContext({
      dir: path.join(dockerDir, 'recipes', 'node'),
      extraFiles: [{ source: path.join(dockerDir, 'recipes', 'common.sh'), name: 'common.sh' }],
    });
    sb.images.set(
      'porterclaude/node:latest',
      imageInspect({
        labels: {
          [IMAGE_LABELS.contextHash]: hash,
          [IMAGE_LABELS.claudeVersion]: '1.2.3',
          [IMAGE_LABELS.builtAt]: '2026-02-02T00:00:00.000Z',
        },
      }),
    );
    const node = (await service.recipeStatuses(TEST_HOST_ID)).find((s) => s.name === 'node');
    expect(node?.built).toBe(true);
    expect(node?.outdated).toBe(false);
    // the label only says WHAT WAS REQUESTED; the installed version is read from the image
    expect(node?.claudeChannel).toBe('1.2.3');
    // the engine's image Created is the build FINISH time; the legacy built-at label
    // (build start) is only a fallback for images built before this changed
    expect(node?.builtAt).toBe('2026-01-01T00:00:00.000Z');

    sb.images.set('porterclaude/node:latest', imageInspect({ labels: { [IMAGE_LABELS.contextHash]: 'stale' } }));
    expect((await service.recipeStatuses(TEST_HOST_ID)).find((s) => s.name === 'node')?.outdated).toBe(true);
  });
});

describe('the image a rebuild replaces', () => {
  // Re-tagging <ns>/<name>:latest leaves the previous image untagged; nothing else ever
  // removes it, so a few rebuild cycles used to fill the host's disk (1-2 GB each).
  function movingTagBackend(opts: { staleTags?: string[]; removeFails?: boolean } = {}) {
    const removed: string[] = [];
    let current = imageInspect({ id: 'sha256:old', tags: ['porterclaude/node:latest'] });
    const sb = stubBackend({
      inspectImage: async (ref: string) => {
        if (ref === 'porterclaude/node:latest') return current;
        if (ref === 'sha256:old') return imageInspect({ id: 'sha256:old', tags: opts.staleTags ?? [] });
        return null;
      },
      buildImage: async () => {
        current = imageInspect({ id: 'sha256:new', tags: ['porterclaude/node:latest'] });
      },
      removeImage: async (ref: string) => {
        if (opts.removeFails) throw new Error('conflict: image is being used by container abc');
        removed.push(ref);
      },
    });
    return { sb, removed };
  }

  it('removes the now-untagged image after a successful rebuild', async () => {
    const { sb, removed } = movingTagBackend();
    const { service } = makeService(sb);
    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    await settle(service, job.id);
    expect(service.getJob(job.id)?.status).toBe('success');
    expect(removed).toEqual(['sha256:old']);
  });

  it('keeps it when another tag still references it', async () => {
    const { sb, removed } = movingTagBackend({ staleTags: ['porterclaude/node:keepme'] });
    const { service } = makeService(sb);
    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    await settle(service, job.id);
    expect(service.getJob(job.id)?.status).toBe('success');
    expect(removed).toEqual([]);
  });

  it('does not fail the build when the old image is still in use', async () => {
    const { sb } = movingTagBackend({ removeFails: true });
    const { service } = makeService(sb);
    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    await settle(service, job.id);
    const done = service.getJob(job.id);
    expect(done?.status).toBe('success');
    expect(service.getJobLines(job.id).lines.join(' ')).toContain('still in use');
  });
});

describe('buildRecipe', () => {
  it('builds the tagged image with the porterclaude labels', async () => {
    const { service, sb } = makeService();
    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    expect(job.kind).toBe('build');
    expect(job.target).toBe('node');
    await settle(service, job.id);

    const build = sb.log.find((c) => c.method === 'buildImage');
    const opts = build?.args[0] as { tag: string; labels: Record<string, string> };
    expect(opts.tag).toBe('porterclaude/node:latest');
    expect(opts.labels[IMAGE_LABELS.recipe]).toBe('node');
    expect(opts.labels[IMAGE_LABELS.contextHash]).toMatch(/^[0-9a-f]{64}$/);
    // no built-at label: it changed on every rebuild and therefore produced a new image id
    // even for a fully cached build (INT-01)
    expect(opts.labels[IMAGE_LABELS.builtAt]).toBeUndefined();
    expect(service.getJob(job.id)?.status).toBe('success');
  });

  it('404s an unknown recipe', async () => {
    const { service } = makeService();
    await expect(service.buildRecipe(TEST_HOST_ID, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('409s while a build for the same recipe is running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const backend = stubBackend({ buildImage: async () => gate });
    const { service } = makeService(backend);

    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    await expect(service.buildRecipe(TEST_HOST_ID, 'node')).rejects.toMatchObject({ code: 'conflict' });
    release();
    await settle(service, job.id);
    expect(service.getJob(job.id)?.status).toBe('success');
  });

  it('fails the job with a clear message when the context is missing', async () => {
    const { service } = makeService();
    await fs.rm(path.join(dockerDir, 'recipes', 'node'), { recursive: true, force: true });
    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    await settle(service, job.id);
    const finished = service.getJob(job.id);
    expect(finished?.status).toBe('error');
    expect(finished?.error).toContain('does not exist');
  });
});

/** hash of the temporary node recipe context (dir + common.sh), as the service computes it. */
async function nodeContextHash(): Promise<string> {
  return hashContext({
    dir: path.join(dockerDir, 'recipes', 'node'),
    extraFiles: [{ source: path.join(dockerDir, 'recipes', 'common.sh'), name: 'common.sh' }],
  });
}

describe('a rebuild whose context did not change (INT-01)', () => {
  // A fully cached rebuild used to produce a NEW image id (the built-at label changed),
  // which untagged the image every existing session runs.
  it('skips the build and leaves the image alone', async () => {
    const { service, sb } = makeService();
    sb.images.set(
      'porterclaude/node:latest',
      imageInspect({ id: 'sha256:built', labels: { [IMAGE_LABELS.contextHash]: await nodeContextHash() } }),
    );

    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    await settle(service, job.id);

    expect(service.getJob(job.id)?.status).toBe('success');
    expect(sb.calls).not.toContain('buildImage');
    expect(sb.calls).not.toContain('removeImage');
    expect(service.getJobLines(job.id).lines.join(' ')).toContain('up to date');
    expect((await service.recipeStatuses(TEST_HOST_ID)).find((s) => s.name === 'node')?.imageId).toBe('sha256:built');
  });

  it.each([{ force: true }, { noCache: true }, { pull: true }])('builds anyway with %o', async (opts) => {
    const { service, sb } = makeService();
    sb.images.set(
      'porterclaude/node:latest',
      imageInspect({ id: 'sha256:built', labels: { [IMAGE_LABELS.contextHash]: await nodeContextHash() } }),
    );
    const job = await service.buildRecipe(TEST_HOST_ID, 'node', opts);
    await settle(service, job.id);
    expect(service.getJob(job.id)?.status).toBe('success');
    expect(sb.calls).toContain('buildImage');
  });

  it('builds when the context hash moved on', async () => {
    const { service, sb } = makeService();
    sb.images.set('porterclaude/node:latest', imageInspect({ labels: { [IMAGE_LABELS.contextHash]: 'stale' } }));
    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    await settle(service, job.id);
    expect(sb.calls).toContain('buildImage');
  });
});

describe('the claude version an image really ships (INT-02)', () => {
  /** a backend whose build produces an image and whose containers print `version`. */
  function versionBackend(version: string, opts: { logMarker?: string } = {}) {
    const sb = stubBackend({
      buildImage: async (build) => {
        if (opts.logMarker) build.onLog?.({ stream: `${opts.logMarker}\n` });
        sb.images.set(build.tag, imageInspect({ id: 'sha256:new', tags: [build.tag] }));
      },
      containerLogs: async () => version,
    });
    return sb;
  }

  it('reads it out of the built image with a one-shot container', async () => {
    const sb = versionBackend('2.1.233 (Claude Code)');
    const { service } = makeService(sb);
    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    await settle(service, job.id);

    const created = sb.log.find((c) => c.method === 'createContainer')?.args[0] as {
      image: string;
      cmd: string[];
    };
    expect(created.image).toBe('sha256:new');
    expect(created.cmd.join(' ')).toContain('/etc/porterclaude/claude-version');
    expect(sb.calls).toContain('removeContainer');
    expect(service.getJobLines(job.id).lines.join(' ')).toContain('claude version: 2.1.233');

    const node = (await service.recipeStatuses(TEST_HOST_ID)).find((s) => s.name === 'node');
    expect(node?.claudeVersion).toBe('2.1.233');
  });

  it('takes it from the build output when the build printed it (no extra container)', async () => {
    const sb = versionBackend('unused', { logMarker: '[porterclaude] PORTERCLAUDE_CLAUDE_VERSION=2.1.233' });
    const { service } = makeService(sb);
    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    await settle(service, job.id);

    expect(sb.calls).not.toContain('createContainer');
    expect((await service.recipeStatuses(TEST_HOST_ID)).find((s) => s.name === 'node')?.claudeVersion).toBe('2.1.233');
  });

  it('reads an image built by an earlier process in the background', async () => {
    const sb = versionBackend('2.1.233');
    const { service } = makeService(sb);
    sb.images.set('porterclaude/node:latest', imageInspect({ id: 'sha256:old-build' }));

    // the first call must not block on a container: it answers null and starts the read
    expect((await service.recipeStatuses(TEST_HOST_ID)).find((s) => s.name === 'node')?.claudeVersion).toBeNull();

    let version: string | null = null;
    for (let i = 0; i < 50 && version === null; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      version = (await service.recipeStatuses(TEST_HOST_ID)).find((s) => s.name === 'node')?.claudeVersion ?? null;
    }
    expect(version).toBe('2.1.233');
    // …and it is cached: repeated polling does not start a container per poll
    const containers = sb.calls.filter((c) => c === 'createContainer').length;
    await service.recipeStatuses(TEST_HOST_ID);
    expect(sb.calls.filter((c) => c === 'createContainer').length).toBe(containers);
  });

  it('stays null when the image records no version', async () => {
    const sb = versionBackend('cat: /etc/porterclaude/claude-version: No such file');
    const { service } = makeService(sb);
    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    await settle(service, job.id);
    expect((await service.recipeStatuses(TEST_HOST_ID)).find((s) => s.name === 'node')?.claudeVersion).toBeNull();
    expect(service.getJobLines(job.id).lines.join(' ')).toContain('could not read the claude version');
  });
});

describe('parseClaudeVersion', () => {
  it.each([
    ['2.1.233\n', '2.1.233'],
    ['2.1.233 (Claude Code)', '2.1.233'],
    ['      2.1.233', '2.1.233'],
    ['1.0.0-beta.2', '1.0.0-beta.2'],
  ])('reads %j as %j', (raw, expected) => {
    expect(parseClaudeVersion(raw)).toBe(expected);
  });

  it.each(['', '\n\n', 'log output', 'cat: no such file'])('ignores %j', (raw) => {
    expect(parseClaudeVersion(raw)).toBeNull();
  });
});

describe('job registry', () => {
  it('exposes an append-only cursor via since/nextIndex', async () => {
    const { service } = makeService(
      stubBackend({
        buildImage: async (opts) => {
          opts.onLog?.({ stream: 'step 1\n' });
          opts.onLog?.({ stream: 'step 2\n' });
          opts.onLog?.({ status: 'Downloading', id: 'abc', progress: '50%' });
        },
      }),
    );
    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    await settle(service, job.id);

    const all = service.getJobLines(job.id, 0);
    expect(all.lines.length).toBe(all.nextIndex);
    expect(all.lines).toContain('step 1');
    expect(all.lines).toContain('abc: Downloading 50%');

    const tail = service.getJobLines(job.id, all.nextIndex - 1);
    expect(tail.lines).toEqual([all.lines[all.lines.length - 1]]);
    expect(tail.nextIndex).toBe(all.nextIndex);

    expect(service.getJobLines(job.id, all.nextIndex).lines).toEqual([]);
  });

  it('caps the log at 2000 lines while keeping the cursor monotonic', async () => {
    const { service } = makeService(
      stubBackend({
        buildImage: async (opts) => {
          for (let i = 0; i < 2500; i += 1) opts.onLog?.({ stream: `line ${i}\n` });
        },
      }),
    );
    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    await settle(service, job.id);
    const result = service.getJobLines(job.id, 0);
    expect(result.lines.length).toBeLessThanOrEqual(2000);
    expect(result.nextIndex).toBeGreaterThanOrEqual(2500);
    expect(service.getJob(job.id)?.lineCount).toBe(result.nextIndex);
  });

  it('cancels a running job and 404s an unknown one', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { service } = makeService(stubBackend({ buildImage: async () => gate }));
    const job = await service.buildRecipe(TEST_HOST_ID, 'node');
    expect(service.cancelJob(job.id).status).toBe('cancelled');
    release();
    expect(() => service.cancelJob('missing')).toThrow();
    expect(() => service.getJobLines('missing')).toThrow();
    expect(service.getJob('missing')).toBeNull();
  });

  it('lists jobs newest first', async () => {
    const { service } = makeService();
    const first = await service.buildRecipe(TEST_HOST_ID, 'node');
    await settle(service, first.id);
    const second = await service.pull(TEST_HOST_ID, 'nginx:1.27');
    await settle(service, second.id);
    const jobs = service.listJobs(TEST_HOST_ID);
    expect(jobs[0]?.id).toBe(second.id);
    expect(jobs[1]?.id).toBe(first.id);
    expect(jobs.every((j) => j.hostId === TEST_HOST_ID)).toBe(true);
  });
});

describe('syncTools', () => {
  it('builds the tools image, ensures the volume and runs a one-shot container', async () => {
    const { service, sb } = makeService();
    const job = await service.syncTools(TEST_HOST_ID);
    await settle(service, job.id);

    expect(service.getJob(job.id)?.status).toBe('success');
    const order = sb.calls.filter((c) =>
      ['buildImage', 'createVolume', 'createContainer', 'startContainer', 'waitContainer', 'removeContainer'].includes(c),
    );
    expect(order).toEqual([
      'buildImage',
      'createVolume',
      'createContainer',
      'startContainer',
      'waitContainer',
      'removeContainer',
    ]);
    const create = sb.log.find((c) => c.method === 'createContainer');
    expect((create?.args[0] as { mounts: unknown[] }).mounts).toEqual([
      { type: 'volume', source: 'porterclaude-tools', target: '/out', readOnly: false },
    ]);
  });

  // the sync is what INSTALLS the agents of a host (backend.md v0.2 section 12.3)
  it('hands PORTERCLAUDE_AGENTS to the populate container', async () => {
    const cfg = stubConfigStore([]);
    const sb = stubBackend();
    const specs = [
      {
        id: 'claude',
        command: 'claude',
        versionCommand: ['claude', '--version'],
        install: { kind: 'script' as const, url: 'https://claude.ai/install.sh' },
      },
    ];
    const agents = stubAgentRegistry();
    (agents as unknown as { installSpecsForHost: () => unknown }).installSpecsForHost = () => specs;
    const service = new ImageService(
      serviceDeps({
        config: cfg.store,
        hosts: stubHostManager(sb.backend),
        agents,
        paths: imagePaths(),
      }),
    );

    const job = await service.syncTools(TEST_HOST_ID);
    await settle(service, job.id);
    expect(service.getJob(job.id)?.status).toBe('success');

    const populate = sb.log
      .filter((c) => c.method === 'createContainer')
      .map((c) => c.args[0] as { name: string; env?: Record<string, string> })
      .find((c) => c.name.startsWith('porterclaude-tools-sync-'));
    expect(JSON.parse(populate?.env?.[TOOLS_AGENTS_ENV] ?? 'null')).toEqual(specs);
    expect(service.getJobLines(job.id).lines.join(' ')).toContain('installing 1 agent(s): claude');
    // a plain sync must NOT force: the installer then carries an unchanged agent over
    expect(populate?.env?.PORTERCLAUDE_TOOLS_FORCE).toBeUndefined();

    // OPS-3: `force` is the AGENT UPGRADE switch, not just an image rebuild. Without
    // PORTERCLAUDE_TOOLS_FORCE=1 the installer carries every installed agent over (its spec
    // does not change when upstream ships a release), so an agent could never be updated.
    const forced = await service.syncTools(TEST_HOST_ID, { force: true });
    await settle(service, forced.id);
    expect(service.getJob(forced.id)?.status).toBe('success');
    const forcedPopulate = sb.log
      .filter((c) => c.method === 'createContainer')
      .map((c) => c.args[0] as { name: string; env?: Record<string, string> })
      .filter((c) => c.name.startsWith('porterclaude-tools-sync-'))
      .pop();
    expect(forcedPopulate?.env?.PORTERCLAUDE_TOOLS_FORCE).toBe('1');
    expect(JSON.parse(forcedPopulate?.env?.[TOOLS_AGENTS_ENV] ?? 'null')).toEqual(specs);
    expect(service.getJobLines(forced.id).lines.join(' ')).toContain(
      'forced: every agent is reinstalled from source',
    );
  });

  it('keeps the job successful when ONE agent failed to install', async () => {
    const manifest = JSON.stringify({
      syncedAt: '2026-08-16T10:00:00.000Z',
      agents: [
        { id: 'claude', command: 'claude', installed: true, version: '2.1.233' },
        { id: 'opencode', command: 'opencode', installed: false, version: null, error: 'download failed: 404' },
      ],
    });
    // the manifest is read out of the volume with a one-shot container built from the
    // tools image, so the build has to leave that image behind
    const sb: ReturnType<typeof stubBackend> = stubBackend({
      containerLogs: async () => manifest,
      buildImage: async (opts) => {
        sb.images.set(opts.tag, imageInspect({ id: 'sha256:tools', tags: [opts.tag] }));
      },
    });
    const { service } = makeService(sb, { host: hostConfig({ agents: { enabled: ['claude', 'opencode'] } }) });

    const job = await service.syncTools(TEST_HOST_ID);
    await settle(service, job.id);

    expect(service.getJob(job.id)?.status).toBe('success');
    const log = service.getJobLines(job.id).lines.join('\n');
    expect(log).toContain('agent claude: installed (2.1.233)');
    expect(log).toContain('WARNING: agent opencode was not installed: download failed: 404');

    // ...and the manifest is what the status reports
    const status = await service.toolsStatus(TEST_HOST_ID);
    expect(status.hostId).toBe(TEST_HOST_ID);
    expect(status.agents).toEqual([
      {
        id: 'claude',
        installed: true,
        version: '2.1.233',
        installedAt: '2026-08-16T10:00:00.000Z',
        error: null,
      },
      {
        id: 'opencode',
        installed: false,
        version: null,
        installedAt: '2026-08-16T10:00:00.000Z',
        error: 'download failed: 404',
      },
    ]);
  });

  it('fails the job when the one-shot container exits non-zero and still removes it', async () => {
    const backend = stubBackend({ waitContainer: async () => ({ statusCode: 3 }) });
    const { service, sb } = makeService(backend);
    const job = await service.syncTools(TEST_HOST_ID);
    await settle(service, job.id);
    expect(service.getJob(job.id)?.status).toBe('error');
    expect(service.getJob(job.id)?.error).toContain('exited with code 3');
    expect(sb.calls).toContain('removeContainer');
  });

  // BE-8: after an upgrade the image must be rebuilt without the operator knowing about
  // {force:true}, otherwise the volume keeps the old entrypoint.sh / claude binaries.
  it('rebuilds the tools image when the stored context hash no longer matches', async () => {
    const { service, sb } = makeService();
    sb.images.set(
      'porterclaude/tools:latest',
      imageInspect({ labels: { [IMAGE_LABELS.contextHash]: 'stale-hash' } }),
    );

    const job = await service.syncTools(TEST_HOST_ID);
    await settle(service, job.id);

    expect(service.getJob(job.id)?.status).toBe('success');
    const build = sb.log.find((c) => c.method === 'buildImage');
    expect(build).toBeTruthy();
    const opts = build?.args[0] as { tag: string; labels: Record<string, string>; pull: boolean; noCache: boolean };
    expect(opts.tag).toBe('porterclaude/tools:latest');
    expect(opts.labels[IMAGE_LABELS.contextHash]).toBe(await hashContext({ dir: path.join(dockerDir, 'tools') }));
    // a plain sync is a normal (cached, no-pull) rebuild; force is the escape hatch
    expect(opts.pull).toBe(false);
    expect(opts.noCache).toBe(false);
    expect(service.getJobLines(job.id).lines.some((l) => l.includes('stale-hash'))).toBe(true);
  });

  it('reuses the image when its context hash still matches, and rebuilds on force', async () => {
    const { service, sb } = makeService();
    const hash = await hashContext({ dir: path.join(dockerDir, 'tools') });
    sb.images.set('porterclaude/tools:latest', imageInspect({ labels: { [IMAGE_LABELS.contextHash]: hash } }));

    const job = await service.syncTools(TEST_HOST_ID);
    await settle(service, job.id);
    expect(sb.calls).not.toContain('buildImage');
    expect(service.getJobLines(job.id).lines.some((l) => l.includes('reusing existing image'))).toBe(true);
    // the volume is still re-populated from the (current) image
    expect(sb.calls).toContain('createContainer');

    const forced = await service.syncTools(TEST_HOST_ID, { force: true });
    await settle(service, forced.id);
    const build = sb.log.find((c) => c.method === 'buildImage');
    const opts = build?.args[0] as { pull: boolean; noCache: boolean };
    expect(opts.pull).toBe(true);
    expect(opts.noCache).toBe(true);
  });

  it('reports outdated in the tools status (mirrors RecipeStatus.outdated)', async () => {
    const { service, sb } = makeService();
    const hash = await hashContext({ dir: path.join(dockerDir, 'tools') });
    sb.volumes.push({ name: 'porterclaude-tools', driver: 'local', labels: {} });

    // populated volume, no image at all -> the next sync has to build one
    expect(await service.toolsStatus(TEST_HOST_ID)).toMatchObject({ outdated: true, contextHash: hash });

    sb.images.set('porterclaude/tools:latest', imageInspect({ labels: { [IMAGE_LABELS.contextHash]: 'stale' } }));
    expect((await service.toolsStatus(TEST_HOST_ID)).outdated).toBe(true);

    sb.images.set('porterclaude/tools:latest', imageInspect({ labels: { [IMAGE_LABELS.contextHash]: hash } }));
    expect((await service.toolsStatus(TEST_HOST_ID)).outdated).toBe(false);
  });

  it('reports the tools volume status', async () => {
    const { service, sb } = makeService();
    expect((await service.toolsStatus(TEST_HOST_ID)).present).toBe(false);
    sb.volumes.push({ name: 'porterclaude-tools', driver: 'local', labels: {} });
    const status = await service.toolsStatus(TEST_HOST_ID);
    expect(status).toMatchObject({
      volume: 'porterclaude-tools',
      imageRef: 'porterclaude/tools:latest',
      present: true,
      syncing: false,
      jobId: null,
    });
  });
});

describe('validateCustomImage', () => {
  it('pulls a missing image and reports architecture/user plus warnings', async () => {
    let inspects = 0;
    const backend = stubBackend({
      containerLogs: async () => 'PC_GIT\nPC_PKG\nPC_DONE\n',
      inspectImage: async () => {
        inspects += 1;
        return inspects === 1 ? null : imageInspect({ architecture: 'arm64', user: '' });
      },
    });
    const { service } = makeService(backend);

    const result = await service.validateCustomImage(TEST_HOST_ID, 'nginx:1.27');
    expect(result.ok).toBe(true);
    expect(result.existsLocally).toBe(false);
    expect(result.pulled).toBe(true);
    expect(result.architecture).toBe('arm64');
    expect(result.user).toBe('root');
    expect(result.warnings.join(' ')).toContain('no tmux');
  });

  it('reports an error instead of throwing when the image cannot be pulled', async () => {
    const backend = stubBackend({
      pullImage: async () => {
        throw new Error('manifest unknown');
      },
    });
    const { service } = makeService(backend);
    const result = await service.validateCustomImage(TEST_HOST_ID, 'nope:latest');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('manifest unknown');
  });
});


// ---------------------------------------------------------------------------
// v0.2: everything is per host
// ---------------------------------------------------------------------------
describe('host scoping', () => {
  it('does not let a build on host A block the same recipe on host B', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const cfg = stubConfigStore([]);
    const home = stubBackend({ buildImage: async () => gate });
    const edge = stubBackend({ buildImage: async () => gate });
    const hosts = stubHosts([
      { host: hostConfig(), backend: home.backend },
      { host: otherHostConfig(), backend: edge.backend },
    ]);
    const service = new ImageService(serviceDeps({ config: cfg.store, hosts, paths: imagePaths() }));

    const first = await service.buildRecipe(TEST_HOST_ID, 'node');
    // the SAME recipe on the SAME host is a conflict...
    await expect(service.buildRecipe(TEST_HOST_ID, 'node')).rejects.toMatchObject({ code: 'conflict' });
    // ...on another host it just runs
    const second = await service.buildRecipe('edge', 'node');
    expect(second.hostId).toBe('edge');
    expect(first.hostId).toBe(TEST_HOST_ID);

    release();
    await settle(service, first.id);
    await settle(service, second.id);
  });

  it('lists and looks up jobs per host', async () => {
    const { service } = makeTwoHosts();
    const home = await service.buildRecipe(TEST_HOST_ID, 'node');
    await settle(service, home.id);
    const edge = await service.buildRecipe('edge', 'python');
    await settle(service, edge.id);

    expect(service.listJobs(TEST_HOST_ID).map((j) => j.id)).toEqual([home.id]);
    expect(service.listJobs('edge').map((j) => j.id)).toEqual([edge.id]);
    // without a filter every job is visible (health/debug)
    expect(service.listJobs().map((j) => j.id)).toEqual([edge.id, home.id]);

    // a job of another host does not exist for this one
    expect(service.getJob(home.id, 'edge')).toBeNull();
    expect(service.getJob(home.id, TEST_HOST_ID)?.id).toBe(home.id);
    expect(() => service.getJobLines(home.id, 0, 'edge')).toThrow();
    expect(() => service.cancelJob(home.id, 'edge')).toThrow();
  });

  it('builds on the host that was asked, with that host s image namespace', async () => {
    const { service, home, edge } = makeTwoHosts();
    const job = await service.buildRecipe('edge', 'node');
    await settle(service, job.id);
    expect(edge.calls).toContain('buildImage');
    expect(home.calls).not.toContain('buildImage');
  });
});

describe('the agents of a host (AGENTS.json)', () => {
  const manifest = {
    syncedAt: '2026-08-16T09:00:00.000Z',
    agents: [
      { id: 'claude', command: 'claude', installed: true, version: '2.1.233', error: null },
      { id: 'opencode', command: 'opencode', installed: false, version: null, error: 'download failed: 404' },
    ],
  };

  function toolsBackend(logs: string) {
    const sb = stubBackend({ containerLogs: async () => logs });
    sb.images.set('porterclaude/tools:latest', imageInspect({ tags: ['porterclaude/tools:latest'] }));
    sb.volumes.push({ name: 'porterclaude-tools', driver: 'local', labels: {} });
    return sb;
  }

  it('reads the manifest out of the tools volume with a one-shot container', async () => {
    const sb = toolsBackend(JSON.stringify(manifest));
    const { service } = makeService(sb, { host: hostConfig({ agents: { enabled: ['claude', 'opencode'] } }) });

    const agents = await service.agentStatuses(TEST_HOST_ID);
    expect(agents).toEqual([
      { id: 'claude', installed: true, version: '2.1.233', installedAt: manifest.syncedAt, error: null },
      {
        id: 'opencode',
        installed: false,
        version: null,
        installedAt: manifest.syncedAt,
        error: 'download failed: 404',
      },
    ]);

    const probe = sb.log
      .filter((c) => c.method === 'createContainer')
      .map((c) => c.args[0] as { cmd?: string[]; mounts?: Array<{ source: string; readOnly?: boolean }> })
      .at(-1);
    expect(probe?.cmd?.[0]).toContain('AGENTS.json');
    expect(probe?.mounts?.[0]).toMatchObject({ source: 'porterclaude-tools', readOnly: true });
    expect(sb.calls).toContain('removeContainer');
  });

  it('caches the manifest instead of starting one container per poll', async () => {
    const sb = toolsBackend(JSON.stringify(manifest));
    const { service } = makeService(sb);
    await service.agentStatuses(TEST_HOST_ID);
    const containers = sb.calls.filter((c) => c === 'createContainer').length;
    await service.agentStatuses(TEST_HOST_ID);
    expect(sb.calls.filter((c) => c === 'createContainer').length).toBe(containers);
  });

  it('answers installed:false for every enabled agent when the host is unreachable', async () => {
    const cfg = stubConfigStore([]);
    const hosts = stubHosts([
      { host: hostConfig({ agents: { enabled: ['claude', 'opencode'] } }), backend: null },
    ]);
    const service = new ImageService(serviceDeps({ config: cfg.store, hosts, paths: imagePaths() }));

    // B-7: installed:false, but WITH the reason - otherwise the panel cannot tell
    // "not installed" from "could not read the tools volume" (api.md: an unreachable host
    // answers installed:false plus an error string instead of a 502)
    const agents = await service.agentStatuses(TEST_HOST_ID);
    expect(agents).toEqual([
      { id: 'claude', installed: false, version: null, installedAt: null, error: expect.stringContaining('no docker backend') },
      { id: 'opencode', installed: false, version: null, installedAt: null, error: expect.stringContaining('no docker backend') },
    ]);
    // ...and the panel still renders for that host
    const status = await service.toolsStatus(TEST_HOST_ID);
    expect(status).toMatchObject({ hostId: TEST_HOST_ID, present: false });
    expect(status.error).toContain('no docker backend');
    expect(status.agents).toHaveLength(2);
  });

  // B-7: a null manifest that came from a TRANSPORT error must not be cached, or a host that
  // comes back keeps reporting installed:false for the rest of the TTL.
  it('does not cache a manifest read that FAILED', async () => {
    let fail = true;
    const sb = stubBackend({
      containerLogs: async () => {
        if (fail) throw new Error('connect ECONNREFUSED');
        return JSON.stringify(manifest);
      },
    });
    sb.images.set('porterclaude/tools:latest', imageInspect({ tags: ['porterclaude/tools:latest'] }));
    sb.volumes.push({ name: 'porterclaude-tools', driver: 'local', labels: {} });
    const { service } = makeService(sb, { host: hostConfig({ agents: { enabled: ['claude'] } }) });

    const first = await service.agentStatuses(TEST_HOST_ID);
    expect(first[0]).toMatchObject({ id: 'claude', installed: false, error: 'connect ECONNREFUSED' });

    fail = false;
    const second = await service.agentStatuses(TEST_HOST_ID);
    expect(second[0]).toMatchObject({ id: 'claude', installed: true, version: '2.1.233', error: null });
  });

  it('answers an empty list for an unknown host', async () => {
    const { service } = makeService();
    expect(await service.agentStatuses('nope')).toEqual([]);
  });

  it('degrades to installed:false when the volume has no manifest yet', async () => {
    const sb = toolsBackend('cat: /out/AGENTS.json: No such file');
    const { service } = makeService(sb, { host: hostConfig({ agents: { enabled: ['claude'] } }) });
    expect(await service.agentStatuses(TEST_HOST_ID)).toEqual([
      { id: 'claude', installed: false, version: null, installedAt: null, error: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// INT2-2: a tools volume without <toolsMount>/entrypoint.sh crash-loops EVERY
// session on that host, so sessions ask before they create a container
// ---------------------------------------------------------------------------
describe('toolsReadiness (INT2-2)', () => {
  const BOOTSTRAP = 'PC_TOOLS_BOOTSTRAP_OK\n';

  function volumeBackend(logs: string, opts: { toolsImage?: boolean; volume?: boolean } = {}) {
    const sb = stubBackend({ containerLogs: async () => logs });
    if (opts.toolsImage !== false) {
      sb.images.set('porterclaude/tools:latest', imageInspect({ tags: ['porterclaude/tools:latest'] }));
    }
    if (opts.volume !== false) sb.volumes.push({ name: 'porterclaude-tools', driver: 'local', labels: {} });
    return sb;
  }

  it('is ready when the volume carries the bootstrap', async () => {
    const { service } = makeService(volumeBackend(BOOTSTRAP));
    expect(await service.toolsReadiness(TEST_HOST_ID)).toBe('ready');
  });

  it('is unsynced when the volume does not exist yet', async () => {
    const { service, sb } = makeService(volumeBackend(BOOTSTRAP, { volume: false }));
    expect(await service.toolsReadiness(TEST_HOST_ID)).toBe('unsynced');
    // ... and no container is started to find that out
    expect(sb.calls).not.toContain('createContainer');
  });

  it('is unsynced when the volume EXISTS but is empty (docker created it for a session)', async () => {
    const { service } = makeService(volumeBackend('cat: /out/AGENTS.json: No such file'));
    expect(await service.toolsReadiness(TEST_HOST_ID)).toBe('unsynced');
  });

  it('reads the volume with the session image when the tools image is gone', async () => {
    const sb = volumeBackend(BOOTSTRAP, { toolsImage: false });
    sb.images.set('porterclaude/node:latest', imageInspect());
    const { service } = makeService(sb);

    // without an image on the engine there is nothing to read the volume with: 'unknown',
    // never a refusal
    expect(await service.toolsReadiness(TEST_HOST_ID)).toBe('unknown');
    expect(await service.toolsReadiness(TEST_HOST_ID, { probeImage: 'porterclaude/node:latest' })).toBe(
      'ready',
    );
    const probe = sb.log
      .filter((c) => c.method === 'createContainer')
      .map((c) => c.args[0] as { image: string })
      .at(-1);
    expect(probe?.image).toBe('porterclaude/node:latest');
  });

  it('is unknown when the host has no transport', async () => {
    const cfg = stubConfigStore([]);
    const hosts = stubHosts([{ host: hostConfig(), backend: null }]);
    const service = new ImageService(serviceDeps({ config: cfg.store, hosts, paths: imagePaths() }));
    expect(await service.toolsReadiness(TEST_HOST_ID)).toBe('unknown');
  });

  it('is unknown for a host this install does not have', async () => {
    const { service } = makeService(volumeBackend(BOOTSTRAP));
    expect(await service.toolsReadiness('nope')).toBe('unknown');
  });

  it('caches per (host, volume): repointing a host is not answered from the old volume', async () => {
    const sb = volumeBackend(BOOTSTRAP);
    sb.volumes.push({ name: 'other-tools', driver: 'local', labels: {} });
    const cfg = stubConfigStore([]);
    const hosts = stubHosts([{ host: hostConfig(), backend: sb.backend }]);
    const service = new ImageService(serviceDeps({ config: cfg.store, hosts, paths: imagePaths() }));

    expect(await service.toolsReadiness(TEST_HOST_ID)).toBe('ready');
    const probes = sb.calls.filter((c) => c === 'createContainer').length;
    // same volume: served from the cache
    expect(await service.toolsReadiness(TEST_HOST_ID)).toBe('ready');
    expect(sb.calls.filter((c) => c === 'createContainer').length).toBe(probes);
  });
});

describe('parseAgentManifest', () => {
  it('reads the documented shape', () => {
    const parsed = parseAgentManifest(
      '{"syncedAt":"2026-08-16T09:00:00.000Z","agents":[{"id":"claude","command":"claude","installed":true,"version":"2.1.233"}]}',
    );
    expect(parsed).toEqual({
      syncedAt: '2026-08-16T09:00:00.000Z',
      agents: [{ id: 'claude', command: 'claude', installed: true, version: '2.1.233', error: null }],
    });
  });

  it('survives a log line in front of the json (docker log framing, shell noise)', () => {
    const parsed = parseAgentManifest('some warning\n{"syncedAt":"x","agents":[{"id":"a","installed":false}]}\n');
    expect(parsed?.agents).toEqual([{ id: 'a', command: 'a', installed: false, version: null, error: null }]);
  });

  it.each(['', 'cat: no such file', '{', '{"agents":42}', 'null'])('answers null for %j', (raw) => {
    expect(parseAgentManifest(raw)).toBeNull();
  });

  it('drops entries without an id', () => {
    expect(parseAgentManifest('{"agents":[{"installed":true},{"id":"ok","installed":true}]}')?.agents).toEqual([
      { id: 'ok', command: 'ok', installed: true, version: null, error: null },
    ]);
  });
});

// backend.md v0.2 section 12.4: without this copy every upgraded instance would ask for
// /login again. It must run once, and it must never delete the v0.1 volumes.
describe('the one-time legacy claude import', () => {
  function legacyBackend(opts: { marker?: boolean } = {}) {
    const sb = stubBackend({
      containerLogs: async (id: string) => (opts.marker ? 'PC_IMPORT_SKIPPED' : `imported ${id}`),
    });
    sb.volumes.push({ name: 'porterclaude-claude', driver: 'local', labels: {} });
    sb.volumes.push({ name: 'porterclaude-claude-home', driver: 'local', labels: {} });
    return sb;
  }

  const importContainers = (sb: ReturnType<typeof stubBackend>) =>
    sb.log
      .filter((c) => c.method === 'createContainer')
      .map((c) => c.args[0] as { name: string; user?: string; mounts?: Array<{ source: string; target: string; readOnly?: boolean }>; cmd?: string[] })
      .filter((c) => c.name.startsWith('porterclaude-claude-import-'));

  it('copies the v0.1 volumes into the claude auth volume exactly once', async () => {
    const sb = legacyBackend();
    const { service } = makeService(sb);

    const first = await service.syncTools(TEST_HOST_ID);
    await settle(service, first.id);
    expect(service.getJob(first.id)?.status).toBe('success');

    const runs = importContainers(sb);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.user).toBe('0:0');
    expect(runs[0]?.mounts).toEqual([
      { type: 'volume', source: 'porterclaude-claude', target: '/legacy', readOnly: true },
      { type: 'volume', source: 'porterclaude-claude-home', target: '/legacy-home', readOnly: true },
      { type: 'volume', source: 'porterclaude-auth-claude', target: '/auth', readOnly: false },
    ]);
    const script = runs[0]?.cmd?.[0] ?? '';
    expect(script).toContain('cp -a /legacy-home/.claude.json /auth/claude.json');
    expect(script).toContain('.pc-import-v1');
    // entry by entry and never clobbering: a target volume that already holds an agent's
    // scratch state (cache/, projects/) must still receive the missing .credentials.json.
    // A whole-directory "only when empty" guard silently loses the v0.1 login instead.
    expect(script).toContain('for p in /legacy/.[!.]* /legacy/..?* /legacy/*; do');
    expect(script).toContain('[ -e "/auth/claude/$b" ] && continue');
    expect(script).toContain('cp -a "$p" "/auth/claude/$b"');
    expect(script).not.toContain('ls -A /auth/claude');
    // the old volumes are NEVER deleted (a rollback to v0.1 has to keep working)
    expect(sb.calls).not.toContain('removeVolume');

    // a second sync does not run it again
    const second = await service.syncTools(TEST_HOST_ID);
    await settle(service, second.id);
    expect(importContainers(sb)).toHaveLength(1);
  });

  it('reports an already imported login (the marker inside the volume wins)', async () => {
    const sb = legacyBackend({ marker: true });
    const { service } = makeService(sb);
    const job = await service.syncTools(TEST_HOST_ID);
    await settle(service, job.id);
    expect(service.getJobLines(job.id).lines.join(' ')).toContain('already imported');
  });

  it('does nothing on a fresh install that has no v0.1 volumes', async () => {
    const sb = stubBackend();
    const { service } = makeService(sb);
    const job = await service.syncTools(TEST_HOST_ID);
    await settle(service, job.id);
    expect(importContainers(sb)).toHaveLength(0);
    expect(service.getJob(job.id)?.status).toBe('success');
  });

  it('keeps the sync successful when the import container fails', async () => {
    const sb = legacyBackend();
    let waits = 0;
    (sb.backend as unknown as { waitContainer: (id: string) => Promise<{ statusCode: number }> }).waitContainer =
      async () => {
        waits += 1;
        // the populate container succeeds, the import container does not
        return { statusCode: waits === 1 ? 0 : 9 };
      };
    const { service } = makeService(sb);
    const job = await service.syncTools(TEST_HOST_ID);
    await settle(service, job.id);
    expect(service.getJob(job.id)?.status).toBe('success');
    expect(service.getJobLines(job.id).lines.join(' ')).toContain('WARNING: importing the v0.1 claude login failed');
  });
});
