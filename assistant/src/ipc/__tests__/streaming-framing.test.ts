/**
 * Unit tests for IpcFrameReader — pure in-memory, no network.
 */

import { describe, expect, test } from "bun:test";

import { IpcFrameReader, type StreamCallbacks } from "../ipc-framing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a single length-prefixed frame: 4-byte big-endian length + payload. */
function buildFrame(payload: Uint8Array | Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, Buffer.from(payload)]);
}

/** Build a zero-length terminator frame (4 bytes of 0x00). */
function buildTerminator(): Buffer {
  return Buffer.alloc(4);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IpcFrameReader", () => {
  test("parses JSON-only envelope", () => {
    const envelope = { id: "req-1", result: { foo: "bar" } };
    const json = Buffer.from(JSON.stringify(envelope), "utf-8");
    const frame = buildFrame(json);

    const received: Array<{ envelope: unknown; binary: Uint8Array | undefined }> = [];

    const reader = new IpcFrameReader((env, binary) => {
      received.push({ envelope: env, binary });
    });

    reader.push(frame);

    expect(received).toHaveLength(1);
    expect(received[0].envelope).toEqual(envelope);
    expect(received[0].binary).toBeUndefined();
  });

  test("parses envelope + binary frame (content-length)", () => {
    const binaryData = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);

    const envelope = {
      id: "req-2",
      result: "ok",
      headers: { "content-length": "5" },
    };
    const jsonFrame = buildFrame(Buffer.from(JSON.stringify(envelope), "utf-8"));
    const binaryFrame = buildFrame(Buffer.from(binaryData));

    const allData = Buffer.concat([jsonFrame, binaryFrame]);

    const received: Array<{ envelope: unknown; binary: Uint8Array | undefined }> = [];

    const reader = new IpcFrameReader((env, binary) => {
      received.push({ envelope: env, binary });
    });

    reader.push(allData);

    expect(received).toHaveLength(1);
    expect(received[0].envelope).toEqual(envelope);
    expect(received[0].binary).toBeInstanceOf(Uint8Array);
    expect(received[0].binary).toHaveLength(5);
    expect(Array.from(received[0].binary!)).toEqual([0x01, 0x02, 0x03, 0x04, 0x05]);
  });

  test("parses chunked stream (transfer-encoding: chunked)", () => {
    const chunk1 = new Uint8Array([0x61, 0x62]); // "ab"
    const chunk2 = new Uint8Array([0x63, 0x64, 0x65]); // "cde"

    const envelope = {
      id: "req-3",
      headers: { "transfer-encoding": "chunked" },
    };
    const jsonFrame = buildFrame(Buffer.from(JSON.stringify(envelope), "utf-8"));
    const chunk1Frame = buildFrame(Buffer.from(chunk1));
    const chunk2Frame = buildFrame(Buffer.from(chunk2));
    const terminator = buildTerminator();

    const allData = Buffer.concat([jsonFrame, chunk1Frame, chunk2Frame, terminator]);

    const events: string[] = [];
    let startEnvelope: unknown = null;
    const chunks: Uint8Array[] = [];

    const streamCallbacks: StreamCallbacks = {
      onStreamStart: (env) => {
        events.push("start");
        startEnvelope = env;
      },
      onStreamChunk: (chunk) => {
        events.push("chunk");
        chunks.push(chunk);
      },
      onStreamEnd: () => {
        events.push("end");
      },
    };

    const reader = new IpcFrameReader(
      (_env, _binary) => {
        events.push("message");
      },
      undefined,
      streamCallbacks,
    );

    reader.push(allData);

    expect(events).toEqual(["start", "chunk", "chunk", "end"]);
    expect(startEnvelope).toEqual(envelope);
    expect(chunks).toHaveLength(2);
    expect(Array.from(chunks[0])).toEqual([0x61, 0x62]);
    expect(Array.from(chunks[1])).toEqual([0x63, 0x64, 0x65]);
  });

  test("detects legacy newline-JSON", () => {
    const legacyPayload = JSON.stringify({ id: "x", result: 1 }) + "\n";
    const buf = Buffer.from(legacyPayload, "utf-8");

    const received: Array<{ envelope: unknown; binary: Uint8Array | undefined }> = [];

    const reader = new IpcFrameReader((env, binary) => {
      received.push({ envelope: env, binary });
    });

    reader.push(buf);

    expect(received).toHaveLength(1);
    expect(received[0].envelope).toEqual({ id: "x", result: 1 });
    expect(reader.isLegacy).toBe(true);
  });
});
