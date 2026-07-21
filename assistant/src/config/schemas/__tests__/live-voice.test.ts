import { describe, expect, test } from "bun:test";

import {
  LiveVoiceConfigSchema,
  LiveVoiceFrontModelConfigSchema,
  LiveVoiceVadConfigSchema,
  VALID_LIVE_VOICE_MODES,
} from "../live-voice.js";

const PROGRESS_DEFAULTS = {
  enabled: true,
  opsThreshold: 3,
  idleIntervalMs: 5_000,
  minGapMs: 6_000,
  maxPerTurn: 6,
  generationTimeoutMs: 1_500,
};

const FRONT_MODEL_DEFAULTS = {
  endpointDecisionTimeoutMs: 1200,
  endpointExtensionMs: 1500,
  endpointMaxExtensions: 2,
  ackFirstDeltaTimeoutMs: 2500,
  ackGenerationTimeoutMs: 600,
  llmAckText: false,
  progress: PROGRESS_DEFAULTS,
};

describe("LiveVoiceVadConfigSchema", () => {
  test("empty object parses to defaults", () => {
    const parsed = LiveVoiceVadConfigSchema.parse({});
    expect(parsed).toEqual({
      speechEnergyThreshold: 800,
      silenceThresholdMs: 1200,
      maxTurnDurationMs: 30_000,
      bargeInMinSpeechMs: 250,
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
});

describe("LiveVoiceFrontModelConfigSchema", () => {
  test("empty object parses to defaults", () => {
    const parsed = LiveVoiceFrontModelConfigSchema.parse({});
    expect(parsed).toEqual(FRONT_MODEL_DEFAULTS);
  });

  test("accepts overrides", () => {
    const parsed = LiveVoiceFrontModelConfigSchema.parse({
      endpointDecisionTimeoutMs: 400,
      endpointMaxExtensions: 0,
      llmAckText: true,
    });
    expect(parsed.endpointDecisionTimeoutMs).toBe(400);
    expect(parsed.endpointMaxExtensions).toBe(0);
    expect(parsed.llmAckText).toBe(true);
    // Unspecified fields still get defaults
    expect(parsed.endpointExtensionMs).toBe(1500);
    expect(parsed.ackFirstDeltaTimeoutMs).toBe(2500);
    expect(parsed.ackGenerationTimeoutMs).toBe(600);
  });

  test("rejects non-positive endpointDecisionTimeoutMs", () => {
    const result = LiveVoiceFrontModelConfigSchema.safeParse({
      endpointDecisionTimeoutMs: 0,
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative endpointMaxExtensions", () => {
    const result = LiveVoiceFrontModelConfigSchema.safeParse({
      endpointMaxExtensions: -1,
    });
    expect(result.success).toBe(false);
  });

  test("rejects a non-boolean llmAckText", () => {
    const result = LiveVoiceFrontModelConfigSchema.safeParse({
      llmAckText: "yes",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(
        msgs.some((m) => m.includes("liveVoice.frontModel.llmAckText")),
      ).toBe(true);
    }
  });

  test("absent progress namespace parses to full progress defaults", () => {
    const parsed = LiveVoiceFrontModelConfigSchema.parse({});
    expect(parsed.progress).toEqual(PROGRESS_DEFAULTS);
  });

  test("partial progress overrides merge with defaults", () => {
    const parsed = LiveVoiceFrontModelConfigSchema.parse({
      progress: { enabled: false, opsThreshold: 5 },
    });
    expect(parsed.progress.enabled).toBe(false);
    expect(parsed.progress.opsThreshold).toBe(5);
    // Unspecified progress fields still get defaults
    expect(parsed.progress.idleIntervalMs).toBe(5_000);
    expect(parsed.progress.minGapMs).toBe(6_000);
    expect(parsed.progress.maxPerTurn).toBe(6);
    expect(parsed.progress.generationTimeoutMs).toBe(1_500);
  });

  test("accepts a progress.maxPerTurn of 0 (narration disabled by cap)", () => {
    const parsed = LiveVoiceFrontModelConfigSchema.parse({
      progress: { maxPerTurn: 0 },
    });
    expect(parsed.progress.maxPerTurn).toBe(0);
  });

  test("rejects negative progress.maxPerTurn", () => {
    const result = LiveVoiceFrontModelConfigSchema.safeParse({
      progress: { maxPerTurn: -1 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-positive progress.opsThreshold", () => {
    const result = LiveVoiceFrontModelConfigSchema.safeParse({
      progress: { opsThreshold: 0 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects a non-boolean progress.enabled", () => {
    const result = LiveVoiceFrontModelConfigSchema.safeParse({
      progress: { enabled: "yes" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(
        msgs.some((m) => m.includes("liveVoice.frontModel.progress.enabled")),
      ).toBe(true);
    }
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
      },
      frontModel: FRONT_MODEL_DEFAULTS,
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
      frontModel: { endpointDecisionTimeoutMs: 300 },
      maxSessionDurationSeconds: 600,
    });
    expect(parsed.mode).toBe("ptt");
    expect(parsed.vad.silenceThresholdMs).toBe(900);
    // Unspecified vad fields still get defaults
    expect(parsed.vad.speechEnergyThreshold).toBe(800);
    expect(parsed.vad.maxTurnDurationMs).toBe(30_000);
    // Partial frontModel overrides merge with defaults
    expect(parsed.frontModel.endpointDecisionTimeoutMs).toBe(300);
    expect(parsed.frontModel.endpointExtensionMs).toBe(1500);
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
