/**
 * Chrome Native Messaging stdio framing.
 *
 * Each message exchanged between Chrome and the native host is prefixed with a
 * 32-bit unsigned little-endian length, followed by a UTF-8 JSON payload of
 * exactly that length.
 *
 * See: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-protocol
 */

/**
 * Encode an arbitrary JSON-serializable payload as a single native-messaging
 * frame: 4-byte little-endian length prefix followed by the UTF-8 JSON body.
 */
export function encodeFrame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  return Buffer.concat([len, json]);
}

/**
 * Decode as many complete frames as possible from a buffer accumulated from
 * stdin. Returns the parsed frames plus any unconsumed bytes (a partial frame
 * that should be carried into the next read).
 *
 * The decoder is intentionally tolerant of partial reads — Chrome may deliver
 * a single message across multiple `data` events, and multiple messages may
 * arrive coalesced in one event.
 */
export function decodeFrames(buf: Buffer): {
  frames: unknown[];
  remainder: Buffer;
} {
  const frames: unknown[] = [];
  let offset = 0;
  while (buf.length - offset >= 4) {
    const len = buf.readUInt32LE(offset);
    if (buf.length - offset - 4 < len) break;
    const body = buf.subarray(offset + 4, offset + 4 + len);
    frames.push(JSON.parse(body.toString("utf8")));
    offset += 4 + len;
  }
  return { frames, remainder: buf.subarray(offset) };
}
