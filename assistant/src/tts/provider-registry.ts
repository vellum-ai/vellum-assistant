/**
 * Runtime TTS provider registry.
 *
 * Providers self-register at startup via `registerTtsProvider`. Callers
 * resolve a provider by ID with `getTtsProvider`, which throws an explicit
 * error for unknown IDs so misconfiguration surfaces immediately rather
 * than producing silent fallback behavior.
 */

import type { TtsProvider, TtsProviderId } from "./types.js";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Insertion-ordered map of registered providers. */
const providers = new Map<TtsProviderId, TtsProvider>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a TTS provider.
 *
 * @throws if a provider with the same ID is already registered — this
 *   prevents silent overwrites caused by duplicate registrations.
 */
export function registerTtsProvider(provider: TtsProvider): void {
  if (providers.has(provider.id)) {
    throw new Error(
      `TTS provider "${provider.id}" is already registered. ` +
        "Duplicate registrations are not allowed.",
    );
  }
  providers.set(provider.id, provider);
}

/**
 * Look up a registered TTS provider by ID.
 *
 * @throws if no provider with the given ID has been registered.
 */
export function getTtsProvider(id: TtsProviderId): TtsProvider {
  const provider = providers.get(id);
  if (!provider) {
    const known = [...providers.keys()];
    const knownList =
      known.length > 0 ? ` Known providers: ${known.join(", ")}` : "";
    throw new Error(`Unknown TTS provider "${id}".${knownList}`);
  }
  return provider;
}

/**
 * List all registered providers in deterministic (registration) order.
 */
export function listTtsProviders(): TtsProvider[] {
  return [...providers.values()];
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Clear all registered providers.
 *
 * **Test-only** — must not be called in production code.
 */
export function _resetTtsProviderRegistry(): void {
  providers.clear();
}
