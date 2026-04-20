/**
 * Provider adapter factory map.
 *
 * Maps every canonical {@link TtsProviderId} from the provider catalog to a
 * factory function that creates the corresponding {@link TtsProvider} adapter.
 *
 * This module is the single place to wire a new provider adapter — adding a
 * provider to the catalog without a corresponding factory entry here will
 * cause a startup-time error (enforced by {@link registerBuiltinTtsProviders}).
 */

import type { TtsProvider, TtsProviderId } from "../types.js";
import { createDeepgramProvider } from "./deepgram-provider.js";
import { createElevenLabsProvider } from "./elevenlabs-provider.js";
import { createFishAudioProvider } from "./fish-audio-provider.js";
import { createXaiProvider } from "./xai-provider.js";

// ---------------------------------------------------------------------------
// Factory type
// ---------------------------------------------------------------------------

/**
 * A zero-argument function that constructs a {@link TtsProvider} adapter.
 */
export type TtsProviderFactory = () => TtsProvider;

// ---------------------------------------------------------------------------
// Factory map
// ---------------------------------------------------------------------------

/**
 * Provider adapter factories keyed by catalog provider ID.
 *
 * When a new provider is added to `provider-catalog.ts`, a matching entry
 * must be added here. The built-in registration module iterates the catalog
 * IDs and looks up each one in this map — a missing entry is a fatal error.
 */
export const providerFactories: ReadonlyMap<TtsProviderId, TtsProviderFactory> =
  new Map<TtsProviderId, TtsProviderFactory>([
    ["elevenlabs", createElevenLabsProvider],
    ["fish-audio", createFishAudioProvider],
    ["deepgram", createDeepgramProvider],
    ["xai", createXaiProvider],
  ]);
