// OWNER: B2. ContainerFilesService: workspace listing, download (file + directory) and
// upload, against a stubbed DockerBackend — no docker host, no real container.
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { extract as tarExtract, pack as tarPack } from 'tar-stream';
import { AppError, toAppError } from '../../src/http/errors.js';
import { createContainersRouter } from '../../src/containers/routes.js';
import type { AppContext } from '../../src/context.js';
import type { ContainerService } from '../../src/containers/service.js';
import type { ExecResult } from '../../src/backends/types.js';
import {
  ContainerFilesService,
  MAX_UPLOAD_BYTES,
  normaliseRoot,
  parseListing,
  resolveInRoot,
  safeFilename,
} from '../../src/containers/files.js';
import { serviceDeps, stubBackend, stubConfigStore, stubHostManager } from './helpers.js';

/** A one-entry tar, exactly what `GET /containers/{id}/archive` returns for a file. */
async function tarOf(entries: Array<{ name: string; body?: string; dir?: boolean }>): Promise<Buffer> {
  const pack = tarPack();
  for (const e of entries) {
    if (e.dir) pack.entry({ name: e.name, type: 'directory', size: 0 }, '');
    else pack.entry({ name: e.name, size: Buffer.byteLength(e.body ?? '') }, e.body ?? '');
  }
  pack.finalize();
  return collect(Readable.from(pack as AsyncIterable<Buffer>));
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

async function readTar(buf: Buffer): Promise<Array<{ name: string; body: string; uid?: number; gid?: number }>> {
  const out: Array<{ name: string; body: string; uid?: number; gid?: number }> = [];
  const extract = tarExtract();
  const done = new Promise<void>((resolve, reject) => {
    extract.on('finish', () => resolve());
    extract.on('error', (err: Error) => reject(err));
  });
  extract.on('entry', (header, stream, next) => {
    void collect(stream).then((body) => {
      out.push({ name: header.name, body: body.toString('utf8'), uid: header.uid, gid: header.gid });
      next();
    });
  });
  Readable.from([buf]).pipe(extract as unknown as NodeJS.WritableStream);
  await done;
  return out;
}

interface Harness {
  files: ContainerFilesService;
  /** every runExec the service made, in order */
  execs: string[][];
  /** last putArchive call */
  puts: Array<{ path: string; tar: Promise<Buffer> }>;
}

/**
 * `exec` answers the service's two shell scripts (list + stat) by content, `archive` is what
 * `getArchive` streams back.
 */
function makeFiles(opts: {
  exec?: (cmd: string[]) => Partial<ExecResult>;
  archive?: Buffer;
} = {}): Harness {
  const execs: string[][] = [];
  const puts: Array<{ path: string; tar: Promise<Buffer> }> = [];
  const sb = stubBackend({
    runExec: async (_id, cmd) => {
      execs.push(cmd);
      return { exitCode: 0, stdout: '', stderr: '', ...(opts.exec?.(cmd) ?? {}) };
    },
    getArchive: async () => Readable.from([opts.archive ?? Buffer.alloc(0)]),
    putArchive: async (_id, path, tar) => {
      puts.push({ path, tar: collect(tar) });
    },
  });
  const deps = serviceDeps({
    config: stubConfigStore([]).store,
    hosts: stubHostManager(sb.backend),
  });
  const containers = {
    requireRunningContainer: async () => ({
      containerId: 'c1',
      config: {} as never,
      hostId: 'default',
      containerAgents: null,
    }),
  } as unknown as ContainerService;
  return { files: new ContainerFilesService(deps, containers), execs, puts };
}

describe('workspace path handling', () => {
  it('normalises the workspace root', () => {
    expect(normaliseRoot('/workspace')).toBe('/workspace');
    expect(normaliseRoot('/workspace/')).toBe('/workspace');
    expect(normaliseRoot('workspace')).toBe('/workspace');
    expect(normaliseRoot('/srv//work/')).toBe('/srv/work');
  });

  it('resolves relative and absolute paths inside the root', () => {
    expect(resolveInRoot('/workspace', undefined)).toBe('/workspace');
    expect(resolveInRoot('/workspace', '')).toBe('/workspace');
    expect(resolveInRoot('/workspace', 'src')).toBe('/workspace/src');
    expect(resolveInRoot('/workspace', 'src/app/../lib')).toBe('/workspace/src/lib');
    expect(resolveInRoot('/workspace', '/workspace/src/')).toBe('/workspace/src');
  });

  it('refuses to leave the root', () => {
    for (const bad of ['..', '../etc', '/etc/passwd', '/workspace/../etc', '/workspacex/y']) {
      expect(() => resolveInRoot('/workspace', bad)).toThrow(AppError);
    }
    expect(() => resolveInRoot('/workspace', 'a\0b')).toThrow(/NUL/);
  });

  it('validates upload file names', () => {
    expect(safeFilename(' notes.md ')).toBe('notes.md');
    for (const bad of ['', '.', '..', 'a/b', 'a\0b', 'a\nb', 'x'.repeat(256)]) {
      expect(() => safeFilename(bad)).toThrow(AppError);
    }
  });

  it('parses the NUL separated listing, directories first', () => {
    const stdout = ['file', '12 100', 'b.txt', 'dir', '4096 200', 'src', 'link', '0 0', 'l'].join('\0') + '\0';
    expect(parseListing(stdout)).toEqual([
      { name: 'src', type: 'dir', size: 4096, mtime: 200 },
      { name: 'b.txt', type: 'file', size: 12, mtime: 100 },
      { name: 'l', type: 'link', size: 0, mtime: 0 },
    ]);
    expect(parseListing('')).toEqual([]);
  });
});

describe('ContainerFilesService.list', () => {
  it('lists the workspace root and reports the parent as null', async () => {
    const h = makeFiles({
      exec: () => ({ stdout: ['file', '3 1', 'a.txt'].join('\0') + '\0' }),
    });
    const listing = await h.files.list('web');
    expect(listing).toEqual({
      path: '/workspace',
      root: '/workspace',
      parent: null,
      entries: [{ name: 'a.txt', type: 'file', size: 3, mtime: 1 }],
    });
    // the path is passed as an argv element, never interpolated into the script
    expect(h.execs[0]?.slice(-2)).toEqual(['sh', '/workspace']);
  });

  it('lists a subdirectory and reports its parent', async () => {
    const h = makeFiles({ exec: () => ({ stdout: '' }) });
    const listing = await h.files.list('web', 'src/lib');
    expect(listing.path).toBe('/workspace/src/lib');
    expect(listing.parent).toBe('/workspace/src');
  });

  it('turns "not a directory" (exit 3) into a 404', async () => {
    const h = makeFiles({ exec: () => ({ exitCode: 3 }) });
    await expect(h.files.list('web', 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a path outside the workspace before touching the container', async () => {
    const h = makeFiles();
    await expect(h.files.list('web', '/etc')).rejects.toMatchObject({ code: 'bad_request' });
    expect(h.execs).toHaveLength(0);
  });
});

describe('ContainerFilesService.download', () => {
  it('streams a single file with its size', async () => {
    const h = makeFiles({
      exec: () => ({ stdout: 'file 5\n' }),
      archive: await tarOf([{ name: 'a.txt', body: 'hello' }]),
    });
    const res = await h.files.download('web', 'a.txt');
    expect(res).toMatchObject({ kind: 'file', filename: 'a.txt', size: 5 });
    expect((await collect(res.stream)).toString('utf8')).toBe('hello');
  });

  it('streams a directory as a gzipped tar', async () => {
    const tar = await tarOf([{ name: 'src/', dir: true }, { name: 'src/a.txt', body: 'hi' }]);
    const h = makeFiles({ exec: () => ({ stdout: 'dir\n' }), archive: tar });
    const res = await h.files.download('web', 'src');
    expect(res).toMatchObject({ kind: 'dir', filename: 'src.tar.gz', size: null });
    expect(gunzipSync(await collect(res.stream)).equals(tar)).toBe(true);
  });

  it('404s when the path does not exist', async () => {
    const h = makeFiles({ exec: () => ({ exitCode: 3 }) });
    await expect(h.files.download('web', 'gone.txt')).rejects.toMatchObject({ status: 404 });
  });
});

describe('ContainerFilesService.upload', () => {
  it('writes one tar entry into the target directory, owned by the container user', async () => {
    const h = makeFiles({
      exec: (cmd) => (cmd[2]?.includes('id -u') ? { stdout: '1000\n1000\n' } : { stdout: 'dir\n' }),
    });
    const body = Readable.from([Buffer.from('data-1'), Buffer.from('-2')]);
    const res = await h.files.upload('web', 'src', 'notes.md', body, 8);
    expect(res).toEqual({ path: '/workspace/src/notes.md', size: 8 });

    const put = h.puts[0];
    expect(put?.path).toBe('/workspace/src');
    expect(await readTar(await (put as { tar: Promise<Buffer> }).tar)).toEqual([
      { name: 'notes.md', body: 'data-1-2', uid: 1000, gid: 1000 },
    ]);
  });

  it('refuses a target that is not a directory', async () => {
    const h = makeFiles({ exec: () => ({ stdout: 'file 3\n' }) });
    await expect(
      h.files.upload('web', 'a.txt', 'x.md', Readable.from(['x']), 1),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.puts).toHaveLength(0);
  });

  it('refuses a file name with a path in it and an oversized body', async () => {
    const h = makeFiles({ exec: () => ({ stdout: 'dir\n' }) });
    await expect(
      h.files.upload('web', '', '../escape.md', Readable.from(['x']), 1),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      h.files.upload('web', '', 'big.bin', Readable.from(['x']), MAX_UPLOAD_BYTES + 1),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(h.puts).toHaveLength(0);
  });
});

describe('the file routes over the real service', () => {
  /** the router + the real ContainerFilesService, only the docker backend is stubbed */
  function makeApp(h: Harness) {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/containers',
      createContainersRouter({
        files: h.files,
        log: { warn: () => undefined },
      } as unknown as AppContext),
    );
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction): void => {
      const appErr = toAppError(err);
      res.status(appErr.status).json(appErr.toBody());
    });
    return app;
  }

  it('uploads a raw request body into the workspace', async () => {
    const h = makeFiles({
      exec: (cmd) => (cmd[2]?.includes('id -u') ? { stdout: '1000\n1000\n' } : { stdout: 'dir\n' }),
    });
    const res = await request(makeApp(h))
      .post('/api/containers/web/files/upload?name=notes.md')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('from the browser'))
      .expect(201);
    expect(res.body.file).toEqual({ path: '/workspace/notes.md', size: 16 });
    const put = h.puts[0] as { path: string; tar: Promise<Buffer> };
    expect(await readTar(await put.tar)).toEqual([
      { name: 'notes.md', body: 'from the browser', uid: 1000, gid: 1000 },
    ]);
  });

  it('downloads the file bytes out of the docker tar', async () => {
    const h = makeFiles({
      exec: () => ({ stdout: 'file 5\n' }),
      archive: await tarOf([{ name: 'a.txt', body: 'hello' }]),
    });
    const res = await request(makeApp(h))
      .get('/api/containers/web/files/download?path=a.txt')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-length']).toBe('5');
    expect((res.body as Buffer).toString('utf8')).toBe('hello');
  });

  it('refuses a traversal path with the canonical envelope', async () => {
    const h = makeFiles();
    const res = await request(makeApp(h)).get('/api/containers/web/files?path=../etc').expect(400);
    expect(res.body.error.code).toBe('bad_request');
  });
});
