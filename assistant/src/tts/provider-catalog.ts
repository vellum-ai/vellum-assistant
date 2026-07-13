/**
 * Canonical TTS provider catalog.
 *
 * This module is the **single assembly point** for the statically-defined
 * TTS providers. Each provider module (`providers/<id>-provider.ts`) exports
 * one complete {@link TtsProviderDefinition} — catalog metadata plus runtime
 * adapter — and this module collects them into the catalog that downstream
 * consumers query via {@link getCatalogProvider}, {@link listCatalogProviders},
 * or {@link listCatalogProviderIds}.
 *
 * The `satisfies Record<TtsProviderId, TtsProviderDefinition>` check
 * makes the catalog exhaustive at compile time: adding an ID to
 * `TTS_PROVIDER_IDS` (`types.ts`) without a definition here — or a definition
 * without wiring — is a type error, not a boot-time failure.
 *
 * Adding a new TTS provider: add its ID to `TTS_PROVIDER_IDS`, create
 * `providers/<id>-provider.ts` exporting a definition, and list it here.
 */

import type {
  TtsProviderCatalogEntry,
  TtsProviderDefinition,
} from "./provider-definition.js";
import { deepgramTtsProviderDefinition } from "./providers/deepgram-provider.js";
import { elevenLabsTtsProviderDefinition } from "./providers/elevenlabs-provider.js";
import { fishAudioTtsProviderDefinition } from "./providers/fish-audio-provider.js";
import { vellumTtsProviderDefinition } from "./providers/vellum-provider.js";
import { xaiTtsProviderDefinition } from "./providers/xai-provider.js";
import type { TtsProvider, TtsProviderId } from "./types.js";

export type {
  TtsMediaStreamOutputFormat,
  TtsMediaStreamPlayback,
  TtsProviderCatalogEntry,
  TtsProviderDefinition,
} from "./provider-definition.js";

// ---------------------------------------------------------------------------
// Catalog data
// ---------------------------------------------------------------------------

/**
 * The authoritative provider definitions, keyed by ID. The `satisfies`
 * clause enforces exactly one definition per canonical provider ID.
 */
const DEFINITIONS = {
  elevenlabs: elevenLabsTtsProviderDefinition,
  "fish-audio": fishAudioTtsProviderDefinition,
  deepgram: deepgramTtsProviderDefinition,
  xai: xaiTtsProviderDefinition,
  vellum: vellumTtsProviderDefinition,
} as const satisfies Record<TtsProviderId, TtsProviderDefinition>;

/**
 * Definitions in display order (e.g. settings dropdowns).
 */
// vellum is deliberately absent: managed mode is selected via
// `services.tts.mode`, not the provider picker — today's settings UI writes
// only `provider` + an API key, which the schema rejects for vellum. The
// definition stays in DEFINITIONS so managed-mode resolution works.
const CATALOG: readonly TtsProviderDefinition[] = [
  DEFINITIONS.elevenlabs,
  DEFINITIONS["fish-audio"],
  DEFINITIONS.deepgram,
  DEFINITIONS.xai,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all catalog providers in display order.
 */
export function listCatalogProviders(): readonly TtsProviderCatalogEntry[] {
  return CATALOG;
}

/**
 * List all known provider IDs in display order.
 */
export function listCatalogProviderIds(): TtsProviderId[] {
  return CATALOG.map((entry) => entry.id);
}

/**
 * List all catalog providers projected to client-facing display fields only.
 */
export function listCatalogProvidersForDisplay() {
  return CATALOG.map((e) => ({
    id: e.id,
    displayName: e.displayName,
    subtitle: e.subtitle,
    supportsVoiceSelection: e.supportsVoiceSelection,
    apiKeyPlaceholder: e.apiKeyPlaceholder,
    credentialsGuide: e.credentialsGuide,
  }));
}

/**
 * Look up a catalog entry by provider ID.
 *
 * @throws if the ID is not in the catalog.
 */
export function getCatalogProvider(id: string): TtsProviderCatalogEntry {
  return getProviderDefinition(id);
}

/**
 * Look up a full provider definition (metadata + adapter + voice spec) by ID.
 *
 * @throws if the ID is not in the catalog.
 */
export function getProviderDefinition(id: string): TtsProviderDefinition {
  const definition = (
    DEFINITIONS as Record<string, TtsProviderDefinition | undefined>
  )[id];
  if (!definition) {
    const known = listCatalogProviderIds();
    throw new Error(
      `Unknown TTS provider "${id}" is not in the catalog. ` +
        `Known providers: ${known.join(", ")}`,
    );
  }
  return definition;
}

// ---------------------------------------------------------------------------
// Adapter resolution
// ---------------------------------------------------------------------------

/**
 * Test-only adapter overrides, checked before the static catalog so tests
 * can substitute stub providers (no real HTTP) or inject providers with
 * non-catalog IDs.
 */
const testOverrides = new Map<string, TtsProvider>();

/**
 * Resolve the runtime synthesis adapter for a provider ID.
 *
 * @throws if the ID is not in the catalog (and no test override exists).
 */
export function getTtsProvider(id: string): TtsProvider {
  const override = testOverrides.get(id);
  if (override) {
    return override;
  }
  return getProviderDefinition(id).adapter;
}

/**
 * Install a test adapter that shadows the catalog adapter with the same ID
 * (or adds a provider under a non-catalog ID).
 *
 * **Test-only** — must not be called in production code.
 */
export function _setTtsProviderForTests(provider: TtsProvider): void {
  testOverrides.set(provider.id, provider);
}

/**
 * Clear all test adapter overrides.
 *
 * **Test-only** — must not be called in production code.
 */
export function _resetTtsProviderOverridesForTests(): void {
  testOverrides.clear();
}
