import { describe, expect, test } from "bun:test";

import {
  decodeBinaryWebSocketFrame,
  encodeBinaryWebSocketFrame,
} from "./binary-websocket.js";
import { parseVelayFrame } from "./protocol.js";

const id = "0123456789abcdef0123456789abcdef";

describe("binary desktop envelope", () => {
  for (const payload of [
    new Uint8Array(),
    new Uint8Array([0, 255, 1, 128]),
    new Uint8Array(65536).fill(255),
  ]) {
    test(`round-trips ${payload.length} bytes using the shared wire format`, () => {
      const frame = {
        type: "websocket_binary" as const,
        connection_id: id,
        payload,
      };
      const expected = new Uint8Array([
        1,
        ...new TextEncoder().encode(id),
        ...payload,
      ]);
      expect(encodeBinaryWebSocketFrame(frame)).toEqual(expected);
      expect(decodeBinaryWebSocketFrame(expected)).toEqual(frame);
      expect(parseVelayFrame(expected.buffer)).toEqual(frame);
      const padded = new Uint8Array(expected.length + 4);
      padded.set(expected, 2);
      expect(parseVelayFrame(padded.subarray(2, -2))).toEqual(frame);
    });
  }
  test("rejects truncated, unknown-version, and invalid-ID frames", () => {
    for (const wire of [
      new Uint8Array(),
      new Uint8Array([1]),
      new Uint8Array([2, ...new TextEncoder().encode(id)]),
      new Uint8Array([1, ...new TextEncoder().encode("z".repeat(32))]),
    ]) {
      expect(decodeBinaryWebSocketFrame(wire)).toBeUndefined();
    }
    expect(() =>
      encodeBinaryWebSocketFrame({
        type: "websocket_binary",
        connection_id: "bad",
        payload: new Uint8Array(),
      }),
    ).toThrow();
  });
});
