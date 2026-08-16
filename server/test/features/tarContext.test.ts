// OWNER: B2. Build-context packing + deterministic hashing (no docker host).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTarContext, hashContext } from '../../src/images/tarContext.js';

let root: string;
let recipeDir: string;
let commonSh: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-ctx-'));
  recipeDir = path.join(root, 'node');
  await fs.mkdir(recipeDir, { recursive: true });
  await fs.writeFile(path.join(recipeDir, 'Dockerfile'), 'FROM node:22-bookworm\nCOPY common.sh .\n');
  await fs.mkdir(path.join(recipeDir, 'files'), { recursive: true });
  await fs.writeFile(path.join(recipeDir, 'files', 'motd'), 'hello\n');
  commonSh = path.join(root, 'common.sh');
  await fs.writeFile(commonSh, '#!/bin/sh\necho common\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function opts() {
  return { dir: recipeDir, extraFiles: [{ source: commonSh, name: 'common.sh' }] };
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('hashContext', () => {
  it('is deterministic across runs', async () => {
    const a = await hashContext(opts());
    const b = await hashContext(opts());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a file in the context changes', async () => {
    const before = await hashContext(opts());
    await fs.writeFile(path.join(recipeDir, 'Dockerfile'), 'FROM node:22-bookworm\nRUN echo hi\n');
    expect(await hashContext(opts())).not.toBe(before);
  });

  it('changes when the shared common.sh changes', async () => {
    const before = await hashContext(opts());
    await fs.writeFile(commonSh, '#!/bin/sh\necho different\n');
    expect(await hashContext(opts())).not.toBe(before);
  });

  it('changes when a file is added and ignores .git / node_modules / *.log', async () => {
    const before = await hashContext(opts());
    await fs.mkdir(path.join(recipeDir, '.git'), { recursive: true });
    await fs.writeFile(path.join(recipeDir, '.git', 'HEAD'), 'ref: x');
    await fs.mkdir(path.join(recipeDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(recipeDir, 'node_modules', 'x.js'), 'x');
    await fs.writeFile(path.join(recipeDir, 'build.log'), 'noise');
    expect(await hashContext(opts())).toBe(before);

    await fs.writeFile(path.join(recipeDir, 'extra.conf'), 'x');
    expect(await hashContext(opts())).not.toBe(before);
  });
});

describe('createTarContext', () => {
  it('packs the recipe dir plus the shared common.sh', async () => {
    const tar = await collect(createTarContext(opts()));
    const text = tar.toString('latin1');
    expect(text).toContain('Dockerfile');
    expect(text).toContain('common.sh');
    expect(text).toContain('files/motd');
    expect(text).toContain('echo common');
    expect(tar.length % 512).toBe(0);
  });

  it('works without extraFiles', async () => {
    const tar = await collect(createTarContext({ dir: recipeDir }));
    expect(tar.toString('latin1')).toContain('Dockerfile');
    expect(tar.length).toBeGreaterThan(1024);
  });
});
