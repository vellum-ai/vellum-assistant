import { z } from "zod";

import { BUILTIN_PORCUPINE_KEYWORDS } from "../../voice/wake-word/types.js";

/**
 * Wake-word configuration. The wake-word subsystem is opt-in:
 * `enabled: false` (the default) means clients fall back to push-to-talk
 * even when the rest of the live-voice pipeline is online. The Picovoice
 * access key is provisioned out-of-band via the credential store; only
 * the runtime knobs live in `config.json`.
 */
const WakeWordKeywordSchema = z
  .object({
    label: z
      .string()
      .min(1)
      .describe(
        "Display label for this keyword (e.g. 'Jarvis'). Surfaced in HUD/transcript metadata.",
      ),
    source: z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("builtin"),
          keyword: z.enum(BUILTIN_PORCUPINE_KEYWORDS, {
            error: `voice.wakeWord.keywords[].source.keyword must be one of ${BUILTIN_PORCUPINE_KEYWORDS.join(", ")}`,
          }),
        }),
        z.object({
          kind: z.literal("file"),
          path: z
            .string()
            .min(1)
            .describe("Absolute path to a Picovoice .ppn keyword file."),
        }),
      ])
      .describe(
        "Keyword source — either a Porcupine built-in keyword (no asset required) or a custom .ppn file.",
      ),
    sensitivity: z
      .number()
      .min(0)
      .max(1)
      .default(0.55)
      .describe(
        "Detection sensitivity in [0, 1]. Higher values fire more easily but increase false positives.",
      ),
  })
  .describe("Single wake-word keyword definition.");

export const WakeWordConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "When true, clients should run continuous wake-word detection. When false, voice activation requires push-to-talk.",
      ),
    provider: z
      .enum(["picovoice-porcupine"])
      .default("picovoice-porcupine")
      .describe(
        "Wake-word engine. Currently only Picovoice Porcupine is supported.",
      ),
    keywords: z
      .array(WakeWordKeywordSchema)
      .default([
        {
          label: "Jarvis",
          source: { kind: "builtin", keyword: "jarvis" },
          sensitivity: 0.55,
        },
      ])
      .describe(
        "Ordered list of wake-word keywords. The first match wins when keywords overlap.",
      ),
    /**
     * If true, clients should run wake-word detection in-process (e.g.
     * `@picovoice/porcupine-web` inside the Tauri WebView) rather than
     * forwarding raw audio to the daemon. Lower latency and lower
     * bandwidth at the cost of distributing the access key.
     */
    runOnClient: z
      .boolean()
      .default(true)
      .describe(
        "When true, the client runs wake-word detection locally and only opens an audio stream to the daemon after wake. When false, the daemon does detection on a continuous client audio stream.",
      ),
  })
  .describe(
    "Wake-word detection configuration. Drives always-on voice activation.",
  );

export type WakeWordConfig = z.infer<typeof WakeWordConfigSchema>;
export type WakeWordKeywordConfigInput = z.infer<typeof WakeWordKeywordSchema>;

/**
 * Voice activity detection / endpointing knobs used by the always-on
 * voice loop. The daemon honors these via the live-voice session state
 * machine; clients that run their own VAD should mirror them.
 */
export const VoiceVadConfigSchema = z
  .object({
    silenceMs: z
      .number()
      .int()
      .min(100)
      .max(5_000)
      .default(700)
      .describe(
        "Trailing-silence threshold (ms) that ends an active utterance after wake.",
      ),
    minUtteranceMs: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .default(300)
      .describe(
        "Minimum utterance duration before silence detection can fire — guards against early endpointing on click/breath.",
      ),
    maxUtteranceMs: z
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(20_000)
      .describe(
        "Hard cap (ms) on a single utterance. Forces an endpoint even if VAD never sees silence.",
      ),
  })
  .describe(
    "Voice-activity-detection thresholds for the always-on listening loop.",
  )
  .superRefine((config, ctx) => {
    if (config.minUtteranceMs >= config.maxUtteranceMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minUtteranceMs"],
        message:
          "voice.vad.minUtteranceMs must be less than voice.vad.maxUtteranceMs",
      });
    }
  });

export type VoiceVadConfig = z.infer<typeof VoiceVadConfigSchema>;

/**
 * Top-level `voice.*` configuration block. Currently scoped to
 * always-on voice / wake-word concerns; per-conversation TTS settings
 * live under `services.tts` and `tts.*`.
 */
export const VoiceConfigSchema = z
  .object({
    alwaysOn: z
      .boolean()
      .default(false)
      .describe(
        "When true, clients open a continuous live-voice channel on launch and listen for the wake word. When false, voice activation is push-to-talk only.",
      ),
    wakeWord: WakeWordConfigSchema.default(WakeWordConfigSchema.parse({})),
    vad: VoiceVadConfigSchema.default(VoiceVadConfigSchema.parse({})),
    /**
     * Optional LiveKit / WebRTC realtime transport configuration. The
     * built-in WebSocket transport in `assistant/src/live-voice/` is
     * the default; setting `livekit.enabled: true` lets a deployment
     * route audio through a self-hosted LiveKit server instead. The
     * actual API key/secret are read from environment variables (see
     * safe-env) — only the URL is configured here.
     */
    livekit: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "When true, the daemon publishes voice rooms to a LiveKit server instead of using the built-in WebSocket transport.",
          ),
        url: z
          .string()
          .default("ws://localhost:7880")
          .describe("LiveKit server URL (ws:// or wss://)."),
      })
      .default({ enabled: false, url: "ws://localhost:7880" })
      .describe(
        "LiveKit realtime transport — opt-in. Falls back to the built-in WebSocket pipeline when disabled.",
      ),
  })
  .describe(
    "Voice subsystem configuration: always-on listening, wake word, VAD endpointing, and realtime transport.",
  );

export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;
