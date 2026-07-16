import { describe, expect, test } from "bun:test";

import {
  LiveVoiceConfigSchema,
  LiveVoiceVadConfigSchema,
  VALID_LIVE_VOICE_MODES,
} from "../live-voice.js";

describe("LiveVoiceVadConfigSchema", () => {
  test("empty object parses to defaults", () => {
    const parsed = LiveVoiceVadConfigSchema.parse({});
    expect(parsed).toEqual({
      speechEnergyThreshold: 800,
      silenceThresholdMs: 1200,
      maxTurnDurationMs: 30_000,
      bargeInMinSpeechMs: 250,
      echoBargeInMargin: 1.5,
      echoEmaHalfLifeMs: 400,
    });
  });

  test("accepts overrides", () => {
    const parsed = LiveVoiceVadConfigSchema.parse({
      speechEnergyThreshold: 1200,
      silenceThresholdMs: 500,
      maxTurnDurationMs: 60_000,
      bargeInMinSpeechMs: 120,
    });
    expect(parsed.speechEnergyThreshold).toBe(1200);
    expect(parsed.silenceThresholdMs).toBe(500);
    expect(parsed.maxTurnDurationMs).toBe(60_000);
    expect(parsed.bargeInMinSpeechMs).toBe(120);
  });

  test("accepts a bargeInMinSpeechMs of 0 (guard disabled)", () => {
    const parsed = LiveVoiceVadConfigSchema.parse({ bargeInMinSpeechMs: 0 });
    expect(parsed.bargeInMinSpeechMs).toBe(0);
  });

  test("rejects negative bargeInMinSpeechMs", () => {
    const result = LiveVoiceVadConfigSchema.safeParse({
      bargeInMinSpeechMs: -1,
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-positive speechEnergyThreshold", () => {
    const result = LiveVoiceVadConfigSchema.safeParse({
      speechEnergyThreshold: 0,
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-integer silenceThresholdMs", () => {
    const result = LiveVoiceVadConfigSchema.safeParse({
      silenceThresholdMs: 800.5,
    });
    expect(result.success).toBe(false);
  });

  test("accepts a fractional echoBargeInMargin", () => {
    const parsed = LiveVoiceVadConfigSchema.parse({ echoBargeInMargin: 2.25 });
    expect(parsed.echoBargeInMargin).toBe(2.25);
  });

  test("rejects non-positive echoBargeInMargin", () => {
    expect(
      LiveVoiceVadConfigSchema.safeParse({ echoBargeInMargin: 0 }).success,
    ).toBe(false);
    expect(
      LiveVoiceVadConfigSchema.safeParse({ echoBargeInMargin: -1.5 }).success,
    ).toBe(false);
  });

  test("rejects non-positive or non-integer echoEmaHalfLifeMs", () => {
    expect(
      LiveVoiceVadConfigSchema.safeParse({ echoEmaHalfLifeMs: 0 }).success,
    ).toBe(false);
    expect(
      LiveVoiceVadConfigSchema.safeParse({ echoEmaHalfLifeMs: 250.5 }).success,
    ).toBe(false);
  });
});

describe("LiveVoiceConfigSchema", () => {
  test("empty object parses to defaults", () => {
    const parsed = LiveVoiceConfigSchema.parse({});
    expect(parsed).toEqual({
      mode: "open-mic",
      vad: {
        speechEnergyThreshold: 800,
        silenceThresholdMs: 1200,
        maxTurnDurationMs: 30_000,
        bargeInMinSpeechMs: 250,
        echoBargeInMargin: 1.5,
        echoEmaHalfLifeMs: 400,
      },
      maxSessionDurationSeconds: 1800,
      // Off by default: voice turns carry only their transcript, no audio
      // artifacts on the conversation messages (JARVIS-1283).
      archiveAudio: false,
    });
  });

  test("archiveAudio can be enabled", () => {
    expect(
      LiveVoiceConfigSchema.parse({ archiveAudio: true }).archiveAudio,
    ).toBe(true);
  });

  test("rejects a non-boolean archiveAudio", () => {
    const result = LiveVoiceConfigSchema.safeParse({ archiveAudio: "yes" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("liveVoice.archiveAudio"))).toBe(true);
    }
  });

  test("accepts overrides", () => {
    const parsed = LiveVoiceConfigSchema.parse({
      mode: "ptt",
      vad: { silenceThresholdMs: 900 },
      maxSessionDurationSeconds: 600,
    });
    expect(parsed.mode).toBe("ptt");
    expect(parsed.vad.silenceThresholdMs).toBe(900);
    // Unspecified vad fields still get defaults
    expect(parsed.vad.speechEnergyThreshold).toBe(800);
    expect(parsed.vad.maxTurnDurationMs).toBe(30_000);
    expect(parsed.maxSessionDurationSeconds).toBe(600);
  });

  test("rejects invalid mode", () => {
    const result = LiveVoiceConfigSchema.safeParse({ mode: "always-on" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("liveVoice.mode"))).toBe(true);
    }
  });

  test("rejects non-positive maxSessionDurationSeconds", () => {
    const result = LiveVoiceConfigSchema.safeParse({
      maxSessionDurationSeconds: -1,
    });
    expect(result.success).toBe(false);
  });

  test("VALID_LIVE_VOICE_MODES lists ptt and open-mic", () => {
    expect(VALID_LIVE_VOICE_MODES).toEqual(["ptt", "open-mic"]);
  });
});
