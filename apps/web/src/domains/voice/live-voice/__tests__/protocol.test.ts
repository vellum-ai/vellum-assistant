import { describe, expect, test } from "bun:test";

import {
  base64ToPcm16,
  encodeClientControlFrame,
  encodeClientStartFrame,
  LIVE_VOICE_AUDIO_PCM16K_MONO,
  type LiveVoiceServerFrame,
  parseServerBinaryFrame,
  parseServerTextFrame,
  pcm16ToBase64,
} from "../protocol";

// ---------------------------------------------------------------------------
// Client frame encoders
// ---------------------------------------------------------------------------

describe("encodeClientStartFrame", () => {
  test("encodes a start frame with conversationId", () => {
    const json = encodeClientStartFrame({
      conversationId: "conv-123",
      audio: LIVE_VOICE_AUDIO_PCM16K_MONO,
    });

    expect(JSON.parse(json)).toEqual({
      type: "start",
      conversationId: "conv-123",
      audio: {
        mimeType: "audio/pcm",
        sampleRate: 16000,
        channels: 1,
      },
    });
  });

  test("omits conversationId when not provided", () => {
    const json = encodeClientStartFrame({
      audio: LIVE_VOICE_AUDIO_PCM16K_MONO,
    });
    const parsed = JSON.parse(json);

    expect(parsed).toEqual({
      type: "start",
      audio: {
        mimeType: "audio/pcm",
        sampleRate: 16000,
        channels: 1,
      },
    });
    expect("conversationId" in parsed).toBe(false);
  });

  test("LIVE_VOICE_AUDIO_PCM16K_MONO matches the Swift reference", () => {
    expect(LIVE_VOICE_AUDIO_PCM16K_MONO).toEqual({
      mimeType: "audio/pcm",
      sampleRate: 16000,
      channels: 1,
    });
  });
});

describe("encodeClientControlFrame", () => {
  test("encodes each control frame type", () => {
    for (const type of ["ptt_release", "interrupt", "end"] as const) {
      expect(JSON.parse(encodeClientControlFrame(type))).toEqual({ type });
    }
  });
});

// ---------------------------------------------------------------------------
// Server text frame parsing — round-trip per type
// ---------------------------------------------------------------------------

function roundTripServerFrame(frame: LiveVoiceServerFrame): void {
  const result = parseServerTextFrame(JSON.stringify(frame));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.frame).toEqual(frame);
}

describe("parseServerTextFrame", () => {
  test("round-trips ready frames", () => {
    roundTripServerFrame({
      type: "ready",
      seq: 1,
      sessionId: "session-abc",
      conversationId: "conv-123",
    });
  });

  test("round-trips busy frames", () => {
    roundTripServerFrame({
      type: "busy",
      seq: 1,
      activeSessionId: "session-def",
    });
  });

  test("round-trips stt_partial and stt_final frames", () => {
    roundTripServerFrame({ type: "stt_partial", seq: 2, text: "hel" });
    roundTripServerFrame({ type: "stt_final", seq: 3, text: "hello" });
  });

  test("round-trips thinking frames", () => {
    roundTripServerFrame({ type: "thinking", seq: 4, turnId: "turn-1" });
  });

  test("round-trips assistant_text_delta frames", () => {
    roundTripServerFrame({
      type: "assistant_text_delta",
      seq: 5,
      text: "hi",
    });
  });

  test("round-trips tts_audio frames", () => {
    roundTripServerFrame({
      type: "tts_audio",
      seq: 6,
      mimeType: "audio/wav",
      sampleRate: 24000,
      dataBase64: "AQIDBA==",
    });
  });

  test("round-trips tts_done frames", () => {
    roundTripServerFrame({ type: "tts_done", seq: 7, turnId: "turn-1" });
  });

  test("round-trips metrics frames with all-nullable timings", () => {
    roundTripServerFrame({
      type: "metrics",
      seq: 8,
      turnId: "turn-1",
      sttMs: 25,
      llmFirstDeltaMs: null,
      ttsFirstAudioMs: 100,
      totalMs: null,
    });
  });

  test("round-trips metrics frames with optional fields", () => {
    roundTripServerFrame({
      type: "metrics",
      seq: 9,
      event: "turn_complete",
      sessionId: "session-1",
      conversationId: "conv-1",
      turnId: "turn-1",
      metrics: { extra: "data" },
      sttMs: 10,
      llmFirstDeltaMs: 20,
      ttsFirstAudioMs: 30,
      totalMs: 60,
    });
  });

  test("round-trips archived frames (minimal and full)", () => {
    roundTripServerFrame({
      type: "archived",
      seq: 10,
      conversationId: "conv-1",
      sessionId: "session-1",
    });

    roundTripServerFrame({
      type: "archived",
      seq: 11,
      conversationId: "conv-1",
      sessionId: "session-1",
      turnId: "turn-1",
      role: "assistant",
      attachmentId: "att-1",
      attachmentIds: ["att-1", "att-2"],
      warning: { code: "partial", message: "missing audio" },
    });
  });

  test("round-trips error frames", () => {
    roundTripServerFrame({
      type: "error",
      seq: 12,
      code: "invalid_frame",
      message: "bad",
    });
  });
});

// ---------------------------------------------------------------------------
// Server text frame parsing — negative cases
// ---------------------------------------------------------------------------

describe("parseServerTextFrame error branches", () => {
  test("invalid JSON", () => {
    const result = parseServerTextFrame("{");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_json");
  });

  test("non-object JSON", () => {
    const result = parseServerTextFrame("[]");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_frame");
  });

  test("missing type field", () => {
    const result = parseServerTextFrame(JSON.stringify({ seq: 1 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "missing_required_field",
      field: "type",
    });
  });

  test("non-string type field", () => {
    const result = parseServerTextFrame(JSON.stringify({ type: 5, seq: 1 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "invalid_field", field: "type" });
  });

  test("unknown type", () => {
    const result = parseServerTextFrame(
      JSON.stringify({ type: "pause", seq: 1 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "unknown_type",
      frameType: "pause",
    });
  });

  test("missing seq", () => {
    const result = parseServerTextFrame(
      JSON.stringify({ type: "ready", sessionId: "s", conversationId: "c" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "missing_required_field",
      field: "seq",
    });
  });

  test("non-integer seq", () => {
    const result = parseServerTextFrame(
      JSON.stringify({
        type: "ready",
        seq: -1,
        sessionId: "s",
        conversationId: "c",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "invalid_field", field: "seq" });
  });

  test("ready frame missing sessionId", () => {
    const result = parseServerTextFrame(
      JSON.stringify({ type: "ready", seq: 1, conversationId: "c" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "missing_required_field",
      field: "sessionId",
      frameType: "ready",
    });
  });

  test("busy frame missing activeSessionId", () => {
    const result = parseServerTextFrame(JSON.stringify({ type: "busy", seq: 1 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "missing_required_field",
      field: "activeSessionId",
      frameType: "busy",
    });
  });

  test("stt_partial frame missing text", () => {
    const result = parseServerTextFrame(
      JSON.stringify({ type: "stt_partial", seq: 1 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "missing_required_field",
      field: "text",
      frameType: "stt_partial",
    });
  });

  test("stt_final frame missing text", () => {
    const result = parseServerTextFrame(
      JSON.stringify({ type: "stt_final", seq: 1 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "missing_required_field",
      field: "text",
      frameType: "stt_final",
    });
  });

  test("thinking frame missing turnId", () => {
    const result = parseServerTextFrame(
      JSON.stringify({ type: "thinking", seq: 1 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "missing_required_field",
      field: "turnId",
      frameType: "thinking",
    });
  });

  test("assistant_text_delta frame missing text", () => {
    const result = parseServerTextFrame(
      JSON.stringify({ type: "assistant_text_delta", seq: 1 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "missing_required_field",
      field: "text",
      frameType: "assistant_text_delta",
    });
  });

  test("tts_audio frame missing mimeType", () => {
    const result = parseServerTextFrame(
      JSON.stringify({
        type: "tts_audio",
        seq: 1,
        sampleRate: 24000,
        dataBase64: "AQIDBA==",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "missing_required_field",
      field: "mimeType",
    });
  });

  test("tts_audio frame with malformed base64", () => {
    const result = parseServerTextFrame(
      JSON.stringify({
        type: "tts_audio",
        seq: 1,
        mimeType: "audio/wav",
        sampleRate: 24000,
        dataBase64: "not base64",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_audio_payload");
  });

  test("tts_audio frame with invalid sampleRate", () => {
    const result = parseServerTextFrame(
      JSON.stringify({
        type: "tts_audio",
        seq: 1,
        mimeType: "audio/wav",
        sampleRate: 0,
        dataBase64: "AQIDBA==",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "invalid_field",
      field: "sampleRate",
    });
  });

  test("tts_done frame missing turnId", () => {
    const result = parseServerTextFrame(
      JSON.stringify({ type: "tts_done", seq: 1 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "missing_required_field",
      field: "turnId",
      frameType: "tts_done",
    });
  });

  test("metrics frame with non-integer timing", () => {
    const result = parseServerTextFrame(
      JSON.stringify({
        type: "metrics",
        seq: 1,
        turnId: "turn-1",
        sttMs: "fast",
        llmFirstDeltaMs: null,
        ttsFirstAudioMs: null,
        totalMs: null,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "invalid_field",
      field: "sttMs",
    });
  });

  test("archived frame missing conversationId", () => {
    const result = parseServerTextFrame(
      JSON.stringify({ type: "archived", seq: 1, sessionId: "s" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "missing_required_field",
      field: "conversationId",
      frameType: "archived",
    });
  });

  test("archived frame with invalid role", () => {
    const result = parseServerTextFrame(
      JSON.stringify({
        type: "archived",
        seq: 1,
        conversationId: "c",
        sessionId: "s",
        role: "system",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "invalid_field",
      field: "role",
    });
  });

  test("archived frame with bad attachmentIds", () => {
    const result = parseServerTextFrame(
      JSON.stringify({
        type: "archived",
        seq: 1,
        conversationId: "c",
        sessionId: "s",
        attachmentIds: [1, 2],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "invalid_field",
      field: "attachmentIds",
    });
  });

  test("archived frame with malformed warning", () => {
    const result = parseServerTextFrame(
      JSON.stringify({
        type: "archived",
        seq: 1,
        conversationId: "c",
        sessionId: "s",
        warning: "uh oh",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "invalid_field",
      field: "warning",
    });
  });

  test("error frame with unknown code", () => {
    const result = parseServerTextFrame(
      JSON.stringify({
        type: "error",
        seq: 1,
        code: "totally_made_up",
        message: "bad",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "invalid_field",
      field: "code",
    });
  });

  test("error frame missing message", () => {
    const result = parseServerTextFrame(
      JSON.stringify({ type: "error", seq: 1, code: "invalid_frame" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "missing_required_field",
      field: "message",
    });
  });
});

// ---------------------------------------------------------------------------
// Server binary frame parsing
// ---------------------------------------------------------------------------

describe("parseServerBinaryFrame", () => {
  test("wraps ArrayBuffer payloads", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = parseServerBinaryFrame(bytes.buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.type).toBe("binary_audio");
    expect(Array.from(result.frame.data)).toEqual([1, 2, 3]);
  });

  test("wraps ArrayBufferView payloads", () => {
    const source = new Uint8Array([9, 8, 7, 6]);
    const result = parseServerBinaryFrame(source.subarray(1, 3));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.frame.data)).toEqual([8, 7]);
  });

  test("rejects empty ArrayBuffer", () => {
    const result = parseServerBinaryFrame(new ArrayBuffer(0));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "invalid_audio_payload",
      field: "data",
      frameType: "binary_audio",
    });
  });

  test("rejects empty ArrayBufferView", () => {
    const result = parseServerBinaryFrame(new Uint8Array(0));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_audio_payload");
  });

  test("rejects non-binary payloads", () => {
    const result = parseServerBinaryFrame("AQIDBA==");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_audio_payload");
  });
});

// ---------------------------------------------------------------------------
// Base64 PCM helpers
// ---------------------------------------------------------------------------

describe("pcm16ToBase64 / base64ToPcm16", () => {
  test("round-trips an empty buffer", () => {
    const encoded = pcm16ToBase64(new Int16Array(0));
    expect(encoded).toBe("");
    expect(base64ToPcm16(encoded).length).toBe(0);
  });

  test("round-trips a small buffer", () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 1234, -5678]);
    const encoded = pcm16ToBase64(samples);
    const decoded = base64ToPcm16(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(samples));
  });

  test("round-trips a buffer > 100 kB without stack overflow", () => {
    // 65,536 samples = 128 KiB of PCM16 data, well past the chunk
    // size (32 KiB) so we exercise the chunked-encode path.
    const samples = new Int16Array(65_536);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = ((i * 7919) % 65_536) - 32_768;
    }
    const encoded = pcm16ToBase64(samples);
    expect(encoded.length).toBeGreaterThan(100_000);
    const decoded = base64ToPcm16(encoded);
    expect(decoded.length).toBe(samples.length);
    expect(decoded[0]).toBe(samples[0]);
    expect(decoded[decoded.length - 1]).toBe(samples[samples.length - 1]);
    expect(decoded[12_345]).toBe(samples[12_345]);
  });

  test("base64ToPcm16 throws on odd byte length", () => {
    // 3 bytes of base64 -> invalid for PCM16
    const oddBase64 = btoa("abc");
    expect(() => base64ToPcm16(oddBase64)).toThrow();
  });

  test("base64ToPcm16 throws on malformed base64", () => {
    expect(() => base64ToPcm16("@@@@")).toThrow();
  });

  test("pcm16ToBase64 handles a buffer view that is a subarray", () => {
    const backing = new Int16Array([1, 2, 3, 4, 5, 6]);
    const view = backing.subarray(1, 5);
    const encoded = pcm16ToBase64(view);
    const decoded = base64ToPcm16(encoded);
    expect(Array.from(decoded)).toEqual([2, 3, 4, 5]);
  });
});
