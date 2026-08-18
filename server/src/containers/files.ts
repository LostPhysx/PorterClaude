// OWNER: B2. Workspace file transfer: browse `/workspace` of a running container, download a
// file (or a directory as .tar.gz) and upload files back into it.
//
// Transport: the docker archive endpoints (`GET|PUT /containers/{id}/archive`, see
// backends/types.ts getArchive/putArchive), which speak TAR both ways. The listing is the one
// thing docker cannot answer, so it comes from a single `sh` exec (runExec) whose output is
// NUL separated — filenames may contain spaces, quotes and newlines, so nothing line based
// would survive them.
//
// SCOPE, NOT A SANDBOX: every path is resolved under the container's workspace mount and a
// traversal out of it is refused, which keeps the UI (and a mistyped path) honest. It is not a
// security boundary — whoever can open this modal can also open a shell in the same container
// and read the whole filesystem. A symlink inside the workspace that points outside it is
// therefore followed by docker as usual.
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { extract as tarExtract, pack as tarPack } from 'tar-stream';
import type { ServiceDeps } from '../context.js';
import type { DockerBackend } from '../backends/types.js';
import { AppError } from '../http/errors.js';
import type { ContainerService } from './service.js';

export type FileEntryType = 'file' | 'dir' | 'link' | 'other';

export interface FileEntry {
  name: string;
  type: FileEntryType;
  /** bytes; 0 for anything without a meaningful size */
  size: number;
  /** unix seconds, 0 when stat could not answer */
  mtime: number;
}

export interface FileListing {
  /** absolute path inside the container that was listed */
  path: string;
  /** the workspace mount this browser is pinned to (general.workspaceMount) */
  root: string;
  /** absolute path of the parent, null when `path` IS the root */
  parent: string | null;
  entries: FileEntry[];
}

export interface DownloadResult {
  /** 'file' streams the raw file, 'dir' streams a gzipped tar of the subtree */
  kind: 'file' | 'dir';
  /** suggested download name (basename, plus .tar.gz for a directory) */
  filename: string;
  /** byte length of a file (Content-Length); null for the gzip stream, which is chunked */
  size: number | null;
  stream: Readable;
}

/** Hard ceiling for one uploaded file. Bigger transfers belong in git or a volume mount. */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** `id -u` / `id -g` of a container, cached for this long. */
const OWNER_TTL_MS = 5 * 60_000;

interface OwnerEntry {
  uid: number;
  gid: number;
  at: number;
}

/**
 * Directory listing, one exec, NUL separated records of three fields:
 *   <type> \0 "<size> <mtime>" \0 <name> \0
 * `stat -c` exists in both coreutils and busybox; if it is missing entirely the entry is
 * still listed, with size/mtime 0. Exit 3 = "$1 is not a directory" -> 404.
 */
const LIST_SCRIPT = `
d=$1
[ -d "$d" ] || exit 3
cd "$d" 2>/dev/null || exit 3
for n in * .[!.]* ..?*; do
  [ -e "$n" ] || [ -L "$n" ] || continue
  if [ -L "$n" ]; then t=link
  elif [ -d "$n" ]; then t=dir
  elif [ -f "$n" ]; then t=file
  else t=other; fi
  meta=$(stat -c '%s %Y' -- "$n" 2>/dev/null) || meta='0 0'
  printf '%s\\0%s\\0%s\\0' "$t" "$meta" "$n"
done
`;

/** `stat` of one path: prints "dir" or "file <bytes>"; exit 3 when it does not exist. */
const STAT_SCRIPT = `
p=$1
if [ -d "$p" ]; then echo dir
elif [ -e "$p" ]; then echo "file $(stat -c %s -- "$p" 2>/dev/null || echo -1)"
else exit 3
fi
`;

export class ContainerFilesService {
  /** containerId -> the uid/gid uploads are written as */
  private readonly owners = new Map<string, OwnerEntry>();

  constructor(
    private readonly deps: ServiceDeps,
    private readonly containers: ContainerService,
  ) {}

  /** Entries of `dir` (absolute, or relative to the workspace mount), dirs first. */
  async list(container: string, dir?: string): Promise<FileListing> {
    const target = await this.resolve(container, dir);
    const res = await target.backend.runExec(target.containerId, ['sh', '-c', LIST_SCRIPT, 'sh', target.abs], {
      timeoutMs: 20_000,
    });
    if (res.exitCode === 3) throw AppError.notFound(`'${target.abs}' is not a directory in '${container}'`);
    if (res.exitCode !== 0) {
      throw AppError.badRequest(`could not list '${target.abs}': ${res.stderr.trim() || `exit ${res.exitCode}`}`);
    }
    return {
      path: target.abs,
      root: target.root,
      parent: target.abs === target.root ? null : posixDirname(target.abs),
      entries: parseListing(res.stdout),
    };
  }

  /**
   * A file as its raw bytes, a directory as a gzipped tar of the subtree. The kind is probed
   * first (one exec) because the docker archive stream cannot be rewound once its first tar
   * header has been read.
   */
  async download(container: string, filePath: string): Promise<DownloadResult> {
    const target = await this.resolve(container, filePath);
    const stat = await this.stat(target);
    const base = posixBasename(target.abs) || 'workspace';
    const archive = await target.backend.getArchive(target.containerId, target.abs);

    if (stat.kind === 'dir') {
      const gzip = createGzip();
      // pipeline() so a broken engine stream tears the gzip down instead of hanging the response
      void pipeline(archive, gzip).catch((err: unknown) => {
        this.deps.log.warn({ err, container, path: target.abs }, 'workspace directory download failed');
      });
      return { kind: 'dir', filename: `${base}.tar.gz`, size: null, stream: gzip };
    }
    return {
      kind: 'file',
      filename: base,
      size: stat.size >= 0 ? stat.size : null,
      stream: this.firstTarEntry(archive, container, target.abs),
    };
  }

  /**
   * Write one uploaded file into the directory `dir`. `body` is streamed straight into a
   * one-entry tar and from there into `PUT /containers/{id}/archive`, so nothing is buffered.
   * `size` must be the exact byte length (tar headers are written up front) — the caller takes
   * it from Content-Length.
   */
  async upload(
    container: string,
    dir: string | undefined,
    filename: string,
    body: Readable,
    size: number,
  ): Promise<{ path: string; size: number }> {
    const name = safeFilename(filename);
    if (size < 0 || size > MAX_UPLOAD_BYTES) {
      throw AppError.badRequest(`upload of ${size} bytes exceeds the ${MAX_UPLOAD_BYTES} byte limit`);
    }
    const target = await this.resolve(container, dir);
    // a file must land in a directory that exists; docker's own error for this is opaque
    if ((await this.stat(target)).kind !== 'dir') {
      throw AppError.notFound(`'${target.abs}' is not a directory in '${container}'`);
    }
    const owner = await this.ownerOf(target.backend, target.containerId);

    // one tar entry, written straight from the request body; `finalize` closes the archive
    // when the entry callback fires, and any failure on the way destroys the pack so the
    // docker request below fails instead of hanging on a stream that never ends.
    const pack = tarPack();
    const fail = (err: unknown) => pack.destroy(err instanceof Error ? err : new Error(String(err)));
    const entry = pack.entry(
      { name, size, mode: 0o644, mtime: new Date(), uid: owner.uid, gid: owner.gid },
      (err) => (err ? fail(err) : pack.finalize()),
    );
    const counted = countBytes(size);
    body.on('error', fail);
    counted.on('error', fail);
    body.pipe(counted).pipe(entry);

    // tar-stream v3 is streamx: wrap it in a real node Readable, both transports expect one
    await target.backend.putArchive(target.containerId, target.abs, Readable.from(pack as AsyncIterable<Buffer>), {
      noOverwriteDirNonDir: true,
    });
    return { path: joinPosix(target.abs, name), size };
  }

  // --- internals ------------------------------------------------------------

  /** container -> running id + its host's backend + the resolved absolute path. */
  private async resolve(container: string, input: string | undefined): Promise<ResolvedTarget> {
    const { containerId, hostId } = await this.containers.requireRunningContainer(container);
    const root = normaliseRoot(this.deps.hosts.settingsFor(hostId).workspaceMount);
    return {
      containerId,
      backend: this.deps.hosts.backendFor(hostId),
      root,
      abs: resolveInRoot(root, input),
    };
  }

  /** kind + byte size of `target` (size -1 when `stat` could not answer). */
  private async stat(target: ResolvedTarget): Promise<{ kind: 'file' | 'dir'; size: number }> {
    const res = await target.backend.runExec(
      target.containerId,
      ['sh', '-c', STAT_SCRIPT, 'sh', target.abs],
      { timeoutMs: 15_000 },
    );
    if (res.exitCode === 3) throw AppError.notFound(`'${target.abs}' does not exist`);
    if (res.exitCode !== 0) {
      throw AppError.badRequest(`could not stat '${target.abs}': ${res.stderr.trim() || `exit ${res.exitCode}`}`);
    }
    const [kind, size] = res.stdout.trim().split(' ');
    if (kind === 'dir') return { kind: 'dir', size: 0 };
    return { kind: 'file', size: Number.parseInt(size ?? '', 10) };
  }

  /** uid/gid of the container's own user, so an upload is not owned by root. */
  private async ownerOf(backend: DockerBackend, containerId: string): Promise<OwnerEntry> {
    const hit = this.owners.get(containerId);
    if (hit && Date.now() - hit.at < OWNER_TTL_MS) return hit;
    let uid = 0;
    let gid = 0;
    try {
      const res = await backend.runExec(containerId, ['sh', '-c', 'id -u; id -g'], { timeoutMs: 10_000 });
      const [u, g] = res.stdout.trim().split(/\s+/);
      uid = Number.parseInt(u ?? '', 10) || 0;
      gid = Number.parseInt(g ?? '', 10) || 0;
    } catch (err) {
      // not fatal: the file simply ends up owned by root, which the user can chown
      this.deps.log.warn({ err, containerId }, 'could not read the container uid/gid for an upload');
    }
    const entry = { uid, gid, at: Date.now() };
    this.owners.set(containerId, entry);
    return entry;
  }

  /**
   * The single file entry of a `GET /archive` tar. The body is republished through a
   * PassThrough so the caller gets a plain node Readable (tar-stream v3 hands out streamx
   * streams) and so the size from the tar header can be reported before any byte flows.
   */
  private firstTarEntry(archive: Readable, container: string, abs: string): PassThrough {
    const out = new PassThrough();
    const extract = tarExtract();
    let seen = false;

    extract.on('entry', (header, stream, next) => {
      if (seen || header.type === 'directory') {
        stream.on('end', next);
        stream.resume();
        return;
      }
      seen = true;
      stream.pipe(out, { end: true });
      stream.on('end', next);
      stream.on('error', (err: Error) => out.destroy(err));
    });
    extract.on('error', (err: Error) => out.destroy(err));
    extract.on('finish', () => {
      if (!seen) out.destroy(AppError.notFound(`'${abs}' is not a readable file in '${container}'`));
    });
    archive.on('error', (err: Error) => out.destroy(err));
    archive.pipe(extract as unknown as NodeJS.WritableStream);
    return out;
  }
}

interface ResolvedTarget {
  containerId: string;
  backend: DockerBackend;
  root: string;
  abs: string;
}

// ---------------------------------------------------------------------------
// path handling (pure; exported for the tests)
// ---------------------------------------------------------------------------

/** `/workspace/` -> `/workspace`; anything unusable falls back to `/workspace`. */
export function normaliseRoot(mount: string): string {
  const p = path.posix.normalize(`/${(mount || '/workspace').trim()}`).replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

/**
 * Resolve a browser-supplied path against the workspace root. Absolute paths must already be
 * inside the root; relative ones are joined to it. `..` is resolved BEFORE the check, so
 * `/workspace/../etc` is refused rather than silently reaching /etc.
 *
 * @throws AppError.badRequest for a NUL byte or a path that leaves the root.
 */
export function resolveInRoot(root: string, input: string | undefined): string {
  const raw = (input ?? '').trim();
  if (raw.includes('\0')) throw AppError.badRequest('path must not contain a NUL byte');
  if (raw === '' || raw === '.') return root;
  const joined = raw.startsWith('/') ? raw : `${root}/${raw}`;
  const abs = path.posix.normalize(joined).replace(/\/+$/, '') || '/';
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    throw AppError.badRequest(`path '${raw}' is outside the workspace ${root}`);
  }
  return abs;
}

/** A single upload file name: no directories, no traversal, no control characters. */
export function safeFilename(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') throw AppError.badRequest('a file name is required');
  if (/[/\0\r\n]/.test(trimmed)) throw AppError.badRequest(`invalid file name '${trimmed}'`);
  if (Buffer.byteLength(trimmed, 'utf8') > 255) throw AppError.badRequest('file name is longer than 255 bytes');
  return trimmed;
}

/** Parse the NUL separated LIST_SCRIPT output. Exported for the tests. */
export function parseListing(stdout: string): FileEntry[] {
  const fields = stdout.split('\0');
  const entries: FileEntry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const type = fields[i] as FileEntryType;
    const [size, mtime] = (fields[i + 1] ?? '').split(' ');
    const name = fields[i + 2] ?? '';
    if (!name) continue;
    entries.push({
      name,
      type: type === 'dir' || type === 'file' || type === 'link' ? type : 'other',
      size: Number.parseInt(size ?? '', 10) || 0,
      mtime: Number.parseInt(mtime ?? '', 10) || 0,
    });
  }
  entries.sort((a, b) => {
    const rank = (e: FileEntry) => (e.type === 'dir' ? 0 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  return entries;
}

function posixDirname(abs: string): string {
  return path.posix.dirname(abs);
}

function posixBasename(abs: string): string {
  return path.posix.basename(abs);
}

function joinPosix(dir: string, name: string): string {
  return path.posix.join(dir, name);
}

/** Refuse a body that turns out to be longer than the announced Content-Length. */
function countBytes(expected: number): PassThrough {
  let seen = 0;
  return new PassThrough({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > expected) {
        cb(AppError.badRequest('upload body is longer than its Content-Length'));
        return;
      }
      cb(null, chunk);
    },
  });
}
