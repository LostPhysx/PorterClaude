// OWNER: B2. Build contexts are streamed from the repo with tar-fs (no shelling out).
import type { Readable } from 'node:stream';

export interface TarContextOptions {
  /** directory to pack, e.g. <repo>/docker/recipes/node */
  dir: string;
  /** extra files copied into the tar under a different name, e.g. shared common.sh */
  extraFiles?: Array<{ /** absolute source path */ source: string; /** path inside the tar */ name: string }>;
  ignore?: (name: string) => boolean;
}

/**
 * tar-fs pack of `dir`, with `extraFiles` appended so a recipe Dockerfile can
 * `COPY common.sh .` even though common.sh lives in docker/recipes/common.sh.
 * Default ignores: .git, node_modules, *.tar, *.log.
 * TODO(B2)
 */
export function createTarContext(opts: TarContextOptions): Readable {
  throw new Error('TODO(B2)');
}

/**
 * Deterministic sha256 over the context (sorted relative paths + file contents), used for
 * the porterclaude.context-hash image label -> "outdated" detection without a network call.
 * TODO(B2)
 */
export async function hashContext(opts: TarContextOptions): Promise<string> {
  throw new Error('TODO(B2)');
}
