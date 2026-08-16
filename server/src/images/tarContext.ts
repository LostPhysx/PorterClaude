// OWNER: B2. Build contexts are streamed from the repo with tar-fs (no shelling out).
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pack as tarPack } from 'tar-fs';

export interface TarContextOptions {
  /** directory to pack, e.g. <repo>/docker/recipes/node */
  dir: string;
  /** extra files copied into the tar under a different name, e.g. shared common.sh */
  extraFiles?: Array<{ /** absolute source path */ source: string; /** path inside the tar */ name: string }>;
  ignore?: (name: string) => boolean;
}

/** Minimal view of the tar-stream pack instance tar-fs hands back via `finish`. */
type TarPack = Readable & {
  entry(
    header: { name: string; size: number; mode?: number; type?: string; mtime?: Date },
    buffer: Buffer,
    callback?: (err?: Error | null) => void,
  ): unknown;
  finalize(): void;
};

const DEFAULT_IGNORED_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg']);
const DEFAULT_IGNORED_EXT = new Set(['.tar', '.log']);

function defaultIgnore(fullPath: string): boolean {
  const base = path.basename(fullPath);
  if (DEFAULT_IGNORED_DIRS.has(base)) return true;
  if (DEFAULT_IGNORED_EXT.has(path.extname(base).toLowerCase())) return true;
  return false;
}

function ignoreFor(opts: TarContextOptions): (name: string) => boolean {
  const extra = opts.ignore;
  return (name: string) => defaultIgnore(name) || (extra ? extra(name) : false);
}

/**
 * tar-fs pack of `dir`, with `extraFiles` appended so a recipe Dockerfile can
 * `COPY common.sh .` even though common.sh lives in docker/recipes/common.sh.
 * Default ignores: .git, node_modules, *.tar, *.log.
 *
 * tar-fs v3 returns a *streamx* stream, which is not an instance of node's
 * stream.Readable and is rejected by undici/fetch bodies, so the pack is wrapped in a real
 * node Readable before it leaves this module (the DockerBackend contract says Readable).
 */
export function createTarContext(opts: TarContextOptions): Readable {
  const extras = opts.extraFiles ?? [];
  const ignore = ignoreFor(opts);

  // `finalize:false` + `finish` let us append the shared files after the directory walk
  // without pulling tar-stream in as a direct dependency.
  const packOptions = {
    ignore,
    sort: true,
    dereference: true,
    finalize: extras.length === 0,
    finish: extras.length
      ? (pack: TarPack) => {
          void appendExtras(pack, extras);
        }
      : undefined,
  };

  const pack = tarPack(opts.dir, packOptions);
  return Readable.from(pack as unknown as AsyncIterable<Buffer>);
}

async function appendExtras(
  pack: TarPack,
  extras: NonNullable<TarContextOptions['extraFiles']>,
): Promise<void> {
  try {
    for (const extra of extras) {
      const content = await fs.readFile(extra.source);
      const stat = await fs.stat(extra.source);
      await new Promise<void>((resolve, reject) => {
        pack.entry(
          { name: normaliseName(extra.name), size: content.length, mode: stat.mode & 0o777 },
          content,
          (err) => (err ? reject(err) : resolve()),
        );
      });
    }
    pack.finalize();
  } catch (err) {
    pack.destroy(err instanceof Error ? err : new Error(String(err)));
  }
}

function normaliseName(name: string): string {
  return name.split(path.sep).join('/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Deterministic sha256 over the context (sorted relative paths + file contents), used for
 * the porterclaude.context-hash image label -> "outdated" detection without a network call.
 */
export async function hashContext(opts: TarContextOptions): Promise<string> {
  const ignore = ignoreFor(opts);
  const files = await walk(opts.dir, opts.dir, ignore);

  for (const extra of opts.extraFiles ?? []) {
    files.push({ name: normaliseName(extra.name), source: extra.source });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));

  const hash = createHash('sha256');
  for (const file of files) {
    const content = await fs.readFile(file.source);
    hash.update(file.name);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

interface ContextFile {
  /** path inside the tar (posix, relative to the context root) */
  name: string;
  source: string;
}

async function walk(root: string, dir: string, ignore: (name: string) => boolean): Promise<ContextFile[]> {
  const out: ContextFile[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (ignore(full)) continue;
    if (entry.isDirectory()) {
      out.push(...(await walk(root, full, ignore)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push({ name: normaliseName(path.relative(root, full)), source: full });
    }
  }
  return out;
}
