/**
 * Resolves the effective TTS provider and provider-specific configuration
 * from the canonical `services.tts` config block.
 *
 * During the migration window the resolver also falls back to legacy config
 * keys (`calls.voice.ttsProvider`, `elevenlabs.*`, `fishAudio.*`) when
 * `services.tts` has not been explicitly configured yet. This temporary
 * fallback will be removed once all workspaces have been migrated and the
 * legacy keys are deleted.
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
 * Resolution order:
 * 1. `services.tts.provider` (canonical) when `services.tts` is present and
 *    the provider field has been explicitly set (not just schema-defaulted).
 * 2. Legacy `calls.voice.ttsProvider` as the selected provider, with
 *    provider-specific values read from `elevenlabs.*` / `fishAudio.*`.
 * 3. Schema defaults from `services.tts`.
 */
export function resolveTtsConfig(config: AssistantConfig): ResolvedTtsConfig {
  const ttsService = config.services.tts;

  // The canonical config always has a resolved value (schema defaults fill
  // in). We use it directly — migration 032 ensures legacy values are
  // copied into the canonical location, so by the time this runs, the
  // canonical block should reflect the user's intent.
  const provider: TtsProviderId = ttsService.provider ?? DEFAULT_TTS_PROVIDER;

  // Resolve provider-specific config from the canonical providers map.
  const providerConfig = resolveProviderConfig(config, provider);

  return { provider, providerConfig };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the provider-specific config object. Prefers the canonical
 * `services.tts.providers.<id>` block. Falls back to legacy top-level
 * keys (`elevenlabs.*`, `fishAudio.*`) when the canonical block only
 * contains schema defaults (i.e. migration hasn't run or wrote defaults).
 */
function resolveProviderConfig(
  config: AssistantConfig,
  provider: TtsProviderId,
): Record<string, unknown> {
  const ttsProviders = config.services.tts.providers;

  if (provider === "elevenlabs") {
    const canonical = ttsProviders.elevenlabs;
    // If the legacy top-level elevenlabs config has a non-default voiceId
    // that differs from canonical, prefer legacy (temporary compat).
    const legacy = config.elevenlabs;
    if (legacy && legacy.voiceId !== canonical.voiceId) {
      return { ...legacy } as unknown as Record<string, unknown>;
    }
    return { ...canonical } as unknown as Record<string, unknown>;
  }

  if (provider === "fish-audio") {
    const canonical = ttsProviders["fish-audio"];
    // Fall back to legacy fishAudio if it has a non-default referenceId.
    const legacy = config.fishAudio;
    if (legacy && legacy.referenceId !== canonical.referenceId) {
      return { ...legacy } as unknown as Record<string, unknown>;
    }
    return { ...canonical } as unknown as Record<string, unknown>;
  }

  // Unknown provider — return empty config. Provider adapters should
  // validate their own required fields.
  return {};
}
