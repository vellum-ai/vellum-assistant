/**
 * Gated catalog resolvers for install-by-name and the plugin detail view.
 *
 * The gated analogues of {@link ./plugin-marketplace}'s `resolveMarketplaceSource`
 * / GitHub `findMarketplaceEntry`: install-by-name and the detail lookup resolve
 * the SAME catalog `search` uses (platform-first via {@link ./plugin-catalog-cache}'s
 * `getPluginCatalog`, bundled offline) instead of a direct GitHub
 * `plugins/marketplace.json` fetch — so search, install, and details read one source.
 */

import { getPluginCatalog } from "./plugin-catalog-cache.js";
import { DEFAULT_PLUGIN_REF } from "./plugin-constants.js";
import {
  githubSourceSchema,
  type ResolvedPluginSource,
} from "./plugin-marketplace.js";
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
 * Validates the reconstructed source against the canonical marketplace
 * GitHub-source schema (`owner/repo` slug, clean repo-relative path, full commit
 * SHA) — the exact rules the GitHub manifest enforces. Platform catalog rows
 * validate none of these (`repo`/`path` are any string), so a malformed
 * coordinate — an over-segmented or slashless repo, an escaping/empty path, a
 * mutable non-SHA ref — is rejected here before it reaches `trustedSource`
 * rather than installing the wrong tree or a repointable revision.
 * Pure — unit-testable without a catalog.
 */
export function resolveSourceFromMatch(
  match: PluginSearchMatch,
): ResolvedPluginSource {
  // Repo-root `""` maps to `undefined` (omitted = root) so the schema's
  // non-empty path refine does not reject a valid repo-root entry.
  const path = match.source.path || undefined;
  const parsed = githubSourceSchema.safeParse({
    source: "github" as const,
    repo: match.source.repo,
    ...(path ? { path } : {}),
    ref: match.source.ref,
  });
  if (!parsed.success) {
    throw new Error(
      `Catalog entry "${match.name}" (${match.source.repo}) has an invalid source: ` +
        parsed.error.issues.map((i) => i.message).join("; "),
    );
  }
  const [owner, repoName] = parsed.data.repo.split("/", 2) as [string, string];
  return { owner, repo: repoName, path: match.source.path ?? "", ref: match.source.ref };
}

/** Resolve {@link name} to install coordinates from the catalog, or `null`. */
export async function resolvePluginSourceFromCatalog(
  name: string,
  deps: SearchPluginsDeps,
): Promise<ResolvedPluginSource | null> {
  const match = await findCatalogEntry(name, deps);
  return match ? resolveSourceFromMatch(match) : null;
}
