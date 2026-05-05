/**
 * Streaming tar reader for `.vbundle` archives.
 *
 * A `.vbundle` is a gzip-compressed tar. This module gunzips the incoming
 * `Readable`, pipes it through `tar-stream`'s push-style extractor, and
 * adapts the `(header, stream, next)` event into a consumer-friendly async
 * generator that yields one entry at a time.
 *
 * Memory invariant: each entry's body is surfaced as a `Readable`, never a
 * pre-buffered blob. Callers MUST fully consume (or explicitly `resume()`)
 * each body stream before advancing the outer generator — otherwise the
 * underlying tar extractor will stall waiting on backpressure.
 */

import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { extract as tarExtract } from "tar-stream";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Subset of tar-stream's header surface that vbundle consumers care about. */
export interface StreamedTarHeader {
  name: string;
  size: number;
  type: "file" | "directory" | "pax-header" | "symlink" | "other";
  /** Populated only when `type === "symlink"`; the symlink's target string from the tar header. */
  linkname?: string;
}

export interface StreamedTarEntry {
  header: StreamedTarHeader;
  /**
   * The entry body. Must be fully consumed (drained via for-await, piped,
   * or explicitly `.resume()`'d) before the generator is advanced again.
   */
  body: Readable;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface PendingEntry {
  header: StreamedTarHeader;
  body: Readable;
  next: (err?: Error | null) => void;
}

function normalizeHeaderType(
  type: string | undefined,
): StreamedTarHeader["type"] {
  switch (type) {
    case "file":
      return "file";
    case "directory":
      return "directory";
    case "pax-header":
      return "pax-header";
    case "symlink":
      return "symlink";
    default:
      return "other";
  }
}

/**
 * Stream a `.vbundle` archive as an async sequence of tar entries.
 *
 * Errors from the upstream source, gunzip, or tar-stream extractor are
 * surfaced by throwing from the generator.
 *
 * Early termination (caller `break`s or the for-await loop throws) destroys
 * the upstream source and the tar extractor so that sockets and file
 * descriptors are released promptly.
 */
export async function* parseVBundleStream(
  source: Readable,
): AsyncGenerator<StreamedTarEntry, void, void> {
  const gunzip = createGunzip();
  const extractor = tarExtract();

  // Terminal error captured from any stage in the pipeline. Consumed by the
  // generator's internal pump; re-thrown on the next `yield`.
  let pipelineError: Error | null = null;
  let finished = false;

  // Single-slot mailbox: the extractor pushes one entry here, and the
  // generator consumes it. We gate the push-style API by holding the tar
  // extractor's `next` callback until the caller is done with the body.
  let waiter: {
    resolve: (entry: PendingEntry | null) => void;
    reject: (err: Error) => void;
  } | null = null;
  let pending: PendingEntry | null = null;

  function pushEntry(entry: PendingEntry): void {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.resolve(entry);
    } else {
      pending = entry;
    }
  }

  function pushError(err: Error): void {
    if (pipelineError) return;
    pipelineError = err;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(err);
    }
  }

  function pushFinish(): void {
    finished = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.resolve(null);
    }
  }

  extractor.on("entry", (header, body, next) => {
    // Avoid unhandled "error" on body streams destroyed mid-flight; the
    // extractor itself propagates the real error to its "error" listener.
    body.on("error", () => {});
    const normalizedType = normalizeHeaderType(header.type);
    const surfaced: StreamedTarHeader = {
      name: header.name,
      size: header.size,
      type: normalizedType,
    };
    if (normalizedType === "symlink" && header.linkname) {
      surfaced.linkname = header.linkname;
    }
    pushEntry({
      header: surfaced,
      body,
      next,
    });
  });

  extractor.on("error", (err: Error) => {
    pushError(err);
  });

  extractor.on("finish", () => {
    pushFinish();
  });

  gunzip.on("error", (err: Error) => {
    pushError(err);
    extractor.destroy(err);
  });

  source.on("error", (err: Error) => {
    pushError(err);
    gunzip.destroy(err);
    extractor.destroy(err);
  });

  // `pipe()` is a no-op on an already-destroyed Readable, so gunzip and
  // extractor would never see `end` and `nextEntry()` would await forever.
  // Synthesize a terminal error instead.
  if (source.destroyed) {
    const err = new Error("vbundle source stream was destroyed before parse");
    pushError(err);
    gunzip.destroy(err);
    extractor.destroy(err);
  } else {
    source.pipe(gunzip).pipe(extractor);
  }

  function nextEntry(): Promise<PendingEntry | null> {
    if (pipelineError) return Promise.reject(pipelineError);
    if (pending) {
      const p = pending;
      pending = null;
      return Promise.resolve(p);
    }
    if (finished) return Promise.resolve(null);
    return new Promise<PendingEntry | null>((resolve, reject) => {
      waiter = { resolve, reject };
    });
  }

  try {
    while (true) {
      const entry = await nextEntry();
      if (entry === null) return;

      let advanced = false;
      const advance = (err?: Error | null): void => {
        if (advanced) return;
        advanced = true;
        entry.next(err ?? null);
      };

      // When the consumer finishes (or abandons) the body, release the tar
      // extractor so the next entry can flow.
      entry.body.once("end", () => advance());
      entry.body.once("close", () => advance());
      entry.body.once("error", (err: Error) => advance(err));

      try {
        yield { header: entry.header, body: entry.body };
      } catch (err) {
        // Caller threw (or re-threw) inside the for-await loop. Propagate
        // after cleanup in the finally below.
        advance(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }

      // If the consumer neither consumed nor destroyed the body, drain it
      // for them so the extractor can advance.
      if (!advanced) {
        entry.body.resume();
      }
    }
  } finally {
    // Early termination (break, throw, or natural completion): tear down the
    // pipeline so we don't leak the socket/file descriptor underneath.
    if (!finished || pipelineError) {
      source.destroy();
      gunzip.destroy();
      extractor.destroy();
    }
  }
}
