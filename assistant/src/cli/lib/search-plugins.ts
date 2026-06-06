/**
 * Search the installable plugin catalog in the canonical GitHub source.
 *
 * The catalog is the union of two sources, both fetched from the repo at the
 * configured git ref:
 *   1. First-party plugins — directories under
 *      `vellum-ai/vellum-assistant/experimental/plugins/`.
 *   2. Whitelisted external ecosystem plugins — entries in the curated
 *      `experimental/plugins/marketplace.json` manifest (see
 *      {@link ./plugin-marketplace}).
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

import type { FetchLike } from "./install-from-github.js";
import { DEFAULT_PLUGIN_REF } from "./install-from-github.js";
import {
  fetchMarketplaceEntries,
  type MarketplaceEntry,
} from "./plugin-marketplace.js";

// Re-export the dep-injection type so callers can grab everything they need
// from one module rather than reaching into `install-from-github.js`.
export type { FetchLike } from "./install-from-github.js";

const PLUGIN_SOURCE_OWNER = "vellum-ai";
const PLUGIN_SOURCE_REPO = "vellum-assistant";
const PLUGIN_SOURCE_PATH_PREFIX = "experimental/plugins";

/** Entry shape returned by the GitHub Contents API for a directory listing. */
interface GitHubContentEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "dir" | "symlink" | "submodule";
  readonly size: number;
  readonly download_url: string | null;
}

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
export type PluginMatchSource =
  | { readonly kind: "first-party" }
  | {
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
   * Human-readable origin of the entry: the repo-relative path for
   * first-party plugins (e.g. `experimental/plugins/<name>`) or a
   * `github:owner/repo@ref` locator for external ones.
   */
  readonly path: string;
  /** Short description, when known (external entries only today). */
  readonly description?: string;
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
 * Build the full catalog at {@link opts.ref}: every first-party plugin
 * directory under `experimental/plugins/` merged with every whitelisted
 * external entry in the marketplace manifest.
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

  const [entries, marketplace] = await Promise.all([
    listDir(PLUGIN_SOURCE_PATH_PREFIX, ref, deps.fetch),
    fetchMarketplaceSafe(deps.fetch, ref),
  ]);

  const matches: PluginSearchMatch[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "dir") continue;
    matches.push({
      name: entry.name,
      path: entry.path,
      source: { kind: "first-party" },
    });
    seen.add(entry.name);
  }

  for (const entry of marketplace) {
    // First-party plugins win a name collision — the curated manifest is
    // additive, never an override of what ships in-repo.
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
    source: { kind: "github", repo, path, ref },
  };
}

/**
 * Fetch the marketplace manifest, degrading to an empty whitelist on any
 * failure. The manifest is supplementary to the first-party listing, so a
 * missing or malformed manifest must never break the core catalog — mirroring
 * the daemon's "never block over a subsystem failure" philosophy.
 */
async function fetchMarketplaceSafe(
  fetchFn: FetchLike,
  ref: string,
): Promise<readonly MarketplaceEntry[]> {
  try {
    return await fetchMarketplaceEntries({ fetch: fetchFn }, { ref });
  } catch {
    return [];
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

async function listDir(
  apiPath: string,
  ref: string,
  fetchFn: FetchLike,
): Promise<readonly GitHubContentEntry[]> {
  const url =
    `https://api.github.com/repos/${PLUGIN_SOURCE_OWNER}/${PLUGIN_SOURCE_REPO}` +
    `/contents/${encodeURIComponent(apiPath).replaceAll("%2F", "/")}` +
    `?ref=${encodeURIComponent(ref)}`;

  const res = await githubFetch(url, fetchFn);
  if (!res.ok) {
    const detail = `GitHub contents listing failed for ${apiPath} @ ${ref}: HTTP ${res.status}`;
    // Rate limiting (403 with the budget exhausted, or 429) and upstream
    // 5xx are transient — surface them as a retryable "temporarily
    // unavailable" so the caller can serve a stale cache and the route can
    // map to 503 instead of a misleading 500. A 404 on the plugins prefix
    // itself means the canonical source path is gone (a real
    // misconfiguration), so it stays a hard error.
    if (isTransientUpstreamStatus(res)) {
      throw new PluginCatalogUnavailableError(detail, res.status);
    }
    throw new Error(detail);
  }

  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) {
    // A non-array body for a /contents/<dir> path means the path is a
    // file, not a directory — treat the prefix as empty rather than crash.
    return [];
  }
  return body as readonly GitHubContentEntry[];
}

/**
 * Wraps `fetchFn` with the headers we want to send to GitHub for every
 * request. Unauthenticated — the canonical source is a public repo, mirroring
 * `installPlugin` which uses the same envelope.
 */
/**
 * Whether a non-OK GitHub response should be treated as a transient
 * "temporarily unavailable" failure rather than a hard error. Covers
 * rate limiting (429, or 403 once the rate-limit budget is exhausted) and
 * upstream server errors (5xx). A bare 403 without the rate-limit signal
 * (e.g. a genuine permissions problem) is not treated as transient.
 */
function isTransientUpstreamStatus(res: Response): boolean {
  if (res.status === 429 || res.status >= 500) return true;
  if (res.status === 403) {
    return res.headers.get("x-ratelimit-remaining") === "0";
  }
  return false;
}

async function githubFetch(url: string, fetchFn: FetchLike): Promise<Response> {
  return fetchFn(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "vellum-assistant-cli",
    },
  });
}
