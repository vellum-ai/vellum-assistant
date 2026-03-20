import { z } from "zod";

export const FishAudioConfigSchema = z
  .object({
    referenceId: z
      .string({ error: "fishAudio.referenceId must be a string" })
      .default("")
      .describe("Fish Audio voice/clone reference ID"),
    chunkLength: z
      .number({ error: "fishAudio.chunkLength must be a number" })
      .int("fishAudio.chunkLength must be an integer")
      .min(100, "fishAudio.chunkLength must be >= 100")
      .max(300, "fishAudio.chunkLength must be <= 300")
      .default(200)
      .describe("Text chunk size for streaming synthesis"),
    format: z
      .enum(["mp3", "wav", "opus"], {
        error: "fishAudio.format must be one of: mp3, wav, opus",
      })
      .default("mp3")
      .describe("Output audio format"),
    latency: z
      .enum(["normal", "balanced"], {
        error: "fishAudio.latency must be one of: normal, balanced",
      })
      .default("normal")
      .describe(
        "Latency/quality tradeoff for Fish Audio S2 synthesis. 'normal' prioritizes lower latency; 'balanced' trades latency for higher quality.",
      ),
    speed: z
      .number({ error: "fishAudio.speed must be a number" })
      .min(0.5, "fishAudio.speed must be >= 0.5")
      .max(2.0, "fishAudio.speed must be <= 2.0")
      .default(1.0)
      .describe("Playback speed multiplier (0.5 = slower, 2.0 = faster)"),
  })
  .describe("Fish Audio text-to-speech configuration");

export type FishAudioConfig = z.infer<typeof FishAudioConfigSchema>;
