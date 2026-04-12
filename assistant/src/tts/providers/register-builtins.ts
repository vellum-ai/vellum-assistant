/**
 * Register built-in TTS providers at startup.
 *
 * Call {@link registerBuiltinTtsProviders} once during daemon initialization
 * to make all catalog-declared providers discoverable via the provider
 * registry. The function iterates {@link listCatalogProviderIds} and looks up
 * each ID in the {@link providerFactories} map — a missing factory entry
 * causes a clear startup-time error so that new catalog providers cannot be
 * added without also wiring an adapter factory.
 *
 * This module is the single entry point for built-in registration — new
 * providers should be added to the catalog and the factory map so they are
 * available from first request.
 */

import { listCatalogProviderIds } from "../provider-catalog.js";
import { registerTtsProvider } from "../provider-registry.js";
import { providerFactories } from "./index.js";

let registered = false;

/**
 * Register all built-in TTS providers with the global registry.
 *
 * Iterates every provider ID declared in the canonical catalog and creates
 * an adapter via the corresponding factory in {@link providerFactories}.
 *
 * Safe to call multiple times — subsequent calls are no-ops. This prevents
 * double-registration when the daemon restarts hot-module paths.
 *
 * @throws if any catalog provider ID has no corresponding adapter factory.
 */
export function registerBuiltinTtsProviders(): void {
  if (registered) return;

  const catalogIds = listCatalogProviderIds();

  for (const id of catalogIds) {
    const factory = providerFactories.get(id);
    if (!factory) {
      throw new Error(
        `TTS provider "${id}" is declared in the catalog but has no adapter factory. ` +
          `Add a factory entry for "${id}" in providers/index.ts.`,
      );
    }
    registerTtsProvider(factory());
  }

  registered = true;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Reset the registration guard so {@link registerBuiltinTtsProviders} can
 * re-register providers after a test clears the global registry.
 *
 * **Test-only** — must not be called in production code.
 */
export function _resetBuiltinRegistration(): void {
  registered = false;
}
