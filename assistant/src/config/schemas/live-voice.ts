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
  })
  .describe(
    "Voice-activity-detection tuning for live voice sessions (open-mic turn segmentation)",
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
      .default(250)
      .describe(
        "Hard budget (ms) for the endpoint decision LLM call. This adds to end-of-turn latency when semantic endpointing is on, so keep it tight.",
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
    ackFirstDeltaTimeoutMs: z
      .number({
        error: "liveVoice.frontModel.ackFirstDeltaTimeoutMs must be a number",
      })
      .int("liveVoice.frontModel.ackFirstDeltaTimeoutMs must be an integer")
      .positive(
        "liveVoice.frontModel.ackFirstDeltaTimeoutMs must be a positive integer",
      )
      .default(2500)
      .describe(
        "Keyword-delay budget (ms): a spoken ack fires if no first assistant delta has arrived by then",
      ),
    ackGenerationTimeoutMs: z
      .number({
        error: "liveVoice.frontModel.ackGenerationTimeoutMs must be a number",
      })
      .int("liveVoice.frontModel.ackGenerationTimeoutMs must be an integer")
      .positive(
        "liveVoice.frontModel.ackGenerationTimeoutMs must be a positive integer",
      )
      .default(600)
      .describe("Budget (ms) for LLM-generated ack text"),
    llmAckText: z
      .boolean({ error: "liveVoice.frontModel.llmAckText must be a boolean" })
      .default(false)
      .describe(
        "Use the front model to phrase spoken acks; static phrases otherwise",
      ),
  })
  .describe(
    "Front-model presence layer tuning for live voice sessions (semantic endpointing + spoken acks)",
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
