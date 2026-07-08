import type { FishAudioConfig } from "../config/schemas/fish-audio.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { readChunkedBody } from "../tts/stream-read.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("fish-audio-client");

/**
 * Config accepted by the synthesis client. Widens the user-facing format
 * union with `"pcm"` (raw 16-bit LE, no container), which PCM-requesting
 * callers substitute internally — it is not part of the config schema.
 */
export type FishAudioSynthesisConfig = Omit<FishAudioConfig, "format"> & {
  format: FishAudioConfig["format"] | "pcm";
};

// ---------------------------------------------------------------------------
// Fish Audio REST API (POST /v1/tts)
// ---------------------------------------------------------------------------

interface SynthesizeOptions {
  onChunk?: (chunk: Uint8Array) => void;
  signal?: AbortSignal;
  /** PCM sample rate to request (Fish `sample_rate`). Omitted = API default. */
  sampleRate?: number;
}

/**
 * Synthesize text to audio using the Fish Audio REST API with the s2-pro
 * model. Streams audio chunks via the optional `onChunk` callback as they
 * arrive from the server's chunked transfer-encoded response. Returns the
 * complete audio buffer when the response finishes.
 *
 * Pass an `AbortSignal` to cancel in-flight synthesis (e.g. on barge-in).
 */
export async function synthesizeWithFishAudio(
  text: string,
  config: FishAudioSynthesisConfig,
  options?: SynthesizeOptions,
): Promise<Buffer> {
  const apiKey = await getSecureKeyAsync(
    credentialKey("fish-audio", "api_key"),
  );
  if (!apiKey) {
    throw new Error(
      "Fish Audio API key not configured. Store it via: assistant credentials set --service fish-audio --field api_key <key>",
    );
  }

  const body = {
    text,
    reference_id: config.referenceId || undefined,
    model: "s2-pro",
    format: config.format,
    sample_rate: options?.sampleRate,
    mp3_bitrate: 192,
    chunk_length: config.chunkLength,
    normalize: true,
    latency: config.latency,
    temperature: 1.0,
    prosody: config.speed !== 1.0 ? { speed: config.speed } : undefined,
  };

  log.info(
    {
      referenceId: config.referenceId,
      format: config.format,
      textLength: text.length,
    },
    "Starting Fish Audio synthesis",
  );

  const response = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Fish Audio API error (${response.status}): ${errorText}`);
  }

  if (!response.body) {
    throw new Error("Fish Audio API returned no body");
  }

  const audio = await readChunkedBody(response.body, {
    onChunk: options?.onChunk,
    makeTimeoutError: (timeoutMs) =>
      new Error(`Fish Audio read timed out after ${timeoutMs}ms`),
  });

  log.debug({ bytes: audio.byteLength }, "Fish Audio synthesis complete");
  return audio;
}
