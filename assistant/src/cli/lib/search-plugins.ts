/**
 * Search for plugin directories in the canonical GitHub source.
 *
 * Lists `vellum-ai/vellum-assistant/experimental/plugins/` at the configured
 * git ref and filters the directory entries by case-insensitive ECMAScript
 * regex. A plain query like `"memory"` matches anywhere in the name; anchors
 * like `"^simple"` work without escaping.
 *
 * Designed for direct programmatic use. The CLI command
 * `assistant plugins search <query>` is a thin wrapper that supplies
 * production deps (`globalThis.fetch`) and formats the result for the
 * terminal; downstream callers may supply their own `fetch` (e.g. a
 * retry-decorated client, or a test fixture).
 */

import type { FetchLike } from "./install-from-github.js";
import { DEFAULT_PLUGIN_REF } from "./install-from-github.js";

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

/** One matching plugin directory. */
export interface PluginSearchMatch {
  /** Directory name under `experimental/plugins/`. */
  readonly name: string;
  /** Path within the repo (e.g. `experimental/plugins/<name>`). */
  readonly path: string;
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
 * List directories under `experimental/plugins/` at {@link opts.ref} and
 * filter by {@link opts.query}.
 *
 * Only `type === "dir"` entries are returned — `experimental/plugins/`
 * follows a convention where each plugin lives in its own directory, so
 * loose files at the prefix are not plugins.
 */
export async function searchPlugins(
  opts: SearchPluginsOptions,
  deps: SearchPluginsDeps,
): Promise<SearchPluginsResult> {
  const ref = opts.ref ?? DEFAULT_PLUGIN_REF;

  // Compile the matcher up front so an invalid regex fails before we hit
  // the network — keeps "user typo" cheap to recover from.
  const matcher = buildMatcher(opts.query);

  const entries = await listDir(PLUGIN_SOURCE_PATH_PREFIX, ref, deps.fetch);

  const matches: PluginSearchMatch[] = [];
  for (const entry of entries) {
    if (entry.type !== "dir") continue;
    if (!matcher(entry.name)) continue;
    matches.push({ name: entry.name, path: entry.path });
  }
  matches.sort((a, b) => a.name.localeCompare(b.name));

  return { query: opts.query, ref, matches };
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
    // Unlike `installPlugin`, where 404 on a specific plugin name is a
    // legitimate "not found" outcome, 404 on the plugins prefix itself
    // means the canonical source path is gone — surface it as an error
    // rather than silently returning empty results.
    throw new Error(
      `GitHub contents listing failed for ${apiPath} @ ${ref}: HTTP ${res.status}`,
    );
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
async function githubFetch(
  url: string,
  fetchFn: FetchLike,
): Promise<Response> {
  return fetchFn(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "vellum-assistant-cli",
    },
  });
}
