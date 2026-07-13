import { getConfig } from "../../config/loader.js";
import { effectiveSttProvider } from "../../config/schemas/stt.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { createDaemonBatchTranscriber } from "../../stt/daemon-batch-transcriber.js";
import type {
  BatchTranscriber,
  StreamingTranscriber,
  SttProviderId,
} from "../../stt/types.js";
import { getLogger } from "../../util/logger.js";
import {
  getCredentialProvider,
  getProviderEntry,
  supportsBoundary,
  supportsDiarization,
} from "./provider-catalog.js";

const log = getLogger("stt-resolver");

// ---------------------------------------------------------------------------
// Batch transcriber resolver (existing public API — unchanged contract)
// ---------------------------------------------------------------------------

/**
 * Resolve a `BatchTranscriber` for daemon-hosted batch transcription.
 *
 * Reads `services.stt.provider` from the assistant config to determine which
 * STT provider to use, then looks up the corresponding credential via the
 * provider catalog. Credential lookup is centralized here (an authorized
 * secure-keys importer) so callers don't need to import secure-keys directly.
 *
 * Returns `null` when:
 * - The configured provider is not in the catalog.
 * - The configured provider doesn't support the `daemon-batch` boundary.
 * - No credentials are configured for the resolved provider.
 */
export async function resolveBatchTranscriber(): Promise<BatchTranscriber | null> {
  const config = getConfig();
  const provider = effectiveSttProvider(config.services.stt);

  // Look up credential provider via the catalog.
  const credentialProviderName = getCredentialProvider(
    provider as SttProviderId,
  );
  if (!credentialProviderName) {
    return null;
  }

  // Verify the provider supports the daemon-batch boundary.
  if (!supportsBoundary(provider as SttProviderId, "daemon-batch")) {
    return null;
  }

  if (provider === "vellum") {
    return (await sttProviderKeyResolves("vellum"))
      ? createDaemonBatchTranscriber(null, "vellum")
      : null;
  }

  const apiKey = await getProviderKeyAsync(credentialProviderName);
  return createDaemonBatchTranscriber(apiKey, provider as SttProviderId);
}

// ---------------------------------------------------------------------------
// Telephony capability resolver
// ---------------------------------------------------------------------------

/**
 * Result of resolving whether the configured `services.stt` provider is
 * eligible for telephony call ingestion.
 */
export type TelephonySttCapability =
  | {
      /** The configured provider supports telephony. */
      status: "supported";
      providerId: SttProviderId;
      /** How the provider participates in real-time call ingestion. */
      telephonyMode: "realtime-ws" | "batch-only";
    }
  | {
      /** The configured provider does not support telephony. */
      status: "unsupported";
      providerId: SttProviderId;
      reason: string;
    }
  | {
      /** The configured provider is unknown or not in the catalog. */
      status: "unconfigured";
      reason: string;
    }
  | {
      /** The provider is eligible but missing credentials. */
      status: "missing-credentials";
      providerId: SttProviderId;
      credentialProvider: string;
      reason: string;
    };

/**
 * Validate whether the configured `services.stt` provider is eligible for
 * future real-time telephony call ingestion.
 *
 * This resolver does **not** create a live transcriber — it only validates
 * that the configuration, catalog entry, and credentials are all in order.
 * The actual wiring is deferred to a future media-stream call adapter PR.
 *
 * Callers can branch on the discriminated `status` field:
 * - `"supported"` — the provider is telephony-eligible and credentials exist.
 * - `"unsupported"` — the provider exists but has `telephonyMode: "none"`.
 * - `"unconfigured"` — the provider is unknown or missing from the catalog.
 * - `"missing-credentials"` — the provider is eligible but has no API key.
 */
export async function resolveTelephonySttCapability(): Promise<TelephonySttCapability> {
  const config = getConfig();
  const provider = effectiveSttProvider(config.services.stt);

  const entry = getProviderEntry(provider as SttProviderId);
  if (!entry) {
    return {
      status: "unconfigured",
      reason: `STT provider "${provider}" is not in the provider catalog`,
    };
  }

  if (entry.telephonyMode === "none") {
    return {
      status: "unsupported",
      providerId: entry.id,
      reason: `STT provider "${entry.id}" does not support telephony`,
    };
  }

  // Provider is telephony-eligible — verify credentials exist.
  if (!(await sttProviderKeyResolves(entry.credentialProvider))) {
    return {
      status: "missing-credentials",
      providerId: entry.id,
      credentialProvider: entry.credentialProvider,
      reason: sttCredentialGapReason(entry.credentialProvider),
    };
  }

  return {
    status: "supported",
    providerId: entry.id,
    telephonyMode: entry.telephonyMode,
  };
}

// ---------------------------------------------------------------------------
// Conversation streaming capability resolver
// ---------------------------------------------------------------------------

/**
 * Result of resolving whether the configured `services.stt` provider
 * supports conversation streaming for chat message capture.
 */
export type ConversationStreamingSttCapability =
  | {
      /** The configured provider supports conversation streaming. */
      status: "supported";
      providerId: SttProviderId;
      /** How the provider implements conversation streaming. */
      streamingMode: "realtime-ws" | "incremental-batch";
    }
  | {
      /** The configured provider does not support conversation streaming. */
      status: "unsupported";
      providerId: SttProviderId;
      reason: string;
    }
  | {
      /** The configured provider is unknown or not in the catalog. */
      status: "unconfigured";
      reason: string;
    }
  | {
      /** The provider is eligible but missing credentials. */
      status: "missing-credentials";
      providerId: SttProviderId;
      credentialProvider: string;
      reason: string;
    };

/**
 * Validate whether the configured `services.stt` provider supports
 * conversation streaming for chat message capture (chat composer and
 * iOS input bar).
 *
 * This resolver does **not** create a live streaming session — it only
 * validates that the configuration, catalog entry, and credentials are
 * all in order. The actual session creation is handled by the runtime
 * session orchestrator (PR 5).
 *
 * Callers can branch on the discriminated `status` field:
 * - `"supported"` — the provider supports streaming and credentials exist.
 * - `"unsupported"` — the provider exists but has
 *   `conversationStreamingMode: "none"`.
 * - `"unconfigured"` — the provider is unknown or missing from the catalog.
 * - `"missing-credentials"` — the provider is eligible but has no API key.
 */
export async function resolveConversationStreamingSttCapability(): Promise<ConversationStreamingSttCapability> {
  const config = getConfig();
  const provider = effectiveSttProvider(config.services.stt);

  const entry = getProviderEntry(provider as SttProviderId);
  if (!entry) {
    return {
      status: "unconfigured",
      reason: `STT provider "${provider}" is not in the provider catalog`,
    };
  }

  if (entry.conversationStreamingMode === "none") {
    return {
      status: "unsupported",
      providerId: entry.id,
      reason: `STT provider "${entry.id}" does not support conversation streaming`,
    };
  }

  // Provider is streaming-eligible — verify credentials exist.
  if (!(await sttProviderKeyResolves(entry.credentialProvider))) {
    return {
      status: "missing-credentials",
      providerId: entry.id,
      credentialProvider: entry.credentialProvider,
      reason: sttCredentialGapReason(entry.credentialProvider),
    };
  }

  return {
    status: "supported",
    providerId: entry.id,
    streamingMode: entry.conversationStreamingMode,
  };
}

// ---------------------------------------------------------------------------
// Streaming transcriber resolver
// ---------------------------------------------------------------------------

/**
 * Speaker diarization preference for a streaming session.
 *
 * - `"off"` (default): never request diarization. Behavior unchanged from
 *   pre-diarization callers.
 * - `"preferred"`: enable diarization when the configured provider supports
 *   it; silently proceed without it on non-capable providers.
 * - `"required"`: enable diarization on capable providers; return `null` and
 *   log a warning on non-capable providers. Callers that pass `"required"`
 *   are expected to surface a clear error to the user.
 */
export type DiarizePreference = "preferred" | "required" | "off";

/**
 * Options for resolving a streaming transcriber.
 */
export interface ResolveStreamingTranscriberOptions {
  /** Audio sample rate in Hz from the client WebSocket connection. */
  sampleRate?: number;
  /**
   * Speaker diarization preference. Default: `"off"`.
   *
   * See {@link DiarizePreference} for semantics.
   */
  diarize?: DiarizePreference;
  /**
   * Emit `final` events only at utterance boundaries. Supported only by
   * providers whose catalog `telephonyMode` is `"realtime-ws"` (Deepgram,
   * where it also enables `utterance_end_ms` endpointing). All other
   * providers resolve to `null` so the caller falls back to per-turn
   * batch transcription — e.g. openai-whisper fires `final` only from
   * `stop()` (end-of-stream, not end-of-utterance) and xAI emits a
   * `final` per committed segment. Used by telephony call ingestion.
   * Default: false.
   */
  utteranceBoundaryFinals?: boolean;
  /**
   * Silence window (ms) the provider waits before finalizing an utterance
   * when `utteranceBoundaryFinals` is enabled (Deepgram `utterance_end_ms`).
   * Ignored without `utteranceBoundaryFinals`. Default: 1000.
   */
  utteranceEndMs?: number;
}

/**
 * Resolve a `StreamingTranscriber` for daemon-hosted streaming transcription.
 *
 * Reads `services.stt.provider` from the assistant config to determine which
 * STT provider to use, verifies it supports the `daemon-streaming` boundary,
 * and constructs the appropriate streaming adapter. Credential lookup is
 * centralized here (an authorized secure-keys importer) so callers don't
 * need to import secure-keys directly.
 *
 * Returns `null` when:
 * - The configured provider is not in the catalog.
 * - The configured provider doesn't support the `daemon-streaming` boundary.
 * - No credentials are configured for the resolved provider.
 * - No streaming adapter exists for the configured provider.
 * - `diarize` is `"required"` but the configured provider cannot diarize.
 * - `utteranceBoundaryFinals` is set but the configured provider's catalog
 *   `telephonyMode` is not `"realtime-ws"`.
 */
export async function resolveStreamingTranscriber(
  options: ResolveStreamingTranscriberOptions = {},
): Promise<StreamingTranscriber | null> {
  const config = getConfig();
  const provider = effectiveSttProvider(config.services.stt);
  const diarizePreference: DiarizePreference = options.diarize ?? "off";

  // Look up credential provider via the catalog.
  const credentialProviderName = getCredentialProvider(
    provider as SttProviderId,
  );
  if (!credentialProviderName) {
    return null;
  }

  // Verify the provider supports the daemon-streaming boundary.
  if (!supportsBoundary(provider as SttProviderId, "daemon-streaming")) {
    return null;
  }

  // Boundary-requiring callers (telephony) can only stream on providers
  // whose catalog telephonyMode is "realtime-ws" (Deepgram gates finals on
  // utterance boundaries). Everything else fires `final` either only from
  // stop() — end-of-stream, not end-of-utterance (openai-whisper) — or per
  // committed segment (xAI), so streaming would yield no replies until
  // hangup, or mid-sentence replies. Resolve to null so the caller falls
  // back to per-turn batch transcription.
  if (options.utteranceBoundaryFinals) {
    const telephonyMode = getProviderEntry(
      provider as SttProviderId,
    )?.telephonyMode;
    if (telephonyMode !== "realtime-ws") {
      log.warn(
        { providerId: provider, telephonyMode },
        "utterance-boundary finals requested but the configured STT provider has no realtime telephony streaming — falling back to batch transcription",
      );
      return null;
    }
  }

  // Resolve diarization capability against the catalog. For `"required"`
  // callers, bail early (with a warning) when the configured provider can't
  // diarize so the caller can surface a clear error to the user.
  const providerSupportsDiarization = supportsDiarization(
    provider as SttProviderId,
  );
  if (diarizePreference === "required" && !providerSupportsDiarization) {
    log.warn(
      { providerId: provider },
      "diarization is required but configured STT provider does not support it",
    );
    return null;
  }
  const enableDiarization =
    (diarizePreference === "preferred" || diarizePreference === "required") &&
    providerSupportsDiarization;

  const apiKey =
    provider === "vellum"
      ? null
      : await getProviderKeyAsync(credentialProviderName);
  if (provider === "vellum") {
    if (!(await sttProviderKeyResolves("vellum"))) {
      return null;
    }
  } else if (!apiKey) {
    return null;
  }

  return createStreamingTranscriber(apiKey ?? "", provider as SttProviderId, {
    sampleRate: options.sampleRate,
    diarize: enableDiarization,
    utteranceBoundaryFinals: options.utteranceBoundaryFinals ?? false,
    utteranceEndMs: options.utteranceEndMs,
  });
}

/**
 * Default Deepgram `utterance_end_ms` used when utterance-boundary finals
 * are requested and the caller supplies no override. This is the pause
 * length after which an `UtteranceEnd` frame confirms the utterance is
 * complete even when `speech_final` endpointing never fired (e.g.
 * background noise). Telephony callers override it via
 * `calls.voice.utteranceEndMs`.
 */
const UTTERANCE_BOUNDARY_END_MS = 1_000;

/**
 * Options forwarded to individual streaming adapter constructors.
 */
interface CreateStreamingTranscriberOptions {
  sampleRate?: number;
  /**
   * Whether to enable speaker diarization on providers that support it.
   * Only forwarded to provider adapters that accept a diarize option
   * (e.g. Deepgram). Silently ignored by adapters without diarization
   * support.
   */
  diarize?: boolean;
  /**
   * Whether `final` events should be gated on utterance boundaries.
   * Only forwarded to Deepgram; the resolver never sets this for
   * providers without realtime telephony streaming (they resolve to
   * `null` instead).
   */
  utteranceBoundaryFinals?: boolean;
  /**
   * Silence window (ms) before an utterance is finalized. Only forwarded
   * to Deepgram (as `utterance_end_ms`) when `utteranceBoundaryFinals`
   * is set. Defaults to {@link UTTERANCE_BOUNDARY_END_MS}.
   */
  utteranceEndMs?: number;
}

/**
 * Create a `StreamingTranscriber` for the given provider.
 *
 * Uses lazy imports so the adapter modules are only loaded when needed,
 * keeping the module graph lightweight for callers that only need batch
 * transcription.
 *
 * Returns `null` for providers that do not have a streaming adapter.
 */
async function createStreamingTranscriber(
  apiKey: string,
  providerId: SttProviderId,
  options: CreateStreamingTranscriberOptions = {},
): Promise<StreamingTranscriber | null> {
  switch (providerId) {
    case "deepgram": {
      const { DeepgramRealtimeTranscriber } =
        await import("./deepgram-realtime.js");
      return new DeepgramRealtimeTranscriber(apiKey, {
        sampleRate: options.sampleRate,
        ...(options.diarize ? { diarize: true } : {}),
        ...(options.utteranceBoundaryFinals
          ? {
              utteranceBoundaryFinals: true,
              utteranceEndMs:
                options.utteranceEndMs ?? UTTERANCE_BOUNDARY_END_MS,
            }
          : {}),
      });
    }
    case "google-gemini": {
      // Gemini does not support speaker diarization; the diarize option is
      // silently ignored here.
      const { GoogleGeminiLiveStreamingTranscriber } =
        await import("./google-gemini-live-stream.js");
      return new GoogleGeminiLiveStreamingTranscriber(apiKey, {
        pcmSampleRate: options.sampleRate,
      });
    }
    case "openai-whisper": {
      // OpenAI Whisper does not support speaker diarization; the diarize
      // option is silently ignored here.
      const { OpenAIWhisperStreamingTranscriber } =
        await import("./openai-whisper-stream.js");
      return new OpenAIWhisperStreamingTranscriber(apiKey, {
        pcmSampleRate: options.sampleRate,
      });
    }
    case "xai": {
      const { XAIRealtimeTranscriber } = await import("./xai-realtime.js");
      return new XAIRealtimeTranscriber(apiKey, {
        sampleRate: options.sampleRate,
        ...(options.diarize ? { diarize: true } : {}),
      });
    }
    case "vellum": {
      // Managed speech authenticates via the platform connection; the
      // apiKey argument is unused. Diarization is unsupported and the
      // option is silently ignored, matching Gemini/Whisper.
      const { VellumManagedStreamingTranscriber } =
        await import("./vellum-managed-stream.js");
      return new VellumManagedStreamingTranscriber({
        pcmSampleRate: options.sampleRate,
      });
    }
    default: {
      const _exhaustive: never = providerId;
      return null;
    }
  }
}

/**
 * True when an API key resolves for the given credential provider name.
 *
 * Centralized here (an authorized secure-keys importer) so callers that only
 * need a key-existence check don't import secure-keys directly.
 */
/**
 * Human-readable reason for a credential gap, aware that connection-based
 * providers (vellum) are fixed by connecting the platform account, not by
 * entering an API key.
 */
export function sttCredentialGapReason(credentialProviderName: string): string {
  if (credentialProviderName === "vellum") {
    return "No Vellum platform connection for managed speech — run 'assistant platform connect'";
  }
  return `No API key configured for credential provider "${credentialProviderName}"`;
}

export async function sttProviderKeyResolves(
  credentialProviderName: string,
): Promise<boolean> {
  // vellum has no stored API key — the platform connection is the credential.
  if (credentialProviderName === "vellum") {
    const { vellumManagedSpeechAvailable } =
      await import("./vellum-managed.js");
    return vellumManagedSpeechAvailable();
  }
  return (await getProviderKeyAsync(credentialProviderName)) !== undefined;
}
