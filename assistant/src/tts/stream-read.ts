/**
 * Shared response-consumption helpers for streaming TTS HTTP responses.
 *
 * `readChunkedBody` reads a fetch response body to completion, forwarding each
 * non-empty chunk to an optional callback, and guards against stalled upstream
 * streams with a first-chunk timeout and an idle (between-chunks) timeout. On
 * timeout the reader is cancelled and the caller-supplied error is thrown.
 * `consumeSynthesisResponse` wraps it with the provider-common empty-response
 * guards and the buffered (non-streaming) read path.
 */

/** Default timeout waiting for the first chunk of a TTS stream (ms). */
const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 10_000;

/** Default timeout waiting between consecutive chunks (ms). */
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;

/** Stream-stall timeouts, injectable for tests. */
export interface StreamReadTimeouts {
  /** Timeout waiting for the first chunk (ms). */
  firstChunkTimeoutMs?: number;

  /** Timeout waiting between consecutive chunks (ms). */
  idleTimeoutMs?: number;
}

export interface ReadChunkedBodyOptions extends StreamReadTimeouts {
  /** Invoked with each non-empty chunk as it arrives. */
  onChunk?: (chunk: Uint8Array) => void;

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

/** Discriminates the two empty-response failure modes for `makeEmptyError`. */
export type EmptyResponseKind = "no-body" | "empty-audio";

export interface ConsumeSynthesisResponseOptions extends StreamReadTimeouts {
  /** When true, stream the body forwarding chunks; otherwise buffer it whole. */
  stream: boolean;

  /** Invoked with each non-empty chunk as it arrives (streaming only). */
  onChunk?: (chunk: Uint8Array) => void;

  /** Builds the error thrown when a streamed read times out. */
  makeTimeoutError: (timeoutMs: number) => Error;

  /** Builds the error thrown for a missing body or zero-byte audio. */
  makeEmptyError: (kind: EmptyResponseKind) => Error;
}

/**
 * Consume an OK TTS response into complete audio. The streaming path forwards
 * chunks via `onChunk` guarded by stall timeouts; the buffer path reads the
 * whole body. Throws via `makeEmptyError` when the response has no body
 * (streaming) or yields zero audio bytes.
 */
export async function consumeSynthesisResponse(
  response: Response,
  options: ConsumeSynthesisResponseOptions,
): Promise<Buffer> {
  let audio: Buffer;
  if (options.stream) {
    if (!response.body) {
      throw options.makeEmptyError("no-body");
    }
    audio = await readChunkedBody(response.body, options);
  } else {
    audio = Buffer.from(await response.arrayBuffer());
  }

  if (audio.byteLength === 0) {
    throw options.makeEmptyError("empty-audio");
  }

  return audio;
}
