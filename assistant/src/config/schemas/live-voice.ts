import { z } from "zod";

import type { LiveVoiceSessionMode } from "../../live-voice/protocol.js";

/**
 * Valid live-voice microphone modes. The wire source of truth is the
 * protocol's `LiveVoiceSessionMode` (`live-voice/protocol.ts`), whose
 * backing const is module-private — the values are restated here for the
 * zod enum, with `satisfies` proving every listed mode is a valid protocol
 * mode (the schema test asserts the reverse direction, so the two lists
 * cannot drift). The type-only import is erased at runtime, so this adds
 * no config→live-voice runtime dependency.
 */
export const VALID_LIVE_VOICE_MODES = [
  "ptt",
  "open-mic",
] as const satisfies readonly LiveVoiceSessionMode[];

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
        "Mean absolute amplitude (16-bit linear scale) above which a frame counts as speech — matches the phone stack's SPEECH_ENERGY_THRESHOLD",
      ),
    silenceThresholdMs: z
      .number({ error: "liveVoice.vad.silenceThresholdMs must be a number" })
      .int("liveVoice.vad.silenceThresholdMs must be an integer")
      .positive("liveVoice.vad.silenceThresholdMs must be a positive integer")
      .default(800)
      .describe(
        "Trailing silence duration (ms) after speech that ends the user's turn",
      ),
    maxTurnDurationMs: z
      .number({ error: "liveVoice.vad.maxTurnDurationMs must be a number" })
      .int("liveVoice.vad.maxTurnDurationMs must be an integer")
      .positive("liveVoice.vad.maxTurnDurationMs must be a positive integer")
      .default(30_000)
      .describe(
        "Maximum duration (ms) of a single user turn before it is force-ended",
      ),
  })
  .describe(
    "Voice-activity-detection tuning for live voice sessions (open-mic turn segmentation)",
  );

export const LiveVoiceConfigSchema = z
  .object({
    mode: z
      .enum(VALID_LIVE_VOICE_MODES, {
        error: `liveVoice.mode must be one of: ${VALID_LIVE_VOICE_MODES.join(", ")}`,
      })
      .default("ptt")
      .describe(
        "Default microphone mode for live voice sessions — push-to-talk (ptt) or hands-free (open-mic)",
      ),
    vad: LiveVoiceVadConfigSchema.default(LiveVoiceVadConfigSchema.parse({})),
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
  })
  .describe(
    "Live voice (in-app duplex audio) configuration — mic mode, VAD tuning, and session limits",
  );

export type LiveVoiceConfig = z.infer<typeof LiveVoiceConfigSchema>;
export type LiveVoiceVadConfig = z.infer<typeof LiveVoiceVadConfigSchema>;
