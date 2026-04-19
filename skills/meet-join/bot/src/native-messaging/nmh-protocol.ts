/**
 * Chrome Native Messaging wire-format helpers.
 *
 * Chrome communicates with a native-messaging host via the host's stdio. Each
 * message is a UTF-8 JSON document prefixed by a 32-bit little-endian length
 * header:
 *
 *   [u32 LE length][utf-8 json payload of exactly that length]
 *
 * This module provides:
 *
 *   - `encodeFrame(obj)` — serialize any JSON-safe value to a Buffer in that
 *     wire format.
 *   - `createFrameReader()` — stateful reader that accumulates arbitrarily
 *     chunked input (split mid-header or mid-payload) and returns complete
 *     frames as they become available.
 *
 * A hard cap of 1,000,000 bytes per frame matches Chrome's documented
 * per-frame NMH limit; a forged header claiming more than this is rejected
 * rather than allowed to exhaust memory.
 *
 * This layer is transport-only. It does NOT validate the JSON payload shape;
 * that belongs to the bot's socket-server layer (see PR 7), which runs the
 * decoded objects through the zod schemas in
 * `skills/meet-join/contracts/native-messaging.ts`.
 */

/** Chrome's documented per-frame maximum. */
const MAX_FRAME_SIZE = 1_000_000;

/** Byte length of the little-endian u32 length prefix. */
const HEADER_BYTES = 4;

/**
 * Encode a JSON-safe value as a native-messaging frame.
 *
 * Returns a Buffer containing `[u32 LE length][utf-8 json]`.
 *
 * Throws if the encoded payload exceeds `MAX_FRAME_SIZE` — the Chrome side
 * would refuse to deliver it anyway, and surfacing the error here is less
 * confusing than silently producing an un-deliverable byte stream.
 */
export function encodeFrame(obj: unknown): Buffer {
  const json = JSON.stringify(obj);
  const payload = Buffer.from(json, "utf8");
  if (payload.byteLength > MAX_FRAME_SIZE) {
    throw new Error(
      `native-messaging frame payload of ${payload.byteLength} bytes exceeds max ${MAX_FRAME_SIZE}`,
    );
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload], HEADER_BYTES + payload.byteLength);
}

/**
 * Stateful reader over a stream of native-messaging bytes.
 *
 * `push(chunk)` appends the chunk to an internal buffer and drains as many
 * complete frames as are currently available. Each complete frame is parsed
 * from UTF-8 JSON and returned as an array entry in the order received.
 *
 * Handles all chunk-boundary placements:
 *   - Chunk ends inside the length header.
 *   - Chunk ends inside the payload.
 *   - Single chunk contains multiple complete frames plus a partial one.
 *
 * A frame whose length header claims more than `MAX_FRAME_SIZE` bytes causes
 * `push()` to throw. After throwing, the internal buffer is in an indeterminate
 * state and the reader should be discarded — callers should not retry.
 */
export interface FrameReader {
  push(chunk: Buffer): unknown[];
}

export function createFrameReader(): FrameReader {
  let buffer: Buffer = Buffer.alloc(0);

  return {
    push(chunk: Buffer): unknown[] {
      buffer =
        buffer.byteLength === 0
          ? Buffer.from(chunk)
          : Buffer.concat(
              [buffer, chunk],
              buffer.byteLength + chunk.byteLength,
            );
      const out: unknown[] = [];
      while (true) {
        if (buffer.byteLength < HEADER_BYTES) break;
        const length = buffer.readUInt32LE(0);
        if (length > MAX_FRAME_SIZE) {
          throw new Error(
            `native-messaging frame length ${length} exceeds max ${MAX_FRAME_SIZE}`,
          );
        }
        const totalNeeded = HEADER_BYTES + length;
        if (buffer.byteLength < totalNeeded) break;
        const payloadStart = HEADER_BYTES;
        const payloadEnd = totalNeeded;
        const payload = buffer.subarray(payloadStart, payloadEnd);
        const json = payload.toString("utf8");
        out.push(JSON.parse(json));
        buffer = buffer.subarray(payloadEnd);
      }
      return out;
    },
  };
}
