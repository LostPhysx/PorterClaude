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
  }
  export function pack(cwd: string, opts?: PackOptions): Readable;
  export function extract(cwd: string, opts?: Record<string, unknown>): Writable;
}
