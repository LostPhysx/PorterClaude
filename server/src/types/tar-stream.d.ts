// Local ambient types for tar-stream v3 (no @types package matches v3, and v3 streams are
// streamx, not node streams — hence the intersections instead of `extends`, which would
// clash on `destroy()`/`on()` the way @types/tar-fs does).
declare module 'tar-stream' {
  import type { Readable, Writable } from 'node:stream';

  export interface TarHeaders {
    name: string;
    size?: number;
    mode?: number;
    mtime?: Date;
    /** 'file' | 'directory' | 'symlink' | ... */
    type?: string;
    uid?: number;
    gid?: number;
    uname?: string;
    gname?: string;
    linkname?: string | null;
  }

  export type Pack = Readable & {
    entry(headers: TarHeaders, callback?: (err?: Error | null) => void): Writable;
    entry(headers: TarHeaders, buffer: string | Buffer, callback?: (err?: Error | null) => void): Writable;
    finalize(): void;
  };

  export type Extract = Writable & {
    on(event: 'entry', cb: (headers: TarHeaders, stream: Readable, next: (err?: Error) => void) => void): Extract;
    on(event: 'finish' | 'close', cb: () => void): Extract;
    on(event: 'error', cb: (err: Error) => void): Extract;
    destroy(err?: Error): void;
  };

  export function pack(): Pack;
  export function extract(): Extract;
}
