/**
 * Resolves the effective TTS provider and provider-specific configuration
 * from the canonical `services.tts` config block.
 *
 * During the migration window the resolver also falls back to legacy config
 * keys:
 * - Provider selection: `calls.voice.ttsProvider` is consulted when the
 *   canonical `services.tts.provider` is still the schema default and the
 *   legacy key has a different value (i.e. migration 032 has not run yet).
 * - Provider-specific config: `elevenlabs.*` / `fishAudio.*` are consulted
 *   when the canonical `services.tts.providers.*` block only contains
 *   schema defaults.
 *
 * These temporary fallbacks will be removed once all workspaces have been
 * migrated and the legacy keys are deleted.
 */

import { DEFAULT_ELEVENLABS_VOICE_ID } from "../config/schemas/elevenlabs.js";
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
 * Resolution:
 * - Provider is read from `services.tts.provider` (always populated by Zod
 *   defaults; migration 032 copies legacy `calls.voice.ttsProvider`). When
 *   the canonical provider is still the schema default and
 *   `calls.voice.ttsProvider` has a different value — meaning migration has
 *   not run yet — the legacy provider is preferred.
 * - Provider-specific config is read from `services.tts.providers.<id>`,
 *   falling back to legacy top-level keys (`elevenlabs.*`, `fishAudio.*`)
 *   when the canonical block only has schema defaults.
 */
export function resolveTtsConfig(config: AssistantConfig): ResolvedTtsConfig {
  const ttsService = config.services.tts;

  // Start with the canonical provider (always populated by Zod defaults).
  let provider: TtsProviderId = ttsService.provider ?? DEFAULT_TTS_PROVIDER;

  // If the canonical provider is still the schema default, check whether
  // the legacy `calls.voice.ttsProvider` disagrees — this means migration
  // 032 hasn't run yet and we should honour the user's legacy selection.
  const legacyProvider = config.calls?.voice?.ttsProvider;
  if (
    provider === DEFAULT_TTS_PROVIDER &&
    legacyProvider &&
    legacyProvider !== provider
  ) {
    provider = legacyProvider as TtsProviderId;
  }

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
    // If the legacy top-level elevenlabs config has a voiceId that differs
    // from the schema default, the user customised legacy settings before
    // migration.  Prefer those legacy values (temporary compat).
    const legacy = config.elevenlabs;
    if (
      legacy &&
      legacy.voiceId !== DEFAULT_ELEVENLABS_VOICE_ID &&
      legacy.voiceId !== canonical.voiceId
    ) {
      return { ...legacy } as unknown as Record<string, unknown>;
    }
    return { ...canonical } as unknown as Record<string, unknown>;
  }

  if (provider === "fish-audio") {
    const canonical = ttsProviders["fish-audio"];
    // Fall back to legacy fishAudio only when it has been explicitly
    // customised (non-empty referenceId that differs from canonical).
    const legacy = config.fishAudio;
    if (
      legacy &&
      legacy.referenceId !== "" &&
      legacy.referenceId !== canonical.referenceId
    ) {
      return { ...legacy } as unknown as Record<string, unknown>;
    }
    return { ...canonical } as unknown as Record<string, unknown>;
  }

  // Unknown provider — return empty config. Provider adapters should
  // validate their own required fields.
  return {};
}
