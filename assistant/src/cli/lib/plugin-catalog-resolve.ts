/**
 * Gated catalog resolvers for install-by-name and the plugin detail view.
 *
 * The gated analogues of {@link ./plugin-marketplace}'s `resolveMarketplaceSource`
 * / GitHub `findMarketplaceEntry`: install-by-name and the detail lookup resolve
 * the SAME catalog `search` uses (platform-first via {@link ./plugin-catalog-cache}'s
 * `getPluginCatalog`, bundled offline) instead of a direct GitHub
 * `plugins/marketplace.json` fetch — so search, install, and details read one source.
 */

import { isFullCommitSha } from "./install-from-github.js";
import { getPluginCatalog } from "./plugin-catalog-cache.js";
import { DEFAULT_PLUGIN_REF } from "./plugin-constants.js";
import type { ResolvedPluginSource } from "./plugin-marketplace.js";
import type {
  PluginSearchMatch,
  SearchPluginsDeps,
} from "./search-plugins.js";

/** Find the catalog entry claiming {@link name}, or `null` when none does. */
export async function findCatalogEntry(
  name: string,
  deps: SearchPluginsDeps,
): Promise<PluginSearchMatch | null> {
  const catalog = await getPluginCatalog(DEFAULT_PLUGIN_REF, deps);
  return catalog.matches.find((m) => m.name === name) ?? null;
}

/**
 * Project a catalog match onto concrete GitHub install coordinates.
 *
 * Re-asserts the install-pinning invariant the GitHub path enforces via schema:
 * a curated install MUST pin to an immutable full commit SHA, so a non-SHA ref
 * from an upstream catalog is a config defect and throws rather than installing
 * mutable code. Pure — unit-testable without a catalog.
 */
export function resolveSourceFromMatch(
  match: PluginSearchMatch,
): ResolvedPluginSource {
  const { repo, path, ref } = match.source;
  if (!isFullCommitSha(ref)) {
    throw new Error(
      `Catalog entry "${match.name}" pins ref "${ref}", which is not a full commit SHA; ` +
        `a curated install must pin to an immutable full commit SHA (tags and branches are mutable).`,
    );
  }
  const [owner, repoName] = repo.split("/", 2) as [string, string];
  return { owner, repo: repoName, path: path ?? "", ref };
}

/** Resolve {@link name} to install coordinates from the catalog, or `null`. */
export async function resolvePluginSourceFromCatalog(
  name: string,
  deps: SearchPluginsDeps,
): Promise<ResolvedPluginSource | null> {
  const match = await findCatalogEntry(name, deps);
  return match ? resolveSourceFromMatch(match) : null;
}
