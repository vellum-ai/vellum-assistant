import { describe, expect, test } from "bun:test";

import {
  parsePerceptionEvent,
  PERCEPTION_EVENT_KINDS,
} from "./perception-event.js";

const baseEnvelope = {
  eventId: "evt-1",
  ts: new Date("2026-01-01T00:00:00Z").toISOString(),
  source: { module: "test" },
};

describe("perception-event schemas", () => {
  test("PERCEPTION_EVENT_KINDS contains the new multimodal kinds", () => {
    expect(PERCEPTION_EVENT_KINDS).toContain("screen_snapshot");
    expect(PERCEPTION_EVENT_KINDS).toContain("audio_excerpt");
  });

  test("parses a valid screen_snapshot payload", () => {
    const parsed = parsePerceptionEvent({
      ...baseEnvelope,
      payload: {
        kind: "screen_snapshot",
        conversationId: "conv-1",
        appId: "com.apple.Safari",
        appName: "Safari",
        windowTitle: "Window",
        ocrTextRedacted: "hello world",
        redacted: false,
        captureMethod: "ocr",
        confidence: 0.5,
      },
    });
    expect(parsed.payload.kind).toBe("screen_snapshot");
  });

  test("rejects screen_snapshot missing conversationId", () => {
    expect(() =>
      parsePerceptionEvent({
        ...baseEnvelope,
        payload: {
          kind: "screen_snapshot",
          appId: "com.apple.Safari",
          appName: "Safari",
          windowTitle: "Window",
          ocrTextRedacted: "ok",
          redacted: false,
          captureMethod: "ocr",
          confidence: 0.5,
        },
      }),
    ).toThrow();
  });

  test("rejects screen_snapshot with oversize ocrTextRedacted", () => {
    expect(() =>
      parsePerceptionEvent({
        ...baseEnvelope,
        payload: {
          kind: "screen_snapshot",
          conversationId: "conv-1",
          appId: "com.apple.Safari",
          appName: "Safari",
          windowTitle: "Window",
          ocrTextRedacted: "a".repeat(2049),
          redacted: false,
          captureMethod: "ocr",
          confidence: 0.5,
        },
      }),
    ).toThrow();
  });

  test("rejects screen_snapshot with invalid captureMethod", () => {
    expect(() =>
      parsePerceptionEvent({
        ...baseEnvelope,
        payload: {
          kind: "screen_snapshot",
          conversationId: "conv-1",
          appId: "com.apple.Safari",
          appName: "Safari",
          windowTitle: "Window",
          ocrTextRedacted: "ok",
          redacted: false,
          captureMethod: "screenshot",
          confidence: 0.5,
        },
      }),
    ).toThrow();
  });

  test("parses a valid audio_excerpt payload", () => {
    const parsed = parsePerceptionEvent({
      ...baseEnvelope,
      payload: {
        kind: "audio_excerpt",
        conversationId: "conv-1",
        sessionId: "sess-1",
        turnId: "turn-1",
        transcriptRedacted: "hello",
        confidence: 0.9,
        language: "en-US",
      },
    });
    expect(parsed.payload.kind).toBe("audio_excerpt");
  });

  test("rejects audio_excerpt with oversize transcriptRedacted", () => {
    expect(() =>
      parsePerceptionEvent({
        ...baseEnvelope,
        payload: {
          kind: "audio_excerpt",
          conversationId: "conv-1",
          sessionId: "sess-1",
          turnId: "turn-1",
          transcriptRedacted: "x".repeat(1025),
          confidence: 0.9,
        },
      }),
    ).toThrow();
  });

  test("rejects audio_excerpt with out-of-range confidence", () => {
    expect(() =>
      parsePerceptionEvent({
        ...baseEnvelope,
        payload: {
          kind: "audio_excerpt",
          conversationId: "conv-1",
          sessionId: "sess-1",
          turnId: "turn-1",
          transcriptRedacted: "hi",
          confidence: 1.2,
        },
      }),
    ).toThrow();
  });
});
