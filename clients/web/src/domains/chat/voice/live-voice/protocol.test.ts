import { describe, expect, test } from "bun:test";

import {
  parseServerFrame,
  type LiveVoiceServerFrame,
} from "@/domains/chat/voice/live-voice/protocol";

describe("parseServerFrame", () => {
  const frames: LiveVoiceServerFrame[] = [
    { type: "ready", seq: 1, sessionId: "s1", conversationId: "c1" },
    { type: "busy", seq: 2, activeSessionId: "s9" },
    { type: "stt_partial", seq: 3, text: "hel" },
    { type: "stt_final", seq: 4, text: "hello" },
    { type: "turn_boundary", seq: 12 },
    { type: "interrupted", seq: 13, turnId: "t1" },
    { type: "thinking", seq: 5, turnId: "t1" },
    { type: "assistant_text_delta", seq: 6, text: "hi" },
    {
      type: "tts_audio",
      seq: 7,
      mimeType: "audio/pcm",
      sampleRate: 24000,
      dataBase64: "AAAA",
    },
    { type: "tts_done", seq: 8, turnId: "t1" },
    { type: "turn_cancelled", seq: 14, reason: "empty_transcript" },
    { type: "session_ended", seq: 15, reason: "Call completed" },
    {
      type: "metrics",
      seq: 9,
      turnId: "t1",
      sttMs: 120,
      llmFirstDeltaMs: 200,
      ttsFirstAudioMs: null,
      totalMs: null,
    },
    {
      type: "archived",
      seq: 10,
      conversationId: "c1",
      sessionId: "s1",
      turnId: "t1",
      role: "assistant",
      attachmentId: "a1",
      attachmentIds: ["a1", "a2"],
      warning: { code: "w", message: "warn" },
    },
    { type: "error", seq: 11, code: "boom", message: "bad" },
  ];

  for (const frame of frames) {
    test(`round-trips ${frame.type} frame`, () => {
      const result = parseServerFrame(JSON.stringify(frame));
      expect(result).toEqual(frame);
    });
  }

  test("returns invalid_json for malformed JSON", () => {
    const result = parseServerFrame("{not json");
    expect(result).toEqual({
      type: "error",
      code: "invalid_json",
      message: expect.any(String),
    });
  });

  test("returns invalid_json for non-object JSON", () => {
    for (const raw of ["42", '"str"', "null", "[]"]) {
      expect(parseServerFrame(raw)).toEqual({
        type: "error",
        code: "invalid_json",
        message: expect.any(String),
      });
    }
  });

  test("returns invalid_json for unknown frame type", () => {
    const result = parseServerFrame(
      JSON.stringify({ type: "made_up", seq: 1 }),
    );
    expect(result).toEqual({
      type: "error",
      code: "invalid_json",
      message: expect.any(String),
    });
  });

  test("returns invalid_json for missing type", () => {
    const result = parseServerFrame(JSON.stringify({ seq: 1, text: "x" }));
    expect(result).toEqual({
      type: "error",
      code: "invalid_json",
      message: expect.any(String),
    });
  });
});
