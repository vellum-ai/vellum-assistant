import type { FishAudioConfig } from "../config/schemas/fish-audio.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("fish-audio-client");

/** Timeout waiting for the first chunk from Fish Audio (ms). */
const FIRST_CHUNK_TIMEOUT_MS = 10_000;

/** Timeout waiting between consecutive chunks (ms). */
const IDLE_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Fish Audio REST API (POST /v1/tts)
// ---------------------------------------------------------------------------

interface SynthesizeOptions {
  onChunk?: (chunk: Uint8Array) => void;
  signal?: AbortSignal;
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
  config: FishAudioConfig,
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

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let isFirstChunk = true;

  while (true) {
    const timeoutMs = isFirstChunk ? FIRST_CHUNK_TIMEOUT_MS : IDLE_TIMEOUT_MS;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Fish Audio read timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    );
    const { done, value } = await Promise.race([reader.read(), timeout]);
    if (done) break;
    if (value) {
      isFirstChunk = false;
      chunks.push(value);
      options?.onChunk?.(value);
    }
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  log.debug({ bytes: totalLength }, "Fish Audio synthesis complete");
  return Buffer.from(merged);
}
