/**
 * Filtering and projection helpers for the installable plugin catalog.
 *
 * The catalog itself is resolved by {@link ./plugin-catalog-cache}
 * (`getPluginCatalog`), which is platform-first with a bundled offline
 * fallback. This module owns the query semantics on top of a resolved
 * catalog: compile a pattern, filter entries by name, and project a raw
 * marketplace entry onto the catalog match shape.
 *
 * Entries are filtered by case-insensitive ECMAScript regex against the
 * plugin name. A plain query like `"memory"` matches anywhere in the name;
 * anchors like `"^simple"` work without escaping.
 */

import type { FetchLike } from "./fetch-like.js";
import type { MarketplaceEntry } from "./plugin-marketplace.js";

/** Dependencies injected by the caller. */
export interface SearchPluginsDeps {
  /** HTTP client. Production callers pass `globalThis.fetch.bind(globalThis)`. */
  readonly fetch: FetchLike;
  /** Optional feature-flag resolver for deterministic tests. */
  readonly featureFlagEnabled?: (key: string) => boolean;
}

/** Where a catalog match comes from. */
export type PluginMatchSource =
  | {
      readonly kind: "github";
      /** `owner/repo` of the external plugin repository. */
      readonly repo: string;
      /** Directory within the repo, when the plugin is not at the root. */
      readonly path?: string;
      /** Pinned git ref the plugin is fetched from. */
      readonly ref: string;
    }
  | {
      readonly kind: "local";
      /** Exact package key in the assistant's embedded plugin bundle. */
      readonly path: string;
      readonly version: string;
      readonly repo?: undefined;
      readonly ref?: undefined;
    };

export interface McpPluginIntegration {
  readonly kind: "mcp";
  readonly displayName: string;
  readonly documentationUrl: string;
  readonly verifiedAt: string;
  readonly verification: "documentation-only";
  readonly setup: {
    readonly mode: "oauth" | "manual";
    readonly instructions: string;
  };
  readonly logo: string;
  readonly oauthProvider?: string;
}

/** One matching catalog entry. */
export interface PluginSearchMatch {
  /** Install name — `assistant plugins install <name>` resolves to it. */
  readonly name: string;
  /**
   * Human-readable origin: either `github:owner/repo[/path]@ref` or
   * `local:plugins/path@version`.
   */
  readonly path: string;
  /** Short description, when known. */
  readonly description?: string;
  /**
   * Plugin icon: a curated emoji from the marketplace entry, or an icon URL
   * served by the platform catalog when the plugin ships a bundled image.
   */
  readonly icon?: string;
  /**
   * Free-form grouping hint from the curated marketplace entry (e.g.
   * `productivity`), or `null` when the entry declares none.
   */
  readonly category: string | null;
  /** Homepage URL, from the curated marketplace entry when present. */
  readonly homepage?: string;
  /** License identifier, from the curated marketplace entry when present. */
  readonly license?: string;
  readonly integration?: McpPluginIntegration;
  /** Discriminated origin, so callers can render/install accordingly. */
  readonly source: PluginMatchSource;
}

/** Caller passed a query that doesn't compile as an ECMAScript regex. */
export class InvalidSearchPatternError extends Error {
  constructor(pattern: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Invalid regex pattern ${JSON.stringify(pattern)}: ${detail}`);
    this.name = "InvalidSearchPatternError";
  }
}

/**
 * The catalog source was reachable but refused or could not serve the request
 * right now — rate limiting or an upstream 5xx. Distinct from a hard 404 on
 * the plugins prefix (a real "source gone" misconfiguration): a transient
 * upstream failure should surface as a retryable "temporarily unavailable"
 * rather than a generic internal error, and is a candidate for serving a
 * stale cached catalog.
 */
export class PluginCatalogUnavailableError extends Error {
  /** Upstream HTTP status that triggered the failure. */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PluginCatalogUnavailableError";
    this.status = status;
  }
}

/**
 * Validate that {@link query} compiles as a case-insensitive ECMAScript regex,
 * throwing {@link InvalidSearchPatternError} if not. Lets a caller reject a
 * malformed query before loading the catalog, so a typo is a cheap
 * deterministic error rather than a wasted catalog fetch.
 */
export function assertValidSearchPattern(query: string): void {
  buildMatcher(query);
}

/**
 * Filter a pre-loaded {@link PluginCatalog} by {@link query}, compiling it as
 * a case-insensitive ECMAScript regex (an empty query matches everything).
 * Lets a caller reuse one catalog load across many searches. Throws
 * {@link InvalidSearchPatternError} on a malformed pattern.
 */
export function filterPluginCatalog(
  catalog: PluginCatalog,
  query: string,
): PluginSearchMatch[] {
  const matcher = buildMatcher(query);
  return catalog.matches.filter((m) => matcher(m.name));
}

/** The full, unfiltered catalog at a given ref. */
export interface PluginCatalog {
  readonly ref: string;
  /** Every catalog entry, deduped and sorted alphabetically by name. */
  readonly matches: readonly PluginSearchMatch[];
}

/**
 * Project a marketplace entry onto the catalog match shape, building a
 * a source-specific locator for display.
 *
 * Shared by the platform fetcher and bundled reader so all catalog sources
 * project entries identically.
 */
export function marketplaceMatch(entry: MarketplaceEntry): PluginSearchMatch {
  const source: PluginMatchSource =
    entry.source.source === "github"
      ? {
          kind: "github",
          repo: entry.source.repo,
          path: entry.source.path,
          ref: entry.source.ref,
        }
      : {
          kind: "local",
          path: entry.source.path,
          version: entry.source.version,
        };
  const locator =
    source.kind === "github"
      ? `github:${source.repo}${source.path ? `/${source.path}` : ""}@${
          source.ref
        }`
      : `local:${source.path}@${source.version}`;
  return {
    name: entry.name,
    path: locator,
    description: entry.description,
    icon: entry.icon,
    category: entry.category ?? null,
    homepage: entry.homepage,
    license: entry.license,
    integration: entry.integration,
    source,
  };
}

/**
 * Project raw marketplace entries onto catalog matches: dedupe by name
 * (first occurrence wins), map via {@link marketplaceMatch}, and return
 * sorted alphabetically by name.
 *
 * Shared by every catalog source (platform fetcher, bundled reader) so they
 * dedupe, project, and order entries identically.
 */
export function projectMarketplaceEntries(
  entries: Iterable<MarketplaceEntry>,
): PluginSearchMatch[] {
  const matches: PluginSearchMatch[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      continue;
    }
    seen.add(entry.name);
    matches.push(marketplaceMatch(entry));
  }
  matches.sort((a, b) => a.name.localeCompare(b.name));
  return matches;
}

function buildMatcher(query: string): (name: string) => boolean {
  let re: RegExp;
  try {
    re = new RegExp(query, "i");
  } catch (err) {
    throw new InvalidSearchPatternError(query, err);
  }
  return (name) => re.test(name);
}
