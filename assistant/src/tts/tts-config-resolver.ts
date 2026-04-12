/**
 * Resolves the effective TTS provider and provider-specific configuration
 * from the canonical `services.tts` config block.
 *
 * Reads exclusively from `services.tts.provider` and
 * `services.tts.providers.<id>`. Migration 032 ensures all workspaces
 * have canonical fields materialised.
 */

import type { AssistantConfig } from "../config/types.js";
import type { TtsProviderId } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Resolved TTS configuration for a single provider. */
export interface ResolvedTtsConfig {
  /** The active TTS provider. */
  provider: TtsProviderId;

  /** Provider-specific settings for the active provider. */
  providerConfig: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Defaults (must match the schema defaults in tts.ts)
// ---------------------------------------------------------------------------

const DEFAULT_TTS_PROVIDER: TtsProviderId = "elevenlabs";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the effective TTS provider and its configuration from the
 * assistant config.
 *
 * Reads exclusively from `services.tts.provider` and
 * `services.tts.providers.<id>`. No legacy fallback logic.
 */
export function resolveTtsConfig(config: AssistantConfig): ResolvedTtsConfig {
  const ttsService = config.services.tts;

  const provider: TtsProviderId = ttsService.provider ?? DEFAULT_TTS_PROVIDER;

  // Resolve provider-specific config from the canonical providers map.
  const providerConfig = resolveProviderConfig(config, provider);

  return { provider, providerConfig };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the provider-specific config object from the canonical
 * `services.tts.providers.<id>` block.
 *
 * Uses a generic lookup against the providers map — no provider-specific
 * branching. Unknown providers (not in the catalog / schema) receive an
 * empty config; their adapters are responsible for validating required fields.
 */
function resolveProviderConfig(
  config: AssistantConfig,
  provider: TtsProviderId,
): Record<string, unknown> {
  const ttsProviders = config.services.tts.providers as Record<string, unknown>;

  const providerBlock = ttsProviders[provider];
  if (providerBlock != null && typeof providerBlock === "object") {
    return { ...providerBlock } as Record<string, unknown>;
  }

  return {};
}
