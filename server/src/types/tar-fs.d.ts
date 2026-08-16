// Local ambient types for tar-fs v3 (avoids depending on a mismatched @types/tar-fs).
declare module 'tar-fs' {
  import type { Readable, Writable } from 'node:stream';
  export interface PackOptions {
    entries?: string[];
    ignore?: (name: string) => boolean;
    filter?: (name: string) => boolean;
    dereference?: boolean;
    map?: (header: { name: string; mode?: number; [k: string]: unknown }) => unknown;
    readable?: boolean;
    writable?: boolean;
    /** tar-fs v3: emit entries in a deterministic (sorted) order */
    sort?: boolean;
    /** tar-fs v3: false leaves the pack open so `finish` can append more entries */
    finalize?: boolean;
    /** tar-fs v3: called with the underlying tar-stream pack once the directory walk ends */
    finish?: (pack: any) => void;
  }
  export function pack(cwd: string, opts?: PackOptions): Readable;
  export function extract(cwd: string, opts?: Record<string, unknown>): Writable;
}
