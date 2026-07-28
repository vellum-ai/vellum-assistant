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

  test("parses an update_config frame with both fields", () => {
    const frame = {
      type: "update_config",
      silenceThresholdMs: 1400,
      bargeInMinSpeechMs: 300,
    } satisfies LiveVoiceClientFrame;
    const result = parseLiveVoiceClientTextFrame(JSON.stringify(frame));
    expect(result).toEqual({ ok: true, frame });
  });

  test("parses an update_config frame with a single field, omitting the other", () => {
    const result = parseLiveVoiceClientTextFrame(
      JSON.stringify({ type: "update_config", silenceThresholdMs: 900 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame).toEqual({
      type: "update_config",
      silenceThresholdMs: 900,
    });
  });

  test("parses an empty update_config frame (no-op)", () => {
    const result = parseLiveVoiceClientTextFrame(
      JSON.stringify({ type: "update_config" }),
    );
    expect(result).toEqual({ ok: true, frame: { type: "update_config" } });
  });

  test.each([
    ["silenceThresholdMs", 50],
    ["silenceThresholdMs", 10_000],
    ["bargeInMinSpeechMs", -1],
    ["bargeInMinSpeechMs", 9_000],
  ])("rejects an out-of-range update_config %s=%p", (field, badValue) => {
    const result = validateLiveVoiceClientFrame({
      type: "update_config",
      [field]: badValue,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "invalid_field",
      field,
      frameType: "update_config",
    });
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

  test("parses start frames with turnDetection manual", () => {
    const result = parseLiveVoiceClientTextFrame(
      JSON.stringify({
        type: "start",
        turnDetection: "manual",
        audio: {
          mimeType: "audio/pcm",
          sampleRate: 24000,
          channels: 1,
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.frame).toEqual({
      type: "start",
      turnDetection: "manual",
      audio: {
        mimeType: "audio/pcm",
        sampleRate: 24000,
        channels: 1,
      },
    });
  });

  test("parses start frames with turnDetection server_vad", () => {
    const result = parseLiveVoiceClientTextFrame(
      JSON.stringify({
        type: "start",
        turnDetection: "server_vad",
        audio: {
          mimeType: "audio/pcm",
          sampleRate: 24000,
          channels: 1,
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.frame).toEqual({
      type: "start",
      turnDetection: "server_vad",
      audio: {
        mimeType: "audio/pcm",
        sampleRate: 24000,
        channels: 1,
      },
    });
  });

  test("omits turnDetection when absent from the start frame", () => {
    const result = parseLiveVoiceClientTextFrame(
      JSON.stringify({
        type: "start",
        audio: {
          mimeType: "audio/pcm",
          sampleRate: 24000,
          channels: 1,
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect("turnDetection" in result.frame).toBe(false);
  });

  test("returns typed protocol errors for invalid turnDetection values", () => {
    const result = validateLiveVoiceClientFrame({
      type: "start",
      turnDetection: "client_vad",
      audio: {
        mimeType: "audio/pcm",
        sampleRate: 24000,
        channels: 1,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error).toMatchObject({
      code: "invalid_field",
      field: "turnDetection",
      frameType: "start",
    });
  });

  test("parses per-session silenceThresholdMs and bargeInMinSpeechMs overrides", () => {
    const result = parseLiveVoiceClientTextFrame(
      JSON.stringify({
        type: "start",
        turnDetection: "server_vad",
        silenceThresholdMs: 1500,
        bargeInMinSpeechMs: 400,
        audio: { mimeType: "audio/pcm", sampleRate: 24000, channels: 1 },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame).toMatchObject({
      type: "start",
      silenceThresholdMs: 1500,
      bargeInMinSpeechMs: 400,
    });
  });

  test("accepts bargeInMinSpeechMs of 0 (barge-in guard disabled)", () => {
    const result = parseLiveVoiceClientTextFrame(
      JSON.stringify({
        type: "start",
        bargeInMinSpeechMs: 0,
        audio: { mimeType: "audio/pcm", sampleRate: 24000, channels: 1 },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame).toMatchObject({ bargeInMinSpeechMs: 0 });
  });

  test("omits silenceThresholdMs / bargeInMinSpeechMs when absent", () => {
    const result = parseLiveVoiceClientTextFrame(
      JSON.stringify({
        type: "start",
        audio: { mimeType: "audio/pcm", sampleRate: 24000, channels: 1 },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("silenceThresholdMs" in result.frame).toBe(false);
    expect("bargeInMinSpeechMs" in result.frame).toBe(false);
  });

  test.each([
    ["silenceThresholdMs", 50], // below MIN_SILENCE_THRESHOLD_MS
    ["silenceThresholdMs", 10_000], // above MAX_SILENCE_THRESHOLD_MS
    ["silenceThresholdMs", 800.5], // non-integer
    ["bargeInMinSpeechMs", -1], // below MIN_BARGE_IN_MIN_SPEECH_MS
    ["bargeInMinSpeechMs", 9_000], // above MAX_BARGE_IN_MIN_SPEECH_MS
    ["bargeInMinSpeechMs", 250.5], // non-integer
  ])(
    "returns a typed protocol error for out-of-range %s=%p",
    (field, badValue) => {
      const result = validateLiveVoiceClientFrame({
        type: "start",
        [field]: badValue,
        audio: { mimeType: "audio/pcm", sampleRate: 24000, channels: 1 },
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        code: "invalid_field",
        field,
        frameType: "start",
      });
    },
  );

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

  test("stamps monotonic sequence numbers on server VAD frames", () => {
    const sequencer = createLiveVoiceServerFrameSequencer();

    const speechStarted: LiveVoiceServerFrame = sequencer.next({
      type: "speech_started",
    });
    const utteranceEnd: LiveVoiceServerFrame = sequencer.next({
      type: "utterance_end",
      reason: "silence",
    });
    const turnCancelled: LiveVoiceServerFrame = sequencer.next({
      type: "turn_cancelled",
      turnId: "turn-123",
    });

    expect(speechStarted).toEqual({ type: "speech_started", seq: 1 });
    expect(utteranceEnd).toEqual({
      type: "utterance_end",
      reason: "silence",
      seq: 2,
    });
    expect(turnCancelled).toEqual({
      type: "turn_cancelled",
      turnId: "turn-123",
      seq: 3,
    });
    expect(sequencer.lastSeq).toBe(3);
  });

  test("preserves the ready frame's turnDetection echo", () => {
    const sequencer = createLiveVoiceServerFrameSequencer();

    const manualReady: LiveVoiceServerFrame = sequencer.next({
      type: "ready",
      sessionId: "session-123",
      conversationId: "conversation-123",
      turnDetection: "manual",
    });
    const vadReady: LiveVoiceServerFrame = sequencer.next({
      type: "ready",
      sessionId: "session-123",
      conversationId: "conversation-123",
      turnDetection: "server_vad",
    });

    expect(manualReady).toEqual({
      type: "ready",
      seq: 1,
      sessionId: "session-123",
      conversationId: "conversation-123",
      turnDetection: "manual",
    });
    expect(vadReady).toEqual({
      type: "ready",
      seq: 2,
      sessionId: "session-123",
      conversationId: "conversation-123",
      turnDetection: "server_vad",
    });
  });

  test("preserves the error frame's recoverable flag", () => {
    const sequencer = createLiveVoiceServerFrameSequencer();

    const recoverable: LiveVoiceServerFrame = sequencer.next({
      type: "error",
      code: "invalid_field",
      message: "transient transcriber error",
      recoverable: true,
    });
    const terminal: LiveVoiceServerFrame = sequencer.next({
      type: "error",
      code: "invalid_field",
      message: "startup failed",
    });

    expect(recoverable).toEqual({
      type: "error",
      seq: 1,
      code: "invalid_field",
      message: "transient transcriber error",
      recoverable: true,
    });
    expect(terminal).toEqual({
      type: "error",
      seq: 2,
      code: "invalid_field",
      message: "startup failed",
    });
  });

  test("sequences utterance_discarded frames", () => {
    const sequencer = createLiveVoiceServerFrameSequencer();

    const discarded: LiveVoiceServerFrame = sequencer.next({
      type: "utterance_discarded",
    });

    expect(discarded).toEqual({ type: "utterance_discarded", seq: 1 });
    expect(sequencer.lastSeq).toBe(1);
  });

  test("sequences both utterance_end reasons", () => {
    const sequencer = createLiveVoiceServerFrameSequencer();

    const silence = sequencer.next({
      type: "utterance_end",
      reason: "silence",
    });
    const maxDuration = sequencer.next({
      type: "utterance_end",
      reason: "max-duration",
    });

    expect(silence).toEqual({
      type: "utterance_end",
      reason: "silence",
      seq: 1,
    });
    expect(maxDuration).toEqual({
      type: "utterance_end",
      reason: "max-duration",
      seq: 2,
    });
  });

  test("preserves the server frame discriminated union after sequencing", () => {
    const sequencer = createLiveVoiceServerFrameSequencer(41);
    const frame: LiveVoiceServerFrame = sequencer.next({
      type: "metrics",
      turnId: "turn-123",
      sttMs: 25,
      llmFirstDeltaMs: null,
      ttsFirstAudioMs: null,
      roundTripMs: null,
      totalMs: 100,
    });

    expect(frame).toEqual({
      type: "metrics",
      turnId: "turn-123",
      sttMs: 25,
      llmFirstDeltaMs: null,
      ttsFirstAudioMs: null,
      roundTripMs: null,
      totalMs: 100,
      seq: 42,
    });
  });
});
