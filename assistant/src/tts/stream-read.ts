/**
 * Shared chunked-body reader for streaming TTS HTTP responses.
 *
 * Reads a fetch response body to completion, forwarding each non-empty chunk
 * to an optional callback, and guards against stalled upstream streams with a
 * first-chunk timeout and an idle (between-chunks) timeout. On timeout the
 * reader is cancelled and the caller-supplied error is thrown.
 */

/** Default timeout waiting for the first chunk of a TTS stream (ms). */
const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 10_000;

/** Default timeout waiting between consecutive chunks (ms). */
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;

export interface ReadChunkedBodyOptions {
  /** Invoked with each non-empty chunk as it arrives. */
  onChunk?: (chunk: Uint8Array) => void;

  /** Timeout waiting for the first chunk (ms). */
  firstChunkTimeoutMs?: number;

  /** Timeout waiting between consecutive chunks (ms). */
  idleTimeoutMs?: number;

  /** Builds the error thrown when a read times out. */
  makeTimeoutError: (timeoutMs: number) => Error;
}

/**
 * Read a chunked response body to completion and return the concatenated
 * audio. Any received chunk (even an empty one) counts as stream activity
 * and switches from the first-chunk timeout to the idle timeout; only
 * non-empty chunks are collected and forwarded to `onChunk`.
 */
export async function readChunkedBody(
  body: ReadableStream<Uint8Array>,
  options: ReadChunkedBodyOptions,
): Promise<Buffer> {
  const firstChunkTimeoutMs =
    options.firstChunkTimeoutMs ?? DEFAULT_FIRST_CHUNK_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  let isFirstChunk = true;

  try {
    while (true) {
      const timeoutMs = isFirstChunk ? firstChunkTimeoutMs : idleTimeoutMs;
      let timerId: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timerId = setTimeout(
          () => reject(options.makeTimeoutError(timeoutMs)),
          timeoutMs,
        );
      });
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await Promise.race([reader.read(), timeout]));
      } finally {
        clearTimeout(timerId!);
      }
      if (done) {
        break;
      }
      if (value) {
        isFirstChunk = false;
        if (value.byteLength > 0) {
          chunks.push(value);
          options.onChunk?.(value);
        }
      }
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors
    }
    throw err;
  }

  return Buffer.concat(chunks);
}
