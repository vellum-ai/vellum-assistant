/**
 * Offline plugin catalog reader backed by the manifest bundled into the
 * package at build time (see meta/feature-flags/sync-bundled-copies.ts).
 *
 * Consulted only when platform features are disabled (air-gapped / self-hosted,
 * `VELLUM_DISABLE_PLATFORM=true`) — the gate is wired in a later PR. Importing
 * the JSON directly (resolveJsonModule) means no filesystem path resolution, so
 * it works identically in dev, Docker, and an npm-packed macOS install.
 */

import bundledManifest from "./bundled-marketplace.json" with { type: "json" };
import { marketplaceManifestSchema } from "./plugin-marketplace.js";
import { marketplaceMatch, type PluginCatalog } from "./search-plugins.js";

/**
 * Validate and project the bundled manifest into a {@link PluginCatalog}:
 * every entry deduped by name, mapped via {@link marketplaceMatch}, sorted
 * alphabetically. A malformed bundled manifest is a build defect, so parsing
 * throws rather than silently degrading.
 */
export function buildBundledPluginCatalog(
  rawManifest: unknown = bundledManifest,
): PluginCatalog {
  const { plugins } = marketplaceManifestSchema.parse(rawManifest);

  const matches = [];
  const seen = new Set<string>();
  for (const entry of plugins) {
    if (seen.has(entry.name)) continue;
    matches.push(marketplaceMatch(entry));
    seen.add(entry.name);
  }

  matches.sort((a, b) => a.name.localeCompare(b.name));

  return { ref: "bundled", matches };
}

let memoized: PluginCatalog | undefined;

/** Memoized {@link buildBundledPluginCatalog}, so the mapping runs once. */
export function readBundledPluginCatalog(): PluginCatalog {
  memoized ??= buildBundledPluginCatalog();
  return memoized;
}
