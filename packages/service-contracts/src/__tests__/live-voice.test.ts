import { describe, expect, test } from "bun:test";

import { isInterfaceId } from "../channels.js";
import {
  LIVE_VOICE_AUDIO_FORMAT,
  LIVE_VOICE_SERVER_FRAME_TYPES,
  LIVE_VOICE_TURN_DETECTION_MODES,
  LiveVoiceProtocolErrorCode,
  MAX_BARGE_IN_MIN_SPEECH_MS,
  MAX_SILENCE_THRESHOLD_MS,
  MIN_BARGE_IN_MIN_SPEECH_MS,
  MIN_SILENCE_THRESHOLD_MS,
  parseLiveVoiceServerFrame,
  type LiveVoiceClientControlFrame,
  type LiveVoiceClientStartFrame,
  type LiveVoiceLegacyBase64AudioFrame,
  type LiveVoiceMetricsServerFrame,
  type LiveVoiceServerFrame,
} from "../live-voice.js";

describe("live voice client contract", () => {
  test("defines the canonical PCM capture format", () => {
    expect(LIVE_VOICE_AUDIO_FORMAT).toEqual({
      mimeType: "audio/pcm",
      sampleRate: 16_000,
      channels: 1,
    });
  });

  test("defines manual and server VAD modes", () => {
    expect(LIVE_VOICE_TURN_DETECTION_MODES).toEqual(["manual", "server_vad"]);
  });

  test("exports the current turn-detection bounds", () => {
    expect({
      silence: [MIN_SILENCE_THRESHOLD_MS, MAX_SILENCE_THRESHOLD_MS],
      bargeIn: [MIN_BARGE_IN_MIN_SPEECH_MS, MAX_BARGE_IN_MIN_SPEECH_MS],
    }).toEqual({
      silence: [100, 5_000],
      bargeIn: [0, 3_000],
    });
  });

  test("types every JSON control frame", () => {
    const frames = [
      {
        type: "start",
        conversationId: "conversation-123",
        audio: LIVE_VOICE_AUDIO_FORMAT,
        sourceInterface: "cli",
        turnDetection: "server_vad",
        silenceThresholdMs: 900,
        bargeInMinSpeechMs: 200,
      },
      { type: "ptt_release" },
      { type: "interrupt" },
      { type: "end" },
      {
        type: "update_config",
        silenceThresholdMs: 1_200,
        bargeInMinSpeechMs: 400,
      },
    ] as const satisfies readonly LiveVoiceClientControlFrame[];

    expect(frames.map((frame) => frame.type)).toEqual([
      "start",
      "ptt_release",
      "interrupt",
      "end",
      "update_config",
    ]);
  });

  test("keeps sourceInterface optional for older clients", () => {
    const frame = {
      type: "start",
      audio: LIVE_VOICE_AUDIO_FORMAT,
    } satisfies LiveVoiceClientStartFrame;

    expect(frame).not.toHaveProperty("sourceInterface");
  });

  test("accepts canonical source interfaces and rejects invalid values", () => {
    const sourceInterface: LiveVoiceClientStartFrame["sourceInterface"] = "cli";
    type AcceptsInvalidInterface =
      "browser" extends NonNullable<
        LiveVoiceClientStartFrame["sourceInterface"]
      >
        ? true
        : false;
    const acceptsInvalidInterface: AcceptsInvalidInterface = false;

    expect(isInterfaceId(sourceInterface)).toBe(true);
    expect(isInterfaceId("browser")).toBe(false);
    expect(acceptsInvalidInterface).toBe(false);
  });

  test("names legacy base64 audio separately from controls", () => {
    const frame = {
      type: "audio",
      dataBase64: "AQIDBA==",
    } satisfies LiveVoiceLegacyBase64AudioFrame;

    expect(frame.type).toBe("audio");
  });
});

describe("parseLiveVoiceServerFrame", () => {
  const frames = [
    {
      type: "ready",
      seq: 1,
      sessionId: "session-123",
      conversationId: "conversation-123",
      turnDetection: "server_vad",
    },
    { type: "busy", seq: 2, activeSessionId: "session-456" },
    { type: "speech_started", seq: 3 },
    { type: "utterance_end", seq: 4, reason: "silence" },
    { type: "utterance_discarded", seq: 5 },
    { type: "stt_partial", seq: 6, text: "hel" },
    { type: "stt_final", seq: 7, text: "hello" },
    { type: "thinking", seq: 8, turnId: "turn-123" },
    { type: "assistant_text_delta", seq: 9, text: "Hello" },
    {
      type: "tts_audio",
      seq: 10,
      mimeType: "audio/pcm",
      sampleRate: 24_000,
      dataBase64: "AAAA",
    },
    { type: "tts_done", seq: 11, turnId: "turn-123" },
    { type: "turn_cancelled", seq: 12, turnId: "turn-123" },
    { type: "minimize_room", seq: 13, turnId: "turn-123" },
    {
      type: "metrics",
      seq: 14,
      event: "turn_completed",
      sessionId: "session-123",
      conversationId: "conversation-123",
      turnId: "turn-123",
      metrics: { summary: { completedTurnCount: 1 } },
      sttMs: 100,
      llmFirstDeltaMs: 200,
      dispatchToFirstDeltaMs: 180,
      dispatchToFirstAudioMs: 240,
      ttsFirstAudioMs: 50,
      roundTripMs: 350,
      totalMs: 400,
      endpointHoldCount: 1,
      endpointDecisionMaxLatencyMs: 20,
      ackSpoken: "first_delta",
      progressUpdatesSpoken: 2,
    },
    {
      type: "archived",
      seq: 15,
      conversationId: "conversation-123",
      sessionId: "session-123",
      turnId: "turn-123",
      role: "assistant",
      attachmentId: "attachment-123",
      attachmentIds: ["attachment-123"],
      warning: { code: "archive_failed", message: "Archive unavailable" },
    },
    {
      type: "session_released",
      seq: 16,
      sessionId: "session-123",
    },
    {
      type: "error",
      seq: 17,
      code: "invalid_field",
      message: "Invalid field",
      recoverable: true,
    },
  ] as const satisfies readonly LiveVoiceServerFrame[];

  test("covers every current server discriminator", () => {
    expect(frames.map((frame) => frame.type)).toEqual([
      ...LIVE_VOICE_SERVER_FRAME_TYPES,
    ]);
  });

  test("exports every current protocol error code", () => {
    expect(Object.values(LiveVoiceProtocolErrorCode)).toEqual([
      "invalid_json",
      "invalid_frame",
      "unknown_type",
      "missing_required_field",
      "invalid_field",
      "invalid_audio_payload",
      "credentials_unavailable",
    ]);
  });

  for (const frame of frames) {
    test(`round-trips ${frame.type}`, () => {
      expect(parseLiveVoiceServerFrame(JSON.stringify(frame))).toEqual(frame);
    });
  }

  test("allows metrics fields that older frames omit", () => {
    const frame = {
      type: "metrics",
      seq: 1,
      turnId: "turn-123",
      sttMs: null,
      llmFirstDeltaMs: null,
      ttsFirstAudioMs: null,
      totalMs: null,
    } satisfies LiveVoiceMetricsServerFrame;

    expect(parseLiveVoiceServerFrame(JSON.stringify(frame))).toEqual(frame);
  });

  test.each(["{", "null", "[]", "42", '"text"'])(
    "returns invalid_json for malformed input %s",
    (raw) => {
      expect(parseLiveVoiceServerFrame(raw)).toEqual({
        type: "error",
        code: "invalid_json",
        message: expect.any(String),
      });
    },
  );

  test.each([{}, { seq: 1 }, { type: 42, seq: 1 }])(
    "returns invalid_json without a string discriminator",
    (frame) => {
      expect(parseLiveVoiceServerFrame(JSON.stringify(frame))).toEqual({
        type: "error",
        code: "invalid_json",
        message: expect.any(String),
      });
    },
  );

  test("returns unknown_frame for structurally valid future frames", () => {
    expect(
      parseLiveVoiceServerFrame(
        JSON.stringify({
          type: "voice_activity",
          seq: 17,
          confidence: 0.98,
        }),
      ),
    ).toEqual({
      type: "unknown_frame",
      frameType: "voice_activity",
    });
  });

  test("passes known frames through without strict field validation", () => {
    const frame = { type: "thinking", seq: 18, futureField: true } as const;
    expect(parseLiveVoiceServerFrame(JSON.stringify(frame))).toEqual(
      frame as unknown as LiveVoiceServerFrame,
    );
  });
});
