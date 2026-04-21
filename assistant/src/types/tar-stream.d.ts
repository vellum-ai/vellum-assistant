/**
 * Minimal ambient types for `tar-stream` v3, which ships no type definitions.
 *
 * We only declare the surface used by `runtime/migrations/vbundle-tar-stream.ts`
 * (the `extract()` factory and its `"entry"` event shape). If additional usage
 * is needed later, extend this file rather than adding `@types/tar-stream` —
 * the DT types target v2 and do not match v3's streamx-based extractor.
 */
declare module "tar-stream" {
  import type { Readable, Writable } from "node:stream";

  export interface TarHeader {
    name: string;
    size: number;
    type:
      | "file"
      | "link"
      | "symlink"
      | "character-device"
      | "block-device"
      | "directory"
      | "fifo"
      | "contiguous-file"
      | "pax-header"
      | "pax-global-header"
      | "gnu-long-path"
      | "gnu-long-link-path"
      | "other"
      | string;
    linkname?: string | null;
    mode?: number;
    uid?: number;
    gid?: number;
    mtime?: Date;
    pax?: Record<string, string> | null;
  }

  export interface ExtractOptions {
    filenameEncoding?: string;
    allowUnknownFormat?: boolean;
  }

  export type EntryCallback = (err?: Error | null) => void;

  export interface Extract extends Writable {
    on(
      event: "entry",
      listener: (
        header: TarHeader,
        stream: Readable,
        next: EntryCallback,
      ) => void,
    ): this;
    on(event: "finish", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    destroy(err?: Error): void;
  }

  export function extract(opts?: ExtractOptions): Extract;

  // `pack` exists but is unused by the runtime migrations code; declare it
  // permissively so importers that reach for it still type-check.
  export function pack(opts?: unknown): Writable;
}
