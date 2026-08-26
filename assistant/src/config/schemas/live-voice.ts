import { z } from "zod";

export const VALID_LIVE_VOICE_MODES = ["ptt", "open-mic"] as const;

export const LiveVoiceVadConfigSchema = z
  .object({
    speechEnergyThreshold: z
      .number({
        error: "liveVoice.vad.speechEnergyThreshold must be a number",
      })
      .int("liveVoice.vad.speechEnergyThreshold must be an integer")
      .positive(
        "liveVoice.vad.speechEnergyThreshold must be a positive integer",
      )
      .default(800)
      .describe(
        "Mean absolute amplitude (16-bit linear scale) above which a frame counts as speech — mirrors DEFAULT_SPEECH_ENERGY_THRESHOLD in stt/speech-energy.ts",
      ),
    silenceThresholdMs: z
      .number({ error: "liveVoice.vad.silenceThresholdMs must be a number" })
      .int("liveVoice.vad.silenceThresholdMs must be an integer")
      .positive("liveVoice.vad.silenceThresholdMs must be a positive integer")
      .default(1200)
      .describe(
        "Trailing silence duration (ms) after speech that ends the user's turn — the default 'pause before reply'. Clients may override it per-session via the start frame.",
      ),
    maxTurnDurationMs: z
      .number({ error: "liveVoice.vad.maxTurnDurationMs must be a number" })
      .int("liveVoice.vad.maxTurnDurationMs must be an integer")
      .positive("liveVoice.vad.maxTurnDurationMs must be a positive integer")
      .default(30_000)
      .describe(
        "Maximum duration (ms) of a single user turn before it is force-ended",
      ),
    bargeInMinSpeechMs: z
      .number({ error: "liveVoice.vad.bargeInMinSpeechMs must be a number" })
      .int("liveVoice.vad.bargeInMinSpeechMs must be an integer")
      .nonnegative(
        "liveVoice.vad.bargeInMinSpeechMs must be a nonnegative integer",
      )
      .default(250)
      .describe(
        "Sustained speech (ms) required before speech during assistant playback interrupts it — the default 'interrupt sensitivity' (higher = harder to interrupt). 0 disables the guard. Clients may override it per-session via the start frame. Raised from 60 so brief TTS bleed through imperfect echo cancellation no longer self-interrupts the assistant.",
      ),
    echoBargeInMargin: z
      .number({ error: "liveVoice.vad.echoBargeInMargin must be a number" })
      .gt(1, "liveVoice.vad.echoBargeInMargin must be greater than 1")
      .default(1.5)
      .describe(
        "Multiplier over the learned playback echo level that microphone input must exceed to count as speech during playback. Higher values reduce false interruptions but require louder barge-in speech.",
      ),
    echoEmaHalfLifeMs: z
      .number({ error: "liveVoice.vad.echoEmaHalfLifeMs must be a number" })
      .int("liveVoice.vad.echoEmaHalfLifeMs must be an integer")
      .positive("liveVoice.vad.echoEmaHalfLifeMs must be a positive integer")
      .default(400)
      .describe(
        "Half-life (ms) of the learned playback echo level. Smaller values adapt faster to changing speaker volume; larger values are steadier against transients.",
      ),
    echoDrainSlackMs: z
      .number({ error: "liveVoice.vad.echoDrainSlackMs must be a number" })
      .int("liveVoice.vad.echoDrainSlackMs must be an integer")
      .nonnegative(
        "liveVoice.vad.echoDrainSlackMs must be a nonnegative integer",
      )
      .default(300)
      .describe(
        "Time (ms) after the estimated client playback tail during which microphone input can still be classified as playback echo.",
      ),
  })
  .describe(
    "Voice-activity-detection tuning for live voice sessions (open-mic turn segmentation)",
  );

export const LiveVoiceProgressConfigSchema = z
  .object({
    enabled: z
      .boolean({
        error: "liveVoice.frontModel.progress.enabled must be a boolean",
      })
      .default(true)
      .describe(
        "Speak short progress updates during long-running tool-heavy turns; the opt-out for progress narration",
      ),
    opsThreshold: z
      .number({
        error: "liveVoice.frontModel.progress.opsThreshold must be a number",
      })
      .int("liveVoice.frontModel.progress.opsThreshold must be an integer")
      .positive(
        "liveVoice.frontModel.progress.opsThreshold must be a positive integer",
      )
      .default(3)
      .describe(
        "Narrate after this many tool operations since the last narration",
      ),
    idleIntervalMs: z
      .number({
        error: "liveVoice.frontModel.progress.idleIntervalMs must be a number",
      })
      .int("liveVoice.frontModel.progress.idleIntervalMs must be an integer")
      .positive(
        "liveVoice.frontModel.progress.idleIntervalMs must be a positive integer",
      )
      .default(5_000)
      .describe(
        "How often (ms) a running turn's silence is checked, and so the soonest new tool activity is narrated",
      ),
    maxSilenceMs: z
      .number({
        error: "liveVoice.frontModel.progress.maxSilenceMs must be a number",
      })
      .int("liveVoice.frontModel.progress.maxSilenceMs must be an integer")
      .positive(
        "liveVoice.frontModel.progress.maxSilenceMs must be a positive integer",
      )
      .default(35_000)
      .describe(
        "Heartbeat ceiling (ms): narrate after this much unbroken silence even when nothing new has happened. Evaluated on the idle tick, so its resolution is idleIntervalMs and it must be at least that long",
      ),
    longOpMs: z
      .number({
        error: "liveVoice.frontModel.progress.longOpMs must be a number",
      })
      .int("liveVoice.frontModel.progress.longOpMs must be an integer")
      .positive(
        "liveVoice.frontModel.progress.longOpMs must be a positive integer",
      )
      .default(15_000)
      .describe(
        "A tool operation that ran at least this long (ms) narrates the moment it completes, without waiting for opsThreshold",
      ),
    minGapMs: z
      .number({
        error: "liveVoice.frontModel.progress.minGapMs must be a number",
      })
      .int("liveVoice.frontModel.progress.minGapMs must be an integer")
      .positive(
        "liveVoice.frontModel.progress.minGapMs must be a positive integer",
      )
      .default(6_000)
      .describe(
        "Minimum spacing (ms) from any spoken floor-holder — ack or narration",
      ),
    generationTimeoutMs: z
      .number({
        error:
          "liveVoice.frontModel.progress.generationTimeoutMs must be a number",
      })
      .int(
        "liveVoice.frontModel.progress.generationTimeoutMs must be an integer",
      )
      .positive(
        "liveVoice.frontModel.progress.generationTimeoutMs must be a positive integer",
      )
      .default(1_500)
      .describe(
        "Budget (ms) for LLM-generated progress text — not latency-critical: it speaks into dead air",
      ),
  })
  // The heartbeat is checked when the idle tick finds the turn silent, so a
  // ceiling shorter than the tick interval would be missed by up to a full
  // interval — a promise the cadence cannot keep. Rejecting the combination
  // beats silently overshooting it.
  .refine((progress) => progress.maxSilenceMs >= progress.idleIntervalMs, {
    error:
      "liveVoice.frontModel.progress.maxSilenceMs must be at least idleIntervalMs — the heartbeat is evaluated on the idle tick",
  })
  .describe(
    "Progress-narration tuning for live voice sessions (spoken updates during long-running turns)",
  );

export const LiveVoiceFrontModelConfigSchema = z
  .object({
    endpointDecisionTimeoutMs: z
      .number({
        error:
          "liveVoice.frontModel.endpointDecisionTimeoutMs must be a number",
      })
      .int("liveVoice.frontModel.endpointDecisionTimeoutMs must be an integer")
      .positive(
        "liveVoice.frontModel.endpointDecisionTimeoutMs must be a positive integer",
      )
      .default(1200)
      .describe(
        "Hard budget (ms) for the endpoint decision LLM call. This adds to end-of-turn latency when semantic endpointing is on, so keep it as tight as the decider model's real roundtrip allows — measured Haiku roundtrips through the managed proxy run ~670-1130ms (dev), so tighter budgets turn the feature into a fail-open no-op.",
      ),
    endpointExtensionMs: z
      .number({
        error: "liveVoice.frontModel.endpointExtensionMs must be a number",
      })
      .int("liveVoice.frontModel.endpointExtensionMs must be an integer")
      .positive(
        "liveVoice.frontModel.endpointExtensionMs must be a positive integer",
      )
      .default(1500)
      .describe(
        "How long (ms) a 'hold' decision keeps the turn open before turn-end replays",
      ),
    endpointMaxExtensions: z
      .number({
        error: "liveVoice.frontModel.endpointMaxExtensions must be a number",
      })
      .int("liveVoice.frontModel.endpointMaxExtensions must be an integer")
      .nonnegative(
        "liveVoice.frontModel.endpointMaxExtensions must be a nonnegative integer",
      )
      .default(2)
      .describe("Cap on consecutive 'hold' extensions per utterance"),
    progress: LiveVoiceProgressConfigSchema.default(
      LiveVoiceProgressConfigSchema.parse({}),
    ),
  })
  .describe(
    "Voice front-door endpointing and long-turn progress narration tuning",
  );

const LiveVoiceFluxTurnEndConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "liveVoice.flux.turnEnd.enabled must be a boolean" })
      // On by default because it is the only reason to select Flux, and
      // because off is not a neutral setting on this provider: managed Flux
      // exposes no `finalizeUtterance` (Flux commits turns itself), so the
      // session's persistence check falls through and it opens a socket per
      // utterance, putting a full Deepgram handshake on every turn. Ignored
      // by any provider that does not own its turn boundary, so the default
      // reaches only the sessions it is about.
      .default(true)
      .describe(
        "Commit the live-voice turn on Flux's EndOfTurn instead of the front-door [0] hold verdict. Requires the active STT provider to be running the flux model family (services.stt.providers.<provider>.model); ignored otherwise.",
      ),
  })
  .describe(
    "Which signal commits a live voice turn when Deepgram Flux is the STT provider",
  );

export const LiveVoiceFluxConfigSchema = z
  .object({
    turnEnd: LiveVoiceFluxTurnEndConfigSchema.default(
      LiveVoiceFluxTurnEndConfigSchema.parse({}),
    ),
    model: z
      .string({ error: "liveVoice.flux.model must be a string" })
      .optional()
      .describe(
        "Deepgram Flux model to pin when opening the STT stream. Unset (the default) selects the model from services.stt.language: English and unset use the English model, everything else uses the multilingual one",
      ),
    eotThreshold: z
      .number({ error: "liveVoice.flux.eotThreshold must be a number" })
      .min(0.5, "liveVoice.flux.eotThreshold must be >= 0.5")
      .max(0.9, "liveVoice.flux.eotThreshold must be <= 0.9")
      .default(0.7)
      .describe(
        "End-of-turn confidence Flux must reach before it emits EndOfTurn. Lower values commit sooner and cut speakers off more often; higher values wait longer and add end-of-turn latency.",
      ),
    eagerEotThreshold: z
      .number({ error: "liveVoice.flux.eagerEotThreshold must be a number" })
      .min(0.3, "liveVoice.flux.eagerEotThreshold must be >= 0.3")
      .max(0.9, "liveVoice.flux.eagerEotThreshold must be <= 0.9")
      .optional()
      .describe(
        "Confidence at which Flux starts speculating that the turn has ended. Leaving it unset disables Deepgram's EagerEndOfTurn / TurnResumed events; enabling it raises LLM calls 50-70% because speculative turns that resume are thrown away.",
      ),
    eotTimeoutMs: z
      .number({ error: "liveVoice.flux.eotTimeoutMs must be a number" })
      .int("liveVoice.flux.eotTimeoutMs must be an integer")
      .min(500, "liveVoice.flux.eotTimeoutMs must be >= 500")
      .max(60_000, "liveVoice.flux.eotTimeoutMs must be <= 60000")
      .default(5_000)
      .describe(
        "Silence (ms) after which Flux force-ends the turn even though its end-of-turn confidence never reached eotThreshold",
      ),
  })
  .describe(
    "Deepgram Flux turn-detection tuning for live voice sessions (model-integrated end-of-turn)",
  );

export const LiveVoiceConfigSchema = z
  .object({
    mode: z
      .enum(VALID_LIVE_VOICE_MODES, {
        error: `liveVoice.mode must be one of: ${VALID_LIVE_VOICE_MODES.join(", ")}`,
      })
      .default("open-mic")
      .describe(
        "Default microphone mode for live voice sessions — hands-free (open-mic) or push-to-talk (ptt)",
      ),
    vad: LiveVoiceVadConfigSchema.default(LiveVoiceVadConfigSchema.parse({})),
    frontModel: LiveVoiceFrontModelConfigSchema.default(
      LiveVoiceFrontModelConfigSchema.parse({}),
    ),
    flux: LiveVoiceFluxConfigSchema.default(
      LiveVoiceFluxConfigSchema.parse({}),
    ),
    maxSessionDurationSeconds: z
      .number({
        error: "liveVoice.maxSessionDurationSeconds must be a number",
      })
      .int("liveVoice.maxSessionDurationSeconds must be an integer")
      .positive(
        "liveVoice.maxSessionDurationSeconds must be a positive integer",
      )
      .default(1800)
      .describe("Maximum duration of a single live voice session in seconds"),
    archiveAudio: z
      .boolean({ error: "liveVoice.archiveAudio must be a boolean" })
      .default(false)
      .describe(
        "Persist the recorded user + assistant audio of each voice turn as attachments on the conversation messages. Off by default: voice turns carry only their transcribed text, so no audio-file artifacts land in the conversation history. Enable for playback/debugging.",
      ),
  })
  .describe(
    "Live voice (in-app duplex audio) configuration — mic mode, VAD tuning, and session limits",
  );

export type LiveVoiceConfig = z.infer<typeof LiveVoiceConfigSchema>;
export type LiveVoiceVadConfig = z.infer<typeof LiveVoiceVadConfigSchema>;
export type LiveVoiceFrontModelConfig = z.infer<
  typeof LiveVoiceFrontModelConfigSchema
>;
export type LiveVoiceProgressConfig = z.infer<
  typeof LiveVoiceProgressConfigSchema
>;
export type LiveVoiceFluxConfig = z.infer<typeof LiveVoiceFluxConfigSchema>;
