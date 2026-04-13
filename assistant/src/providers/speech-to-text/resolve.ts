import { getConfig } from "../../config/loader.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { createDaemonBatchTranscriber } from "../../stt/daemon-batch-transcriber.js";
import type {
  BatchTranscriber,
  StreamingTranscriber,
  SttProviderId,
} from "../../stt/types.js";
import {
  getCredentialProvider,
  getProviderEntry,
  supportsBoundary,
} from "./provider-catalog.js";

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
  const provider = config.services.stt.provider;

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
  const provider = config.services.stt.provider;

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
  const apiKey = await getProviderKeyAsync(entry.credentialProvider);
  if (!apiKey) {
    return {
      status: "missing-credentials",
      providerId: entry.id,
      credentialProvider: entry.credentialProvider,
      reason: `No API key configured for credential provider "${entry.credentialProvider}"`,
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
  const provider = config.services.stt.provider;

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
  const apiKey = await getProviderKeyAsync(entry.credentialProvider);
  if (!apiKey) {
    return {
      status: "missing-credentials",
      providerId: entry.id,
      credentialProvider: entry.credentialProvider,
      reason: `No API key configured for credential provider "${entry.credentialProvider}"`,
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
 */
export async function resolveStreamingTranscriber(): Promise<StreamingTranscriber | null> {
  const config = getConfig();
  const provider = config.services.stt.provider;

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

  const apiKey = await getProviderKeyAsync(credentialProviderName);
  if (!apiKey) {
    return null;
  }

  return createStreamingTranscriber(apiKey, provider as SttProviderId);
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
): Promise<StreamingTranscriber | null> {
  switch (providerId) {
    case "google-gemini": {
      const { GoogleGeminiStreamingTranscriber } =
        await import("./google-gemini-stream.js");
      return new GoogleGeminiStreamingTranscriber(apiKey);
    }
    // Future: case "deepgram" will be wired here by PR 3.
    default:
      return null;
  }
}
