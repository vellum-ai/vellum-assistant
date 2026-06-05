/**
 * Telephony STT routing resolver.
 *
 * Maps the `services.stt.provider` value to a telephony setup strategy that
 * downstream TwiML generation and media-stream adapters can consume without
 * re-deriving provider semantics.
 *
 * A single strategy variant exists:
 *
 * - **`media-stream-custom`** — a `<Stream>` media-stream is opened and the
 *   daemon transcribes audio server-side via the provider's STT pipeline.
 *   Every STT provider routes through this path; the legacy Twilio-native
 *   ConversationRelay strategy has been removed.
 *
 * Strategy selection is driven entirely by the provider catalog's
 * `telephonyRouting` metadata — this module contains no hardcoded
 * provider-to-Twilio maps.
 */

import { getConfig } from "../config/loader.js";
import { getProviderEntry } from "../providers/speech-to-text/provider-catalog.js";
import type { SttProviderId } from "../stt/types.js";

// ---------------------------------------------------------------------------
// Strategy types
// ---------------------------------------------------------------------------

/**
 * The configured STT provider requires a media-stream for custom
 * server-side transcription.
 */
export interface MediaStreamCustomStrategy {
  readonly strategy: "media-stream-custom";
  /** Provider ID from `services.stt.provider`. */
  readonly providerId: SttProviderId;
}

/**
 * Telephony setup strategy. Currently a single variant; kept as a named
 * type so future strategies can re-introduce a discriminated union.
 */
export type TelephonySttStrategy = MediaStreamCustomStrategy;

/**
 * Result of resolving a telephony STT routing decision.
 *
 * - `resolved` — the provider was recognized and a strategy was determined.
 * - `unknown-provider` — the provider ID is not in the catalog or has no
 *   telephony routing mapping.
 */
export type TelephonySttRoutingResult =
  | { status: "resolved"; strategy: TelephonySttStrategy }
  | { status: "unknown-provider"; providerId: string; reason: string };

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the telephony STT routing strategy from `services.stt.provider`.
 *
 * Reads the active provider from config, checks the provider catalog for
 * validity, then derives the telephony strategy from the catalog entry's
 * `telephonyRouting` metadata.
 */
export function resolveTelephonySttRouting(): TelephonySttRoutingResult {
  // Safe access: a partial/edge config (e.g. no `services` block) must resolve
  // to "unknown-provider" rather than throwing — telephony routing/preflight
  // must never crash call setup on a malformed config.
  const providerId = getConfig().services?.stt?.provider;
  if (!providerId) {
    return {
      status: "unknown-provider",
      providerId: "",
      reason: "No STT provider configured (services.stt.provider is unset)",
    };
  }

  // Validate the provider exists in the catalog.
  const entry = getProviderEntry(providerId as SttProviderId);
  if (!entry) {
    return {
      status: "unknown-provider",
      providerId,
      reason: `STT provider "${providerId}" is not in the provider catalog`,
    };
  }

  // Every provider routes through the media-stream custom path.
  return {
    status: "resolved",
    strategy: {
      strategy: "media-stream-custom",
      providerId: entry.id,
    },
  };
}
