import { describe, expect, test } from "bun:test";

import {
  LiveVoiceConfigSchema,
  LiveVoiceFluxConfigSchema,
  LiveVoiceFrontModelConfigSchema,
  LiveVoiceVadConfigSchema,
  VALID_LIVE_VOICE_MODES,
} from "../live-voice.js";

const PROGRESS_DEFAULTS = {
  enabled: true,
  opsThreshold: 3,
  idleIntervalMs: 5_000,
  maxSilenceMs: 35_000,
  longOpMs: 15_000,
  minGapMs: 6_000,
  generationTimeoutMs: 1_500,
};

const FRONT_MODEL_DEFAULTS = {
  endpointDecisionTimeoutMs: 1200,
  endpointExtensionMs: 1500,
  endpointMaxExtensions: 2,
  progress: PROGRESS_DEFAULTS,
};

// `eagerEotThreshold` is deliberately absent: it has no default, and leaving it
// unset is what keeps Deepgram from emitting speculative turn events.
const FLUX_DEFAULTS = {
  turnEnd: { enabled: false },
  model: "flux-general-en",
  eotThreshold: 0.7,
  eotTimeoutMs: 5_000,
};

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
      echoDrainSlackMs: 300,
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

  test("accepts echo gate overrides", () => {
    const parsed = LiveVoiceVadConfigSchema.parse({
      echoBargeInMargin: 2.25,
      echoEmaHalfLifeMs: 250,
      echoDrainSlackMs: 500,
    });
    expect(parsed.echoBargeInMargin).toBe(2.25);
    expect(parsed.echoEmaHalfLifeMs).toBe(250);
    expect(parsed.echoDrainSlackMs).toBe(500);
  });

  test("rejects an echo margin that cannot exceed its reference", () => {
    expect(
      LiveVoiceVadConfigSchema.safeParse({ echoBargeInMargin: 1 }).success,
    ).toBe(false);
  });

  test("rejects invalid echo timing values", () => {
    expect(
      LiveVoiceVadConfigSchema.safeParse({ echoEmaHalfLifeMs: 0 }).success,
    ).toBe(false);
    expect(
      LiveVoiceVadConfigSchema.safeParse({ echoEmaHalfLifeMs: 250.5 }).success,
    ).toBe(false);
    expect(
      LiveVoiceVadConfigSchema.safeParse({ echoDrainSlackMs: -1 }).success,
    ).toBe(false);
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
    });
    expect(parsed.endpointDecisionTimeoutMs).toBe(400);
    expect(parsed.endpointMaxExtensions).toBe(0);
    // Unspecified fields still get defaults
    expect(parsed.endpointExtensionMs).toBe(1500);
  });

  test("strips retired generated-ack settings", () => {
    const parsed = LiveVoiceFrontModelConfigSchema.parse({
      ackFirstDeltaTimeoutMs: 2500,
      ackGenerationTimeoutMs: 600,
    });
    expect(parsed).not.toHaveProperty("ackFirstDeltaTimeoutMs");
    expect(parsed).not.toHaveProperty("ackGenerationTimeoutMs");
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
    expect(parsed.progress.maxSilenceMs).toBe(35_000);
    expect(parsed.progress.longOpMs).toBe(15_000);
    expect(parsed.progress.minGapMs).toBe(6_000);
    expect(parsed.progress.generationTimeoutMs).toBe(1_500);
  });

  test("a stale maxPerTurn key is stripped, not rejected", () => {
    // The cap was removed; configs written while it existed must still parse.
    const parsed = LiveVoiceFrontModelConfigSchema.parse({
      progress: { maxPerTurn: 3 },
    });
    expect("maxPerTurn" in parsed.progress).toBe(false);
  });

  test("rejects non-positive progress.opsThreshold", () => {
    const result = LiveVoiceFrontModelConfigSchema.safeParse({
      progress: { opsThreshold: 0 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects a heartbeat ceiling shorter than the idle tick interval", () => {
    // The heartbeat is only checked on the idle tick, so a shorter ceiling
    // could be overshot by a full interval.
    const result = LiveVoiceFrontModelConfigSchema.safeParse({
      progress: { idleIntervalMs: 60_000, maxSilenceMs: 10_000 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((issue) => issue.message);
      expect(
        msgs.some((msg) =>
          msg.includes("liveVoice.frontModel.progress.maxSilenceMs"),
        ),
      ).toBe(true);
    }
    // The floor itself is allowed: the tick is exactly on the ceiling.
    expect(
      LiveVoiceFrontModelConfigSchema.safeParse({
        progress: { idleIntervalMs: 60_000, maxSilenceMs: 60_000 },
      }).success,
    ).toBe(true);
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

describe("LiveVoiceFluxConfigSchema", () => {
  test("empty object parses to defaults, with turn-end off", () => {
    expect(LiveVoiceFluxConfigSchema.parse({})).toEqual(FLUX_DEFAULTS);
  });

  test("an unset eagerEotThreshold is absent, not zero", () => {
    expect("eagerEotThreshold" in LiveVoiceFluxConfigSchema.parse({})).toBe(
      false,
    );
  });

  test("accepts overrides", () => {
    const parsed = LiveVoiceFluxConfigSchema.parse({
      turnEnd: { enabled: true },
      model: "flux-general-multi",
      eotThreshold: 0.85,
      eagerEotThreshold: 0.45,
      eotTimeoutMs: 12_000,
    });
    expect(parsed.turnEnd.enabled).toBe(true);
    expect(parsed.model).toBe("flux-general-multi");
    expect(parsed.eotThreshold).toBe(0.85);
    expect(parsed.eagerEotThreshold).toBe(0.45);
    expect(parsed.eotTimeoutMs).toBe(12_000);
  });

  test("partial overrides merge with defaults", () => {
    const parsed = LiveVoiceFluxConfigSchema.parse({ eotThreshold: 0.6 });
    expect(parsed.eotThreshold).toBe(0.6);
    expect(parsed.turnEnd.enabled).toBe(false);
    expect(parsed.model).toBe("flux-general-en");
    expect(parsed.eotTimeoutMs).toBe(5_000);
  });

  test("rejects an eotThreshold outside 0.5..0.9", () => {
    const above = LiveVoiceFluxConfigSchema.safeParse({ eotThreshold: 0.95 });
    expect(above.success).toBe(false);
    expect(above.error?.issues.map((i) => i.message)).toEqual([
      "liveVoice.flux.eotThreshold must be <= 0.9",
    ]);

    const below = LiveVoiceFluxConfigSchema.safeParse({ eotThreshold: 0.4 });
    expect(below.success).toBe(false);
    expect(below.error?.issues.map((i) => i.message)).toEqual([
      "liveVoice.flux.eotThreshold must be >= 0.5",
    ]);
  });

  test("rejects an eagerEotThreshold outside 0.3..0.9", () => {
    expect(
      LiveVoiceFluxConfigSchema.safeParse({ eagerEotThreshold: 0.2 }).success,
    ).toBe(false);
    expect(
      LiveVoiceFluxConfigSchema.safeParse({ eagerEotThreshold: 0.95 }).success,
    ).toBe(false);
  });

  test("rejects an eotTimeoutMs outside 500..60000, and non-integers", () => {
    expect(
      LiveVoiceFluxConfigSchema.safeParse({ eotTimeoutMs: 499 }).success,
    ).toBe(false);
    expect(
      LiveVoiceFluxConfigSchema.safeParse({ eotTimeoutMs: 60_001 }).success,
    ).toBe(false);
    expect(
      LiveVoiceFluxConfigSchema.safeParse({ eotTimeoutMs: 1_500.5 }).success,
    ).toBe(false);
  });

  test("rejects a non-boolean turnEnd.enabled", () => {
    const result = LiveVoiceFluxConfigSchema.safeParse({
      turnEnd: { enabled: "yes" },
    });
    expect(result.success).toBe(false);
    const msgs = result.error?.issues.map((i) => i.message) ?? [];
    expect(msgs.some((m) => m.includes("liveVoice.flux.turnEnd.enabled"))).toBe(
      true,
    );
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
        echoDrainSlackMs: 300,
      },
      frontModel: FRONT_MODEL_DEFAULTS,
      // Off by default: Flux turn detection is opt-in, so the front-door hold
      // verdict keeps committing turns until it is enabled.
      flux: FLUX_DEFAULTS,
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
      flux: { turnEnd: { enabled: true } },
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
    // Partial flux overrides merge with defaults
    expect(parsed.flux.turnEnd.enabled).toBe(true);
    expect(parsed.flux.eotThreshold).toBe(0.7);
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
