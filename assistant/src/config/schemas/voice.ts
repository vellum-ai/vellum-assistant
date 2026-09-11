import { z } from "zod";

export const VoiceProgressConfigSchema = z
  .object({
    enabled: z
      .boolean({
        error: "voice.frontModel.progress.enabled must be a boolean",
      })
      .default(true)
      .describe(
        "Speak short progress updates during long-running tool-heavy turns; the opt-out for progress narration",
      ),
    opsThreshold: z
      .number({
        error: "voice.frontModel.progress.opsThreshold must be a number",
      })
      .int("voice.frontModel.progress.opsThreshold must be an integer")
      .positive(
        "voice.frontModel.progress.opsThreshold must be a positive integer",
      )
      .default(3)
      .describe(
        "Narrate after this many tool operations since the last narration",
      ),
    idleIntervalMs: z
      .number({
        error: "voice.frontModel.progress.idleIntervalMs must be a number",
      })
      .int("voice.frontModel.progress.idleIntervalMs must be an integer")
      .positive(
        "voice.frontModel.progress.idleIntervalMs must be a positive integer",
      )
      .default(5_000)
      .describe(
        "How often (ms) a running turn's silence is checked, and so the soonest new tool activity is narrated",
      ),
    maxSilenceMs: z
      .number({
        error: "voice.frontModel.progress.maxSilenceMs must be a number",
      })
      .int("voice.frontModel.progress.maxSilenceMs must be an integer")
      .positive(
        "voice.frontModel.progress.maxSilenceMs must be a positive integer",
      )
      .default(35_000)
      .describe(
        "Heartbeat ceiling (ms): narrate after this much unbroken silence even when nothing new has happened. Evaluated on the idle tick, so its resolution is idleIntervalMs and it must be at least that long",
      ),
    longOpMs: z
      .number({
        error: "voice.frontModel.progress.longOpMs must be a number",
      })
      .int("voice.frontModel.progress.longOpMs must be an integer")
      .positive("voice.frontModel.progress.longOpMs must be a positive integer")
      .default(15_000)
      .describe(
        "A tool operation that ran at least this long (ms) narrates the moment it completes, without waiting for opsThreshold",
      ),
    minGapMs: z
      .number({
        error: "voice.frontModel.progress.minGapMs must be a number",
      })
      .int("voice.frontModel.progress.minGapMs must be an integer")
      .positive("voice.frontModel.progress.minGapMs must be a positive integer")
      .default(6_000)
      .describe(
        "Minimum spacing (ms) from any spoken floor-holder (ack or narration)",
      ),
    generationTimeoutMs: z
      .number({
        error: "voice.frontModel.progress.generationTimeoutMs must be a number",
      })
      .int("voice.frontModel.progress.generationTimeoutMs must be an integer")
      .positive(
        "voice.frontModel.progress.generationTimeoutMs must be a positive integer",
      )
      .default(1_500)
      .describe(
        "Budget (ms) for LLM-generated progress text. Not latency-critical: it speaks into dead air",
      ),
  })
  // The heartbeat is checked when the idle tick finds the turn silent, so a
  // ceiling shorter than the tick interval would be missed by up to a full
  // interval, a promise the cadence cannot keep. Rejecting the combination
  // beats silently overshooting it.
  .refine((progress) => progress.maxSilenceMs >= progress.idleIntervalMs, {
    error:
      "voice.frontModel.progress.maxSilenceMs must be at least idleIntervalMs: the heartbeat is evaluated on the idle tick",
  })
  .describe(
    "Progress-narration tuning for live voice sessions (spoken updates during long-running turns)",
  );

export const VoiceFrontModelConfigSchema = z
  .object({
    endpointDecisionTimeoutMs: z
      .number({
        error: "voice.frontModel.endpointDecisionTimeoutMs must be a number",
      })
      .int("voice.frontModel.endpointDecisionTimeoutMs must be an integer")
      .positive(
        "voice.frontModel.endpointDecisionTimeoutMs must be a positive integer",
      )
      .default(1200)
      .describe(
        "Hard budget (ms) for the endpoint decision LLM call. This adds to end-of-turn latency when semantic endpointing is on, so keep it as tight as the decider model's real roundtrip allows. Measured Haiku roundtrips through the managed proxy run ~670-1130ms (dev), so tighter budgets turn the feature into a fail-open no-op.",
      ),
    endpointExtensionMs: z
      .number({
        error: "voice.frontModel.endpointExtensionMs must be a number",
      })
      .int("voice.frontModel.endpointExtensionMs must be an integer")
      .positive(
        "voice.frontModel.endpointExtensionMs must be a positive integer",
      )
      .default(1500)
      .describe(
        "How long (ms) a 'hold' decision keeps the turn open before turn-end replays",
      ),
    endpointMaxExtensions: z
      .number({
        error: "voice.frontModel.endpointMaxExtensions must be a number",
      })
      .int("voice.frontModel.endpointMaxExtensions must be an integer")
      .nonnegative(
        "voice.frontModel.endpointMaxExtensions must be a nonnegative integer",
      )
      .default(2)
      .describe("Cap on consecutive 'hold' extensions per utterance"),
    progress: VoiceProgressConfigSchema.default(
      VoiceProgressConfigSchema.parse({}),
    ),
  })
  .describe(
    "Voice front-door endpointing and long-turn progress narration tuning, shared by live voice and phone calls",
  );

export const VoiceConfigSchema = z
  .object({
    frontModel: VoiceFrontModelConfigSchema.default(
      VoiceFrontModelConfigSchema.parse({}),
    ),
  })
  .describe(
    "Transport-agnostic voice configuration shared by live voice and phone calls: front-door routing and progress narration tuning",
  );

export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;
export type VoiceFrontModelConfig = z.infer<typeof VoiceFrontModelConfigSchema>;
export type VoiceProgressConfig = z.infer<typeof VoiceProgressConfigSchema>;
