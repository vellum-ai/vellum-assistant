/**
 * Tests for the Chrome native messaging stdio framing in protocol.ts.
 *
 * Run with `bun test src/__tests__/protocol.test.ts` from the package root.
 */

import { describe, expect, test } from "bun:test";

import { decodeFrames, encodeFrame } from "../protocol.js";

describe("encodeFrame / decodeFrames", () => {
  test("round-trips a simple object through encode/decode", () => {
    const payload = { type: "request_token", origin: "chrome-extension://abc/" };
    const frame = encodeFrame(payload);

    // Frame layout: 4-byte LE length prefix followed by JSON body.
    expect(frame.length).toBeGreaterThan(4);
    const expectedLen = Buffer.from(JSON.stringify(payload), "utf8").length;
    expect(frame.readUInt32LE(0)).toBe(expectedLen);

    const { frames, remainder } = decodeFrames(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(payload);
    expect(remainder.length).toBe(0);
  });

  test("decodes multiple frames in one buffer", () => {
    const a = { type: "first", n: 1 };
    const b = { type: "second", n: 2 };
    const c = { type: "third", nested: { ok: true } };
    const combined = Buffer.concat([encodeFrame(a), encodeFrame(b), encodeFrame(c)]);

    const { frames, remainder } = decodeFrames(combined);
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual(a);
    expect(frames[1]).toEqual(b);
    expect(frames[2]).toEqual(c);
    expect(remainder.length).toBe(0);
  });

  test("leaves a partial frame in the remainder", () => {
    const payload = { type: "request_token" };
    const frame = encodeFrame(payload);
    // Slice off the last 3 bytes of the JSON body so the frame is incomplete.
    const truncated = frame.subarray(0, frame.length - 3);

    const { frames, remainder } = decodeFrames(truncated);
    expect(frames).toHaveLength(0);
    // Remainder should equal the truncated input verbatim so the caller can
    // append the next chunk and try again.
    expect(remainder.equals(truncated)).toBe(true);
  });

  test("leaves a partial length prefix in the remainder", () => {
    // Less than 4 bytes — not even enough for the length field.
    const partial = Buffer.from([0x01, 0x02]);
    const { frames, remainder } = decodeFrames(partial);
    expect(frames).toHaveLength(0);
    expect(remainder.equals(partial)).toBe(true);
  });

  test("decodes a complete frame followed by a partial frame", () => {
    const complete = { type: "complete" };
    const partialPayload = { type: "partial" };
    const combined = Buffer.concat([
      encodeFrame(complete),
      encodeFrame(partialPayload).subarray(0, 5),
    ]);

    const { frames, remainder } = decodeFrames(combined);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(complete);
    expect(remainder.length).toBe(5);
  });

  test("handles an empty buffer", () => {
    const { frames, remainder } = decodeFrames(Buffer.alloc(0));
    expect(frames).toHaveLength(0);
    expect(remainder.length).toBe(0);
  });
});
