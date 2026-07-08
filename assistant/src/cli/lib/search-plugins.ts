/**
 * Search the installable plugin catalog in the canonical GitHub source.
 *
 * The catalog is the set of whitelisted external ecosystem plugins listed in
 * the curated `plugins/marketplace.json` manifest, fetched from the repo at
 * the configured git ref (see {@link ./plugin-marketplace}).
 *
 * Entries are filtered by case-insensitive ECMAScript regex against the
 * plugin name. A plain query like `"memory"` matches anywhere in the name;
 * anchors like `"^simple"` work without escaping.
 *
 * Designed for direct programmatic use. The CLI command
 * `assistant plugins search <query>` is a thin wrapper that supplies
 * production deps (`globalThis.fetch`) and formats the result for the
 * terminal; downstream callers may supply their own `fetch` (e.g. a
 * retry-decorated client, or a test fixture).
 */

import type { FetchLike } from "./fetch-like.js";
import { DEFAULT_PLUGIN_REF } from "./install-from-github.js";
import {
  fetchMarketplaceEntries,
  type MarketplaceEntry,
  MarketplaceFetchError,
} from "./plugin-marketplace.js";

/** Options that control the search. */
export interface SearchPluginsOptions {
  /**
   * ECMAScript regex pattern. Matched case-insensitively against directory
   * names. Empty string matches everything.
   */
  readonly query: string;
  /** Git ref to list from. Defaults to {@link DEFAULT_PLUGIN_REF}. */
  readonly ref?: string;
}

/** Dependencies injected by the caller. */
export interface SearchPluginsDeps {
  /** HTTP client. Production callers pass `globalThis.fetch.bind(globalThis)`. */
  readonly fetch: FetchLike;
}

/** Where a catalog match comes from. */
export type PluginMatchSource = {
  readonly kind: "github";
  /** `owner/repo` of the external plugin repository. */
  readonly repo: string;
  /** Directory within the repo, when the plugin is not at the root. */
  readonly path?: string;
  /** Pinned git ref the plugin is fetched from. */
  readonly ref: string;
};

/** One matching catalog entry. */
export interface PluginSearchMatch {
  /** Install name — `assistant plugins install <name>` resolves to it. */
  readonly name: string;
  /**
   * Human-readable origin of the entry: a `github:owner/repo[/path]@ref`
   * locator for the external plugin source.
   */
  readonly path: string;
  /** Short description, when known (external entries only today). */
  readonly description?: string;
  /**
   * Free-form grouping hint from the curated marketplace entry (e.g.
   * `productivity`), or `null` when the entry declares none.
   */
  readonly category: string | null;
  /** Discriminated origin, so callers can render/install accordingly. */
  readonly source: PluginMatchSource;
}

/** Search result envelope. */
export interface SearchPluginsResult {
  readonly query: string;
  readonly ref: string;
  readonly matches: readonly PluginSearchMatch[];
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
 * The catalog source (GitHub) was reachable but refused or could not serve
 * the request right now — rate limiting (HTTP 403 with the rate-limit budget
 * exhausted, or 429) or an upstream 5xx. Distinct from a hard 404 on the
 * plugins prefix (a real "source gone" misconfiguration): a transient
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
 * Build the catalog at {@link opts.ref} and return the entries whose name
 * matches {@link opts.query} (case-insensitive ECMAScript regex; an empty
 * query matches everything).
 */
export async function searchPlugins(
  opts: SearchPluginsOptions,
  deps: SearchPluginsDeps,
): Promise<SearchPluginsResult> {
  const ref = opts.ref ?? DEFAULT_PLUGIN_REF;

  // Compile the matcher up front so an invalid regex fails before we hit
  // the network — keeps "user typo" cheap to recover from.
  const matcher = buildMatcher(opts.query);

  const { matches: catalog } = await loadPluginCatalog({ ref }, deps);
  const matches = catalog.filter((m) => matcher(m.name));

  return { query: opts.query, ref, matches };
}

/**
 * Validate that {@link query} compiles as a case-insensitive ECMAScript regex,
 * throwing {@link InvalidSearchPatternError} if not. Lets a caching caller
 * (the daemon) reject a malformed query before loading the catalog, so a typo
 * is a cheap deterministic 400 rather than a wasted GitHub request.
 */
export function assertValidSearchPattern(query: string): void {
  buildMatcher(query);
}

/**
 * Filter a pre-loaded {@link PluginCatalog} by {@link query}, compiling it as
 * a case-insensitive ECMAScript regex (an empty query matches everything).
 * Lets a caching caller (the daemon) reuse one catalog load across many
 * searches. Throws {@link InvalidSearchPatternError} on a malformed pattern.
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
 * Build the full catalog at {@link opts.ref}: every whitelisted external
 * entry in the marketplace manifest, deduped by name.
 *
 * The result is **query-independent** — `searchPlugins` applies the regex
 * filter in memory afterwards. That separation is what lets a long-lived
 * caller (the daemon) cache one catalog load and serve any number of
 * searches from it without re-hitting GitHub (see {@link ./plugin-catalog-cache}).
 */
export async function loadPluginCatalog(
  opts: { readonly ref?: string },
  deps: SearchPluginsDeps,
): Promise<PluginCatalog> {
  const ref = opts.ref ?? DEFAULT_PLUGIN_REF;

  const marketplace = await fetchMarketplaceCatalog(deps.fetch, ref);

  const matches: PluginSearchMatch[] = [];
  const seen = new Set<string>();
  for (const entry of marketplace) {
    if (seen.has(entry.name)) continue;
    matches.push(marketplaceMatch(entry));
    seen.add(entry.name);
  }

  matches.sort((a, b) => a.name.localeCompare(b.name));

  return { ref, matches };
}

/**
 * Project a marketplace entry onto the catalog match shape, building a
 * `github:owner/repo[/path]@ref` locator for display.
 */
function marketplaceMatch(entry: MarketplaceEntry): PluginSearchMatch {
  const { repo, path, ref } = entry.source;
  const locator = `github:${repo}${path ? `/${path}` : ""}@${ref}`;
  return {
    name: entry.name,
    path: locator,
    description: entry.description,
    category: entry.category ?? null,
    source: { kind: "github", repo, path, ref },
  };
}

/**
 * Fetch the marketplace entries, mapping a transient upstream failure to
 * {@link PluginCatalogUnavailableError} so the cache can serve a stale catalog
 * and the route can surface a retryable 503. A missing manifest is a normal
 * empty catalog; a hard failure (malformed or invalid manifest) propagates
 * as-is, since the catalog is the source of truth for installable plugins.
 */
async function fetchMarketplaceCatalog(
  fetchFn: FetchLike,
  ref: string,
): Promise<readonly MarketplaceEntry[]> {
  try {
    return await fetchMarketplaceEntries({ fetch: fetchFn }, { ref });
  } catch (err) {
    if (err instanceof MarketplaceFetchError && err.transient) {
      throw new PluginCatalogUnavailableError(err.message, err.status ?? 503);
    }
    throw err;
  }
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
