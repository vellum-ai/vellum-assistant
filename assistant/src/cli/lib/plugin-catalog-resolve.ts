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
 * A repo-relative path is clean when no `/`-or-`\`-split segment escapes (`..`)
 * or is empty (`""`). Mirrors the marketplace schema's `path` refine so the
 * gated resolver rejects the same paths the GitHub manifest does — platform
 * catalog rows accept `path` as any string, so this is the install-side gate.
 */
function isCleanRepoRelativePath(path: string): boolean {
  return !path.split(/[/\\]/).some((seg) => seg === ".." || seg === "");
}

/**
 * Project a catalog match onto concrete GitHub install coordinates.
 *
 * Re-asserts the install-pinning invariant the GitHub path enforces via schema:
 * a curated install MUST pin to an immutable full commit SHA, so a non-SHA ref
 * from an upstream catalog is a config defect and throws rather than installing
 * mutable code. Likewise re-asserts the schema's clean-path rule: a platform
 * catalog row does not validate `path`, so an escaping/empty segment reaching
 * `trustedSource.rootPath` is rejected here rather than copying the wrong tree.
 * Pure — unit-testable without a catalog.
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
  if (path !== undefined && !isCleanRepoRelativePath(path)) {
    throw new Error(
      `Catalog entry "${match.name}" has an unsafe plugin path "${path}"; ` +
        `a curated install path must be a clean repo-relative directory (no ".." or empty segments).`,
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
