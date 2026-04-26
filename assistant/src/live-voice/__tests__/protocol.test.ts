import { describe, expect, test } from "bun:test";

import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientFrame,
  type LiveVoiceServerFrame,
  parseLiveVoiceBinaryAudioFrame,
  parseLiveVoiceClientTextFrame,
  validateLiveVoiceClientFrame,
} from "../protocol.js";

describe("parseLiveVoiceClientTextFrame", () => {
  test("parses start frames with audio configuration", () => {
    const result = parseLiveVoiceClientTextFrame(
      JSON.stringify({
        type: "start",
        conversationId: "conversation-123",
        audio: {
          mimeType: "audio/pcm",
          sampleRate: 24000,
          channels: 1,
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.frame).toEqual({
      type: "start",
      conversationId: "conversation-123",
      audio: {
        mimeType: "audio/pcm",
        sampleRate: 24000,
        channels: 1,
      },
    });
  });

  test("parses base64 JSON audio frames", () => {
    const result = parseLiveVoiceClientTextFrame(
      JSON.stringify({ type: "audio", dataBase64: "AQIDBA==" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.frame).toEqual({
      type: "audio",
      dataBase64: "AQIDBA==",
    });
  });

  test("parses control frames", () => {
    for (const frame of [
      { type: "ptt_release" },
      { type: "interrupt" },
      { type: "end" },
    ] satisfies LiveVoiceClientFrame[]) {
      const result = parseLiveVoiceClientTextFrame(JSON.stringify(frame));
      expect(result).toEqual({ ok: true, frame });
    }
  });

  test("returns typed protocol errors for invalid JSON", () => {
    const result = parseLiveVoiceClientTextFrame("{");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("invalid_json");
  });

  test("returns typed protocol errors for non-object JSON", () => {
    const result = parseLiveVoiceClientTextFrame("[]");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toMatchObject({
      code: "invalid_frame",
    });
  });

  test("returns typed protocol errors for unknown frame types", () => {
    const result = parseLiveVoiceClientTextFrame(
      JSON.stringify({ type: "pause" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toMatchObject({
      code: "unknown_type",
      field: "type",
      frameType: "pause",
    });
  });

  test("returns typed protocol errors for missing required fields", () => {
    const startResult = parseLiveVoiceClientTextFrame(
      JSON.stringify({ type: "start" }),
    );
    const audioResult = parseLiveVoiceClientTextFrame(
      JSON.stringify({ type: "audio" }),
    );

    expect(startResult.ok).toBe(false);
    if (!startResult.ok) {
      expect(startResult.error).toMatchObject({
        code: "missing_required_field",
        field: "audio",
        frameType: "start",
      });
    }

    expect(audioResult.ok).toBe(false);
    if (!audioResult.ok) {
      expect(audioResult.error).toMatchObject({
        code: "missing_required_field",
        field: "dataBase64",
        frameType: "audio",
      });
    }
  });

  test("returns typed protocol errors for malformed audio payloads", () => {
    const notString = parseLiveVoiceClientTextFrame(
      JSON.stringify({ type: "audio", dataBase64: 42 }),
    );
    const malformed = parseLiveVoiceClientTextFrame(
      JSON.stringify({ type: "audio", dataBase64: "not base64" }),
    );
    const empty = parseLiveVoiceClientTextFrame(
      JSON.stringify({ type: "audio", dataBase64: "" }),
    );

    for (const result of [notString, malformed, empty]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_audio_payload");
      }
    }
  });

  test("validates audio configuration fields", () => {
    const result = validateLiveVoiceClientFrame({
      type: "start",
      audio: {
        mimeType: "audio/wav",
        sampleRate: 24000,
        channels: 1,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toMatchObject({
      code: "invalid_field",
      field: "audio.mimeType",
      frameType: "start",
    });
  });

  test("returns typed protocol errors for missing audio configuration fields", () => {
    const result = validateLiveVoiceClientFrame({
      type: "start",
      audio: {
        mimeType: "audio/pcm",
        channels: 1,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toMatchObject({
      code: "missing_required_field",
      field: "audio.sampleRate",
      frameType: "start",
    });
  });
});

describe("parseLiveVoiceBinaryAudioFrame", () => {
  test("wraps ArrayBuffer binary audio frames", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = parseLiveVoiceBinaryAudioFrame(bytes.buffer);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.frame.type).toBe("binary_audio");
    expect(Array.from(result.frame.data)).toEqual([1, 2, 3]);
  });

  test("wraps ArrayBufferView binary audio frames", () => {
    const source = new Uint8Array([9, 8, 7, 6]);
    const result = parseLiveVoiceBinaryAudioFrame(source.subarray(1, 3));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Array.from(result.frame.data)).toEqual([8, 7]);
  });

  test("returns typed protocol errors for malformed binary audio frames", () => {
    for (const data of ["AQIDBA==", new Uint8Array().buffer]) {
      const result = parseLiveVoiceBinaryAudioFrame(data);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          code: "invalid_audio_payload",
          field: "data",
          frameType: "binary_audio",
        });
      }
    }
  });
});

describe("LiveVoiceServerFrameSequencer", () => {
  test("adds per-session sequence numbers to outbound server frames", () => {
    const sequencer = createLiveVoiceServerFrameSequencer();

    const ready = sequencer.next({
      type: "ready",
      sessionId: "session-123",
      conversationId: "conversation-123",
    });
    const partial = sequencer.next({
      type: "stt_partial",
      text: "hello",
    });
    const tts = sequencer.next({
      type: "tts_audio",
      mimeType: "audio/wav",
      sampleRate: 24000,
      dataBase64: "AQIDBA==",
    });

    expect(ready.seq).toBe(1);
    expect(partial.seq).toBe(2);
    expect(tts.seq).toBe(3);
    expect(sequencer.lastSeq).toBe(3);
  });

  test("keeps sequence numbers independent per session sequencer", () => {
    const firstSession = createLiveVoiceServerFrameSequencer();
    const secondSession = createLiveVoiceServerFrameSequencer();

    expect(
      firstSession.next({
        type: "thinking",
        turnId: "turn-1",
      }).seq,
    ).toBe(1);
    expect(
      firstSession.next({
        type: "assistant_text_delta",
        text: "hello",
      }).seq,
    ).toBe(2);
    expect(
      secondSession.next({
        type: "thinking",
        turnId: "turn-2",
      }).seq,
    ).toBe(1);
  });

  test("preserves the server frame discriminated union after sequencing", () => {
    const sequencer = createLiveVoiceServerFrameSequencer(41);
    const frame: LiveVoiceServerFrame = sequencer.next({
      type: "metrics",
      turnId: "turn-123",
      sttMs: 25,
      llmFirstDeltaMs: null,
      ttsFirstAudioMs: null,
      totalMs: 100,
    });

    expect(frame).toEqual({
      type: "metrics",
      turnId: "turn-123",
      sttMs: 25,
      llmFirstDeltaMs: null,
      ttsFirstAudioMs: null,
      totalMs: 100,
      seq: 42,
    });
  });
});
