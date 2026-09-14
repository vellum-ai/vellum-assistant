import { z } from "zod";

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
    noiseFloorMargin: z
      .number({ error: "liveVoice.vad.noiseFloorMargin must be a number" })
      .nonnegative("liveVoice.vad.noiseFloorMargin must be nonnegative")
      .default(3)
      .describe(
        "Multiple of the room's measured background noise level that the speech gate is raised to, so a noisy room does not read as continuous speech. The gate never falls below speechEnergyThreshold and never exceeds 4x it. 0 disables the adaptation and pins the gate to speechEnergyThreshold.",
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
    vad: LiveVoiceVadConfigSchema.default(LiveVoiceVadConfigSchema.parse({})),
    flux: LiveVoiceFluxConfigSchema.default(
      LiveVoiceFluxConfigSchema.parse({}),
    ),
    archiveAudio: z
      .boolean({ error: "liveVoice.archiveAudio must be a boolean" })
      .default(false)
      .describe(
        "Persist the recorded user + assistant audio of each voice turn as attachments on the conversation messages. Off by default: voice turns carry only their transcribed text, so no audio-file artifacts land in the conversation history. Enable for playback/debugging.",
      ),
  })
  .describe(
    "Live voice (in-app duplex audio) configuration: VAD tuning, Flux turn detection, and audio archiving",
  );

export type LiveVoiceConfig = z.infer<typeof LiveVoiceConfigSchema>;
export type LiveVoiceVadConfig = z.infer<typeof LiveVoiceVadConfigSchema>;
export type LiveVoiceFluxConfig = z.infer<typeof LiveVoiceFluxConfigSchema>;
