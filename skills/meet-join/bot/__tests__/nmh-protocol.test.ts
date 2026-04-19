/**
 * Unit tests for the native-messaging wire-format helpers.
 *
 * Verifies the encoder produces a correct `[u32 LE length][utf8 json]` frame
 * and that the streaming reader recovers the original objects regardless of
 * chunk boundaries. Also asserts the 1MB per-frame cap is enforced so a
 * malicious or corrupt peer can't pin memory.
 */

import { describe, expect, test } from "bun:test";

import {
  createFrameReader,
  encodeFrame,
} from "../src/native-messaging/nmh-protocol.js";

describe("nmh-protocol", () => {
  test("encode → read round-trips an object", () => {
    const original = {
      type: "lifecycle",
      state: "joined",
      meetingId: "m-123",
      timestamp: "2026-04-18T00:00:00.000Z",
    };
    const frame = encodeFrame(original);

    // Header is [u32 LE length] and matches the UTF-8 JSON length.
    const declared = frame.readUInt32LE(0);
    const payload = frame.subarray(4);
    expect(declared).toBe(payload.byteLength);
    expect(JSON.parse(payload.toString("utf8"))).toEqual(original);

    const reader = createFrameReader();
    const out = reader.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(original);
  });

  test("recovers both objects when a chunk boundary lands inside the second length header", () => {
    const a = { type: "ready", extensionVersion: "1.0.0" };
    const b = { type: "diagnostic", level: "info", message: "hello" };
    const combined = Buffer.concat([encodeFrame(a), encodeFrame(b)]);

    // Cut mid-second-length-header: after frame A plus 2 bytes of frame B's
    // 4-byte length prefix. This is the tricky split — we need both halves
    // of the header to eventually land and only THEN can we decode.
    const frameALen = 4 + Buffer.from(JSON.stringify(a), "utf8").byteLength;
    const cut = frameALen + 2;
    expect(cut).toBeLessThan(combined.byteLength);

    const first = combined.subarray(0, cut);
    const second = combined.subarray(cut);

    const reader = createFrameReader();
    const out1 = reader.push(first);
    // Frame A is complete; frame B's header is incomplete — expect only A.
    expect(out1).toHaveLength(1);
    expect(out1[0]).toEqual(a);

    const out2 = reader.push(second);
    expect(out2).toHaveLength(1);
    expect(out2[0]).toEqual(b);
  });

  test("recovers the object when a chunk boundary lands inside the payload", () => {
    const obj = {
      type: "lifecycle",
      state: "joining",
      meetingId: "m-xyz",
      timestamp: "2026-04-18T00:00:00.000Z",
    };
    const frame = encodeFrame(obj);
    // Split mid-payload (after header + half of payload).
    const payloadStart = 4;
    const mid =
      payloadStart + Math.floor((frame.byteLength - payloadStart) / 2);
    const first = frame.subarray(0, mid);
    const second = frame.subarray(mid);

    const reader = createFrameReader();
    const out1 = reader.push(first);
    expect(out1).toHaveLength(0);
    const out2 = reader.push(second);
    expect(out2).toHaveLength(1);
    expect(out2[0]).toEqual(obj);
  });

  test("yields all three objects when three frames arrive in one push", () => {
    const a = { type: "ready", extensionVersion: "1.0.0" };
    const b = {
      type: "lifecycle",
      state: "joined",
      meetingId: "m-1",
      timestamp: "2026-04-18T00:00:00.000Z",
    };
    const c = { type: "diagnostic", level: "error", message: "boom" };
    const combined = Buffer.concat([
      encodeFrame(a),
      encodeFrame(b),
      encodeFrame(c),
    ]);

    const reader = createFrameReader();
    const out = reader.push(combined);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(a);
    expect(out[1]).toEqual(b);
    expect(out[2]).toEqual(c);
  });

  test("throws when a length header claims more than 1,000,000 bytes", () => {
    // Forge a header claiming 2MB followed by no payload — the reader
    // should refuse as soon as it sees the declared length, without waiting
    // for the payload (which will never arrive).
    const header = Buffer.alloc(4);
    header.writeUInt32LE(2_000_000, 0);

    const reader = createFrameReader();
    expect(() => reader.push(header)).toThrow(/exceeds max/i);
  });

  test("encodeFrame throws when the serialized payload exceeds 1,000,000 bytes", () => {
    // Build a JSON value whose UTF-8 encoding is >1MB. 1.1 million ASCII
    // chars comfortably exceeds the cap after JSON-string-quoting.
    const big = "x".repeat(1_100_000);
    expect(() => encodeFrame({ blob: big })).toThrow(/exceeds max/i);
  });

  test("handles many single-byte pushes (worst-case chunking)", () => {
    const obj = { type: "ready", extensionVersion: "1.2.3" };
    const frame = encodeFrame(obj);

    const reader = createFrameReader();
    let collected: unknown[] = [];
    for (let i = 0; i < frame.byteLength; i += 1) {
      const chunk = frame.subarray(i, i + 1);
      collected = collected.concat(reader.push(chunk));
    }
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual(obj);
  });
});
