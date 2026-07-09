/**
 * Reconstruct the history of marketplace pins for a single plugin.
 *
 * The curated `plugins/marketplace.json` manifest (see {@link ./plugin-marketplace})
 * records only the *current* pin for each plugin — there is no stored version
 * list. But the manifest is a file in a Git repo, and every time a curator bumps
 * a plugin's pin, that is a commit to the manifest. So the history of reviewed
 * pins already exists as the commit history of that one file: this module walks
 * it (newest → oldest) via the GitHub API and reports the distinct pins a plugin
 * has been promoted to over time, each tagged with the marketplace commit an
 * install can reproduce it from.
 *
 * Why this is the safe source for "install an older version": every commit on
 * the default branch was reviewed and merged, so a pin drawn from this history
 * is a reviewed, known-good revision — unlike an arbitrary caller-supplied ref,
 * which the install route deliberately refuses. Resolving an older pin to the
 * marketplace commit that introduced it (rather than the plugin SHA directly)
 * also means the install reads that era's manifest, so the curated adapter stub
 * matches the pin and the historical version reproduces coherently.
 *
 * Designed for direct programmatic use with an injected `fetch`, mirroring the
 * sibling plugin libraries.
 */

import type { FetchLike } from "./fetch-like.js";
import { sanitizePluginName } from "./install-from-github.js";
import { DEFAULT_PIN_HISTORY_LIMIT } from "./plugin-constants.js";
import {
  fetchMarketplaceEntries,
  MARKETPLACE_MANIFEST_LOCATION,
} from "./plugin-marketplace.js";

/**
 * Cap on how many manifest-touching commits are inspected in one walk. Bounds
 * the GitHub API cost: a plugin whose pin changes rarely could otherwise force
 * a fetch of the manifest at every commit that touched it for *any* plugin.
 * Well above {@link DEFAULT_PIN_HISTORY_LIMIT} so the default listing is
 * complete in all but pathological histories.
 */
const MAX_MARKETPLACE_COMMITS_SCANNED = 100;

/** A single point in a plugin's marketplace-pin history. */
export interface PluginPinHistoryEntry {
  /** Plugin commit SHA pinned at this point in history. */
  readonly pin: string;
  /**
   * Marketplace-manifest commit to install this pin from — the newest commit
   * that carries it. Installing with this as the marketplace ref reproduces the
   * pin together with the curated adapter stub of the same era.
   */
  readonly marketplaceCommit: string;
  /**
   * ISO-8601 committer date (UTC) of {@link PluginPinHistoryEntry.marketplaceCommit},
   * i.e. when this pin was promoted; `null` when the date could not be read.
   */
  readonly promotedAt: string | null;
  /** True for the pin currently active on the default branch. */
  readonly current: boolean;
}

/** Options controlling the pin-history walk. */
export interface ListPinHistoryOptions {
  /** Max distinct pins to return (newest first). Defaults to {@link DEFAULT_PIN_HISTORY_LIMIT}. */
  readonly limit?: number;
  /** Marketplace branch to read history from. Defaults to `main`. */
  readonly ref?: string;
}

/** Dependencies injected by the caller. */
export interface ListPinHistoryDeps {
  /** HTTP client. Production callers pass `globalThis.fetch.bind(globalThis)`. */
  readonly fetch: FetchLike;
}

/** Shape of a commit entry from the GitHub commits API. */
interface GitHubCommitListEntry {
  readonly sha: string;
  readonly commit: {
    readonly committer?: { readonly date?: string } | null;
  } | null;
}

/** A manifest-touching commit and its committer date. */
interface ManifestCommit {
  readonly sha: string;
  readonly date: string | null;
}

/** The pin-history walk could not read the marketplace commit list. */
export class PluginPinHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginPinHistoryError";
  }
}

/**
 * List the commits that touched the marketplace manifest on `ref`, newest
 * first, capped at {@link MAX_MARKETPLACE_COMMITS_SCANNED}. A 404 (the file
 * never existed at this ref) yields an empty list.
 */
async function listManifestCommits(
  ref: string,
  fetchFn: FetchLike,
): Promise<ManifestCommit[]> {
  const { owner, repo, path } = MARKETPLACE_MANIFEST_LOCATION;
  const url =
    `https://api.github.com/repos/${owner}/${repo}/commits` +
    `?path=${encodeURIComponent(path)}` +
    `&sha=${encodeURIComponent(ref)}` +
    `&per_page=${MAX_MARKETPLACE_COMMITS_SCANNED}`;

  const res = await fetchFn(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "vellum-assistant-cli",
    },
  });
  if (res.status === 404) {
    return [];
  }
  if (!res.ok) {
    throw new PluginPinHistoryError(
      `Marketplace commit history fetch failed for ${path} @ ${ref}: HTTP ${res.status}`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch (err) {
    throw new PluginPinHistoryError(
      `Marketplace commit history is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(body)) {
    throw new PluginPinHistoryError(
      "Marketplace commit history response was not an array",
    );
  }

  const commits: ManifestCommit[] = [];
  for (const item of body as GitHubCommitListEntry[]) {
    if (typeof item?.sha !== "string") {
      continue;
    }
    const rawDate = item.commit?.committer?.date;
    commits.push({
      sha: item.sha,
      date: typeof rawDate === "string" ? rawDate : null,
    });
  }
  return commits;
}

/**
 * Resolve the plugin's pinned SHA in the manifest at a specific marketplace
 * commit, or `null` when no entry claims the name at that revision.
 */
async function pinAtCommit(
  name: string,
  marketplaceCommit: string,
  fetchFn: FetchLike,
): Promise<string | null> {
  const entries = await fetchMarketplaceEntries(
    { fetch: fetchFn },
    { ref: marketplaceCommit },
  );
  return entries.find((e) => e.name === name)?.source.ref ?? null;
}

/**
 * Walk a plugin's distinct marketplace pins, newest first. Each pin is yielded
 * once, tagged with the newest marketplace commit carrying it. Revisions where
 * the plugin is absent from the manifest are skipped (a gap, not a pin). The
 * `current` flag is set against the pin live on `ref` today.
 *
 * Bounded by {@link MAX_MARKETPLACE_COMMITS_SCANNED} commits scanned.
 */
async function* iteratePinHistory(
  name: string,
  ref: string,
  fetchFn: FetchLike,
): AsyncGenerator<PluginPinHistoryEntry> {
  const commits = await listManifestCommits(ref, fetchFn);
  if (commits.length === 0) {
    return;
  }

  // The pin live on the branch today, used to flag the current entry. Reading
  // it explicitly (rather than assuming the newest commit carries it) stays
  // correct even if the plugin was just removed from the manifest at the tip.
  const currentPin = await pinAtCommit(name, ref, fetchFn);

  let lastPin: string | null = null;
  for (const commit of commits) {
    const pin = await pinAtCommit(name, commit.sha, fetchFn);
    if (pin === null) {
      continue;
    }
    if (pin === lastPin) {
      continue;
    }
    lastPin = pin;
    yield {
      pin,
      marketplaceCommit: commit.sha,
      promotedAt: commit.date,
      current: currentPin !== null && pin === currentPin,
    };
  }
}

/**
 * List a plugin's distinct marketplace pins, newest first, capped at
 * `limit` (default {@link DEFAULT_PIN_HISTORY_LIMIT}). The first entry is the
 * current pin. An empty list means the plugin has no resolvable history at this
 * ref (never in the manifest, or the manifest does not exist).
 *
 * Throws {@link PluginPinHistoryError} when the commit list cannot be read, and
 * propagates a `MarketplaceFetchError` if a manifest revision fails to parse.
 */
export async function listPinHistory(
  name: string,
  deps: ListPinHistoryDeps,
  opts: ListPinHistoryOptions = {},
): Promise<PluginPinHistoryEntry[]> {
  const sanitized = sanitizePluginName(name);
  const ref = opts.ref ?? "main";
  const limit = opts.limit ?? DEFAULT_PIN_HISTORY_LIMIT;

  const out: PluginPinHistoryEntry[] = [];
  for await (const entry of iteratePinHistory(sanitized, ref, deps.fetch)) {
    out.push(entry);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

/**
 * Resolve a plugin pin (a full commit SHA) to the marketplace commit it should
 * be installed from, by searching the plugin's pin history. Returns `null` when
 * the pin is not found in the scanned history — i.e. it is not a reviewed pin
 * this plugin was ever promoted to (or it predates the scan window).
 *
 * Case-insensitive on the SHA, matching the rest of the install pipeline. The
 * search walks the full scan window, not just the `limit` shown by
 * {@link listPinHistory}, so a pin older than the default listing still
 * resolves.
 */
export async function resolvePinToMarketplaceCommit(
  name: string,
  pin: string,
  deps: ListPinHistoryDeps,
  opts: { readonly ref?: string } = {},
): Promise<PluginPinHistoryEntry | null> {
  const sanitized = sanitizePluginName(name);
  const ref = opts.ref ?? "main";
  const target = pin.trim().toLowerCase();
  if (target.length === 0) {
    return null;
  }

  for await (const entry of iteratePinHistory(sanitized, ref, deps.fetch)) {
    if (entry.pin.toLowerCase() === target) {
      return entry;
    }
  }
  return null;
}
