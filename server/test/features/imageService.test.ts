// OWNER: B2. ImageService: recipe statuses, job registry/cursor, tools sync (stub backend).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImageService } from '../../src/images/service.js';
import { RECIPES } from '../../src/images/recipes.js';
import { IMAGE_LABELS } from '../../src/sessions/model.js';
import { hashContext } from '../../src/images/tarContext.js';
import {
  imageInspect,
  serviceDeps,
  stubBackend,
  stubBackendManager,
  stubConfigStore,
  testPaths,
} from './helpers.js';

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

function makeService(backend = stubBackend()) {
  const cfg = stubConfigStore([]);
  const paths = testPaths({
    dockerDir,
    recipesDir: path.join(dockerDir, 'recipes'),
    toolsDir: path.join(dockerDir, 'tools'),
  });
  const service = new ImageService(
    serviceDeps({ config: cfg.store, backends: stubBackendManager(backend.backend), paths }),
  );
  return { service, sb: backend };
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
    const statuses = await service.recipeStatuses();
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
    const node = (await service.recipeStatuses()).find((s) => s.name === 'node');
    expect(node?.built).toBe(true);
    expect(node?.outdated).toBe(false);
    expect(node?.claudeVersion).toBe('1.2.3');
    expect(node?.builtAt).toBe('2026-02-02T00:00:00.000Z');

    sb.images.set('porterclaude/node:latest', imageInspect({ labels: { [IMAGE_LABELS.contextHash]: 'stale' } }));
    expect((await service.recipeStatuses()).find((s) => s.name === 'node')?.outdated).toBe(true);
  });
});

describe('buildRecipe', () => {
  it('builds the tagged image with the porterclaude labels', async () => {
    const { service, sb } = makeService();
    const job = await service.buildRecipe('node');
    expect(job.kind).toBe('build');
    expect(job.target).toBe('node');
    await settle(service, job.id);

    const build = sb.log.find((c) => c.method === 'buildImage');
    const opts = build?.args[0] as { tag: string; labels: Record<string, string> };
    expect(opts.tag).toBe('porterclaude/node:latest');
    expect(opts.labels[IMAGE_LABELS.recipe]).toBe('node');
    expect(opts.labels[IMAGE_LABELS.contextHash]).toMatch(/^[0-9a-f]{64}$/);
    expect(opts.labels[IMAGE_LABELS.builtAt]).toBeTruthy();
    expect(service.getJob(job.id)?.status).toBe('success');
  });

  it('404s an unknown recipe', async () => {
    const { service } = makeService();
    await expect(service.buildRecipe('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('409s while a build for the same recipe is running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const backend = stubBackend({ buildImage: async () => gate });
    const { service } = makeService(backend);

    const job = await service.buildRecipe('node');
    await expect(service.buildRecipe('node')).rejects.toMatchObject({ code: 'conflict' });
    release();
    await settle(service, job.id);
    expect(service.getJob(job.id)?.status).toBe('success');
  });

  it('fails the job with a clear message when the context is missing', async () => {
    const { service } = makeService();
    await fs.rm(path.join(dockerDir, 'recipes', 'node'), { recursive: true, force: true });
    const job = await service.buildRecipe('node');
    await settle(service, job.id);
    const finished = service.getJob(job.id);
    expect(finished?.status).toBe('error');
    expect(finished?.error).toContain('does not exist');
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
    const job = await service.buildRecipe('node');
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
    const job = await service.buildRecipe('node');
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
    const job = await service.buildRecipe('node');
    expect(service.cancelJob(job.id).status).toBe('cancelled');
    release();
    expect(() => service.cancelJob('missing')).toThrow();
    expect(() => service.getJobLines('missing')).toThrow();
    expect(service.getJob('missing')).toBeNull();
  });

  it('lists jobs newest first', async () => {
    const { service } = makeService();
    const first = await service.buildRecipe('node');
    await settle(service, first.id);
    const second = await service.pull('nginx:1.27');
    await settle(service, second.id);
    const jobs = service.listJobs();
    expect(jobs[0]?.id).toBe(second.id);
    expect(jobs[1]?.id).toBe(first.id);
  });
});

describe('syncTools', () => {
  it('builds the tools image, ensures the volume and runs a one-shot container', async () => {
    const { service, sb } = makeService();
    const job = await service.syncTools();
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

  it('fails the job when the one-shot container exits non-zero and still removes it', async () => {
    const backend = stubBackend({ waitContainer: async () => ({ statusCode: 3 }) });
    const { service, sb } = makeService(backend);
    const job = await service.syncTools();
    await settle(service, job.id);
    expect(service.getJob(job.id)?.status).toBe('error');
    expect(service.getJob(job.id)?.error).toContain('exited with code 3');
    expect(sb.calls).toContain('removeContainer');
  });

  it('reports the tools volume status', async () => {
    const { service, sb } = makeService();
    expect((await service.toolsStatus()).present).toBe(false);
    sb.volumes.push({ name: 'porterclaude-tools', driver: 'local', labels: {} });
    const status = await service.toolsStatus();
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

    const result = await service.validateCustomImage('nginx:1.27');
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
    const result = await service.validateCustomImage('nope:latest');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('manifest unknown');
  });
});
