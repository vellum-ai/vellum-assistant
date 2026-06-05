/**
 * Install a plugin by name from the canonical GitHub source.
 *
 * A name resolves to one of two sources, both fetched via the GitHub Contents
 * API and materialized into `<workspacePluginsDir>/<name>/` so the daemon
 * discovers it on next start:
 *   1. A whitelisted external ecosystem plugin, when the name matches an entry
 *      in the curated `experimental/plugins/marketplace.json` manifest — fetched
 *      from that entry's pinned `owner/repo[/path]@ref` (see
 *      {@link ./plugin-marketplace}).
 *   2. Otherwise the first-party convention
 *      `vellum-ai/vellum-assistant/experimental/plugins/<name>/` at the
 *      configured ref.
 *
 * Designed for direct programmatic use. The CLI command
 * `assistant plugins install <name>` is a thin wrapper that supplies
 * production deps (`globalThis.fetch`, the live workspace directory) and
 * formats the result for the terminal; downstream callers may supply their
 * own `fetch` (e.g. an authenticated client, a retry-decorated client, or
 * a test fixture) and an override workspace directory.
 */

import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getWorkspacePluginsDir } from "../../util/platform.js";
import {
  fetchMarketplaceEntries,
  resolveMarketplaceSource,
} from "./plugin-marketplace.js";

const PLUGIN_SOURCE_OWNER = "vellum-ai";
const PLUGIN_SOURCE_REPO = "vellum-assistant";
const PLUGIN_SOURCE_PATH_PREFIX = "experimental/plugins";
/** Default git ref to fetch from when callers don't override. */
export const DEFAULT_PLUGIN_REF = "main";

/** Entry shape returned by the GitHub Contents API for a directory listing. */
interface GitHubContentEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "dir" | "symlink" | "submodule";
  readonly size: number;
  readonly download_url: string | null;
}

/**
 * Minimal `fetch` shape used by this module.
 *
 * Narrower than `typeof fetch` because Bun's `fetch` carries a `preconnect`
 * static that this module does not need — pinning to the wider type would
 * force every caller to construct a fully-featured Bun fetch.
 */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Options that control which plugin to install and how. */
export interface InstallPluginOptions {
  readonly name: string;
  /** Overwrite an existing install in place. The previous content is
   *  preserved on disk until the fetch succeeds. */
  readonly force?: boolean;
  /** Git ref (branch, tag, SHA) to fetch from. Defaults to {@link DEFAULT_PLUGIN_REF}. */
  readonly ref?: string;
}

/** Dependencies injected by the caller. */
export interface InstallPluginDeps {
  /** HTTP client. Production callers pass `globalThis.fetch.bind(globalThis)`. */
  readonly fetch: FetchLike;
  /** Override the workspace plugins directory. Falls back to {@link getWorkspacePluginsDir}. */
  readonly workspacePluginsDir?: string;
}

/** Successful install result. */
export interface InstallPluginResult {
  readonly name: string;
  /** Absolute path the plugin was materialized into. */
  readonly target: string;
  readonly fileCount: number;
  readonly ref: string;
}

/** Plugin name failed sanitization. */
export class InvalidPluginNameError extends Error {
  constructor(name: string) {
    super(
      `Invalid plugin name "${name}". Names must match /^[a-z0-9][a-z0-9_-]*$/.`,
    );
    this.name = "InvalidPluginNameError";
  }
}

/** A plugin with the same name is already installed and `--force` was not passed. */
export class PluginAlreadyInstalledError extends Error {
  constructor(
    readonly pluginName: string,
    readonly target: string,
  ) {
    super(`Plugin "${pluginName}" is already installed at ${target}.`);
    this.name = "PluginAlreadyInstalledError";
  }
}

/** GitHub responded that the plugin directory does not exist at this ref. */
export class PluginNotFoundError extends Error {
  constructor(
    readonly pluginName: string,
    readonly ref: string,
    /** `owner/repo/path` the plugin was looked for at. */
    sourceLabel: string,
  ) {
    super(`Plugin "${pluginName}" not found at ${sourceLabel} (ref ${ref}).`);
    this.name = "PluginNotFoundError";
  }
}

/** Resolved GitHub coordinates a plugin name is fetched from. */
interface PluginFetchSource {
  readonly owner: string;
  readonly repo: string;
  /** Repo-relative directory holding the plugin root; `""` = repo root. */
  readonly rootPath: string;
  readonly ref: string;
}

/** Build the `owner/repo/path` label used in not-found errors. */
function sourceLabel(source: PluginFetchSource): string {
  return source.rootPath
    ? `${source.owner}/${source.repo}/${source.rootPath}`
    : `${source.owner}/${source.repo}`;
}

/** First-party `experimental/plugins/<name>` coordinates at a given ref. */
function firstPartySource(name: string, ref: string): PluginFetchSource {
  return {
    owner: PLUGIN_SOURCE_OWNER,
    repo: PLUGIN_SOURCE_REPO,
    rootPath: `${PLUGIN_SOURCE_PATH_PREFIX}/${name}`,
    ref,
  };
}

/**
 * Probe whether a first-party plugin directory exists at the given source.
 *
 * A transient listing failure resolves to `false` so a marketplace-claimed
 * name still reaches its external source — the rare collision guarantee gives
 * way to keeping the common external-only install path working under flaky
 * network conditions.
 */
async function firstPartyPluginExists(
  source: PluginFetchSource,
  fetchFn: FetchLike,
): Promise<boolean> {
  try {
    const entries = await listDir(
      source.owner,
      source.repo,
      source.rootPath,
      source.ref,
      fetchFn,
    );
    return entries !== null && entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve a plugin name to concrete GitHub coordinates.
 *
 * First-party plugins win a name collision: a name claimed by the curated
 * marketplace is fetched from its pinned external repo only when no
 * `experimental/plugins/<name>` directory exists in-repo. This mirrors the
 * search catalog, where an in-repo plugin suppresses a same-named marketplace
 * entry — install must advertise and install the same source.
 *
 * A missing or malformed manifest degrades to first-party resolution — the
 * whitelist is supplementary and must never block installing a first-party
 * plugin. An external name then surfaces a clear not-found error downstream.
 */
async function resolvePluginSource(
  name: string,
  marketplaceRef: string,
  fetchFn: FetchLike,
): Promise<PluginFetchSource> {
  let resolved = null;
  try {
    const entries = await fetchMarketplaceEntries(
      { fetch: fetchFn },
      { ref: marketplaceRef },
    );
    resolved = resolveMarketplaceSource(name, entries);
  } catch {
    // Degrade to first-party resolution below.
  }

  const firstParty = firstPartySource(name, marketplaceRef);
  if (!resolved) return firstParty;

  if (await firstPartyPluginExists(firstParty, fetchFn)) {
    return firstParty;
  }

  return {
    owner: resolved.owner,
    repo: resolved.repo,
    rootPath: resolved.path,
    ref: resolved.ref,
  };
}

/**
 * Reject plugin names that could escape the canonical source path or the
 * install target. The source convention is a flat namespace under
 * `experimental/plugins/`, so a legitimate name is a single path segment
 * built from kebab-case alphanumerics.
 *
 * Exported so callers (e.g. the CLI input prompt) can validate up front
 * before invoking {@link installPlugin}.
 */
export function sanitizePluginName(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) {
    throw new InvalidPluginNameError(name);
  }
  return trimmed;
}

/**
 * Reject path components that could escape the staging or install target via
 * `path.join` resolution of `..`, or that contain platform path separators.
 * Used to filter entries returned by the GitHub Contents API before they
 * become filesystem paths.
 */
function assertSafeFilename(label: string, candidate: string): void {
  if (
    candidate.length === 0 ||
    candidate === "." ||
    candidate === ".." ||
    candidate.includes("/") ||
    candidate.includes("\\") ||
    // Reject any name containing a null byte (filesystem terminator) or that
    // resolves to a parent-segment when split — paranoid layer in case
    // GitHub ever serves a name like "foo/../bar".
    candidate.includes("\0") ||
    candidate.split(/[/\\]/).some((seg) => seg === "..")
  ) {
    throw new Error(
      `Unsafe ${label} from GitHub response: ${JSON.stringify(candidate)}`,
    );
  }
}

/**
 * Materialize a plugin tree into the local workspace.
 *
 * Staging: the new tree is written into a sibling staging directory and only
 * swapped into place once the fetch completes. A transient failure (5xx,
 * mid-stream 404, network loss) therefore leaves the previously installed
 * copy untouched even when the caller passed `force: true`.
 */
export async function installPlugin(
  opts: InstallPluginOptions,
  deps: InstallPluginDeps,
): Promise<InstallPluginResult> {
  const name = sanitizePluginName(opts.name);
  const marketplaceRef = opts.ref ?? DEFAULT_PLUGIN_REF;
  const force = opts.force ?? false;

  const source = await resolvePluginSource(name, marketplaceRef, deps.fetch);
  const ref = source.ref;

  const pluginsDir = deps.workspacePluginsDir ?? getWorkspacePluginsDir();
  const target = join(pluginsDir, name);

  if (existsSync(target) && !force) {
    throw new PluginAlreadyInstalledError(name, target);
  }

  // Stage into a sibling temp dir so an in-progress install never destroys
  // the currently installed version. `process.pid` keeps concurrent installs
  // of the same plugin from clobbering each other's staging.
  const stagingDir = `${target}.installing.${process.pid}`;
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  mkdirSync(stagingDir, { recursive: true });

  let fileCount: number;
  try {
    fileCount = await copyDir(
      source.owner,
      source.repo,
      source.rootPath,
      ref,
      stagingDir,
      deps.fetch,
    );
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  if (fileCount === 0) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new PluginNotFoundError(name, ref, sourceLabel(source));
  }

  // Atomic-ish swap: rmSync + renameSync. On POSIX the rename itself is
  // atomic, so the only window where the target is absent is between the
  // rm and the rename — and at that point the staging dir is fully populated.
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  renameSync(stagingDir, target);

  return { name, target, fileCount, ref };
}

async function copyDir(
  owner: string,
  repo: string,
  apiPath: string,
  ref: string,
  destDir: string,
  fetchFn: FetchLike,
): Promise<number> {
  const entries = await listDir(owner, repo, apiPath, ref, fetchFn);
  if (entries === null) return 0;

  let count = 0;
  for (const entry of entries) {
    assertSafeFilename("entry name", entry.name);
    if (entry.type === "dir") {
      const subDest = join(destDir, entry.name);
      mkdirSync(subDest, { recursive: true });
      count += await copyDir(owner, repo, entry.path, ref, subDest, fetchFn);
      continue;
    }
    if (entry.type === "file") {
      await copyFile(entry, destDir, fetchFn);
      count++;
      continue;
    }
    // Skip symlink + submodule deliberately. The daemon-side loader does not
    // follow either, so reproducing them in the install target adds risk
    // without value.
  }
  return count;
}

async function listDir(
  owner: string,
  repo: string,
  apiPath: string,
  ref: string,
  fetchFn: FetchLike,
): Promise<readonly GitHubContentEntry[] | null> {
  const url =
    `https://api.github.com/repos/${owner}/${repo}` +
    `/contents/${encodeURIComponent(apiPath).replaceAll("%2F", "/")}?ref=${encodeURIComponent(ref)}`;

  const res = await githubFetch(url, "application/vnd.github+json", fetchFn);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `GitHub contents listing failed for ${apiPath} @ ${ref}: HTTP ${res.status}`,
    );
  }

  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) {
    // A non-array body for a /contents/<dir> path means the path is a
    // file, not a directory — i.e. the plugin name resolved to a single
    // file rather than a plugin directory. Treat as not-a-plugin.
    return null;
  }
  return body as readonly GitHubContentEntry[];
}

async function copyFile(
  entry: GitHubContentEntry,
  destDir: string,
  fetchFn: FetchLike,
): Promise<void> {
  if (!entry.download_url) {
    throw new Error(`GitHub contents entry has no download_url: ${entry.path}`);
  }
  const res = await githubFetch(
    entry.download_url,
    "application/octet-stream",
    fetchFn,
  );
  if (!res.ok) {
    throw new Error(`Download failed for ${entry.path}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // entry.name was already validated by the caller; assert again as a
  // belt-and-braces guard so copyFile is safe to call from future paths.
  assertSafeFilename("file entry name", entry.name);
  const dest = join(destDir, entry.name);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
}

/**
 * Wraps `fetchFn` with the headers we want to send to GitHub for every
 * request. Unauthenticated — the canonical source is a public repo, so
 * there is nothing for an `Authorization` header to do.
 */
async function githubFetch(
  url: string,
  accept: string,
  fetchFn: FetchLike,
): Promise<Response> {
  return fetchFn(url, {
    headers: {
      Accept: accept,
      "User-Agent": "vellum-assistant-cli",
    },
  });
}
