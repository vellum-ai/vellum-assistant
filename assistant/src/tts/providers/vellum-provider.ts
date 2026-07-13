/**
 * Vellum-managed TTS: synthesis through the platform's managed speech
 * surfaces (Vellum-held Deepgram key, billed to Vellum credits). No provider
 * API key exists on this machine — the platform connection is the credential.
 *
 * Two paths:
 * - Batch `synthesize` (read-aloud, mp3 surfaces) via the Django endpoint.
 * - Streaming `synthesizeStream` (live voice, telephony PCM) via the
 *   gateway's speech relay (gateway → velay → Deepgram; velay contact is
 *   gateway-only — the daemon holds no velay address and no speech
 *   credential).
 *
 * `allowNativeFallback: false` means synthesis failures propagate to the
 * caller's error handler, so failures here throw with user-actionable
 * messages rather than returning silence.
 */

import {
  type ManagedSpeechResult,
  managedSpeechSynthesize,
  type ManagedSpeechTtsFormat,
} from "../../platform/managed-speech.js";
import {
  mapVelayError,
  probeVelayRejection,
  resolveSpeechRelayConnection,
} from "../../providers/speech-to-text/vellum-speech-relay-connection.js";
import { getLogger } from "../../util/logger.js";
import type { TtsProviderDefinition } from "../provider-definition.js";
import type {
  TtsProvider,
  TtsProviderCapabilities,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../types.js";
import { synthesizeOverVellumTtsSocket } from "./vellum-tts-socket.js";

const log = getLogger("vellum-tts");

const TTS_STREAM_PATH = "/v1/speech/tts/stream";

/**
 * The platform's PCM format is fixed at 16 kHz, 16-bit LE mono — the
 * media-stream transcoder needs to know the rate regardless of hints.
 */
const VELLUM_PCM_SAMPLE_RATE_HZ = 16_000;

type ManagedSpeechFailure = Extract<ManagedSpeechResult<never>, { ok: false }>;

/**
 * Map the synthesis request onto the platform's format vocabulary.
 *
 * The PCM hint (media-stream playback) maps to raw 16 kHz PCM for mu-law
 * transcoding; every other use case gets mp3.
 */
function resolveManagedFormat(
  request: TtsSynthesisRequest,
): ManagedSpeechTtsFormat {
  return request.outputFormat === "pcm" ? "pcm_16000" : "mp3";
}

function synthesisError(failure: ManagedSpeechFailure): Error {
  if (failure.code === "insufficient_balance") {
    return new Error(
      "Vellum credits are exhausted — add funds to your Vellum account to continue using managed speech.",
    );
  }
  if (failure.kind === "unavailable") {
    return new Error(
      `Managed speech is unavailable: ${failure.message} Run 'assistant platform connect' to connect your Vellum account.`,
    );
  }
  return new Error(failure.message);
}

async function performSynthesis(
  request: TtsSynthesisRequest,
): Promise<TtsSynthesisResult> {
  const result = await managedSpeechSynthesize({
    text: request.text,
    format: resolveManagedFormat(request),
    signal: request.signal,
  });
  if (!result.ok) {
    throw synthesisError(result);
  }
  return {
    audio: result.value.audio,
    contentType: result.value.contentType,
  };
}

/**
 * Stream one PCM utterance through the gateway's speech relay. Non-PCM
 * requests delegate to the batch path — streaming exists for realtime PCM
 * consumers (live voice, telephony), and the relay's format is pinned to
 * linear16.
 */
async function performStreamingSynthesis(
  request: TtsSynthesisRequest,
  onChunk: (chunk: Uint8Array) => void,
): Promise<TtsSynthesisResult> {
  if (request.outputFormat !== "pcm") {
    const result = await performSynthesis(request);
    onChunk(result.audio);
    return result;
  }

  const connection = await resolveSpeechRelayConnection();
  if (!connection) {
    throw new Error(
      "Managed speech is unavailable: the daemon cannot reach the gateway's speech relay. Run 'assistant platform connect' to connect your Vellum account.",
    );
  }

  const params = new URLSearchParams({
    key: connection.mintServiceToken(),
    encoding: "linear16",
    sample_rate: String(VELLUM_PCM_SAMPLE_RATE_HZ),
  });
  const url = `${connection.wsBaseUrl}${TTS_STREAM_PATH}?${params.toString()}`;

  log.info(
    { textLength: request.text.length },
    "Starting managed streaming TTS synthesis",
  );

  try {
    const audio = await synthesizeOverVellumTtsSocket({
      url,
      text: request.text,
      onChunk,
      signal: request.signal,
      makeTimeoutError: (timeoutMs) =>
        new Error(`Managed streaming TTS timed out after ${timeoutMs}ms`),
      makeStreamError: (detail) =>
        new Error(`Managed streaming TTS failed: ${detail}`),
      makeEmptyError: () =>
        new Error("Managed streaming TTS returned no audio"),
      makeRelayError: (code, detail) =>
        new Error(mapVelayError({ code, detail }).message),
    });
    return {
      audio,
      contentType: "audio/pcm",
    };
  } catch (err) {
    if (request.signal?.aborted) {
      throw err;
    }
    // A rejected upgrade hides the relay's {code, detail}; replay the gate
    // as a plain GET (the gateway probes velay's own gate too) so auth and
    // balance failures surface with their mapped messages.
    const probeKey = encodeURIComponent(connection.mintServiceToken());
    const rejection = await probeVelayRejection(
      `${connection.httpBaseUrl}${TTS_STREAM_PATH}?key=${probeKey}`,
    );
    if (rejection) {
      throw new Error(mapVelayError(rejection).message);
    }
    throw err;
  }
}

export function createVellumProvider(): TtsProvider {
  const capabilities: TtsProviderCapabilities = {
    supportsStreaming: true,
    supportedFormats: ["mp3", "pcm"],
  };

  return {
    id: "vellum",
    capabilities,
    // Per the TtsProvider contract this returns undefined for non-PCM
    // output; the platform's PCM format is pinned to 16 kHz.
    resolveOutputSampleRateHz: (request) =>
      request.outputFormat === "pcm" ? VELLUM_PCM_SAMPLE_RATE_HZ : undefined,
    synthesize: performSynthesis,
    synthesizeStream: performStreamingSynthesis,
  };
}

/**
 * The complete Vellum managed provider definition — catalog metadata plus
 * the runtime adapter — assembled into the canonical catalog by
 * `provider-catalog.ts`.
 */
export const vellumTtsProviderDefinition: TtsProviderDefinition = {
  id: "vellum",
  displayName: "Vellum Managed",
  subtitle:
    "Text-to-speech through your Vellum account — billed to Vellum credits, no separate API key needed.",
  supportsVoiceSelection: false,
  apiKeyPlaceholder: "Connected via your Vellum account",
  credentialsGuide: {
    description:
      "Connect this assistant to your Vellum account; managed speech uses that connection instead of a provider API key.",
    url: "https://platform.vellum.ai/",
    linkLabel: "Open Vellum Platform",
  },
  callMode: "synthesized-play",
  allowNativeFallback: false,
  capabilities: {
    supportsStreaming: true,
    supportedFormats: ["mp3", "pcm"],
  },
  // The adapter honours the PCM hint via the platform's pcm_16000 format.
  mediaStreamPlayback: { outputFormat: "pcm" },
  secretRequirements: [
    {
      credentialStoreKey: "credential/vellum/assistant_api_key",
      displayName: "Vellum account connection",
      setCommand: "assistant platform connect",
    },
  ],
  adapter: createVellumProvider(),
};
