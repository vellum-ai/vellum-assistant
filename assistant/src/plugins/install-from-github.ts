/**
 * Install an external plugin by name from the canonical GitHub source.
 *
 * The plugin source convention is fixed at
 * `vellum-ai/vellum-assistant/experimental/plugins/<name>/` on the configured
 * git ref. The {@link installPlugin} entry point fetches the directory tree
 * via the GitHub Contents API and materializes it into
 * `<workspacePluginsDir>/<name>/` so the daemon discovers it on next start.
 *
 * Designed for direct programmatic use. The CLI command
 * `assistant plugins install <name>` is a thin wrapper that supplies
 * production deps (`globalThis.fetch`, the live workspace directory) and
 * formats the result for the terminal; downstream callers may supply their
 * own `fetch` (e.g. an authenticated client, a retry-decorated client, or
 * a test fixture) and an override workspace directory.
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getWorkspacePluginsDir } from "../util/platform.js";

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
    super(`Invalid plugin name "${name}". Names must match /^[a-z0-9][a-z0-9_-]*$/.`);
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
  ) {
    const sourcePath = `${PLUGIN_SOURCE_OWNER}/${PLUGIN_SOURCE_REPO}/${PLUGIN_SOURCE_PATH_PREFIX}/${pluginName}`;
    super(`Plugin "${pluginName}" not found at ${sourcePath} (ref ${ref}).`);
    this.name = "PluginNotFoundError";
  }
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
    throw new Error(`Unsafe ${label} from GitHub response: ${JSON.stringify(candidate)}`);
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
  const ref = opts.ref ?? DEFAULT_PLUGIN_REF;
  const force = opts.force ?? false;

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
      `${PLUGIN_SOURCE_PATH_PREFIX}/${name}`,
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
    throw new PluginNotFoundError(name, ref);
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
  apiPath: string,
  ref: string,
  destDir: string,
  fetchFn: FetchLike,
): Promise<number> {
  const entries = await listDir(apiPath, ref, fetchFn);
  if (entries === null) return 0;

  let count = 0;
  for (const entry of entries) {
    assertSafeFilename("entry name", entry.name);
    if (entry.type === "dir") {
      const subDest = join(destDir, entry.name);
      mkdirSync(subDest, { recursive: true });
      count += await copyDir(entry.path, ref, subDest, fetchFn);
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
  apiPath: string,
  ref: string,
  fetchFn: FetchLike,
): Promise<readonly GitHubContentEntry[] | null> {
  const url =
    `https://api.github.com/repos/${PLUGIN_SOURCE_OWNER}/${PLUGIN_SOURCE_REPO}` +
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
  const res = await githubFetch(entry.download_url, "application/octet-stream", fetchFn);
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
 * request. Honors `GITHUB_TOKEN` when present so users who hit the
 * unauthenticated rate limit can opt into a higher cap.
 */
async function githubFetch(
  url: string,
  accept: string,
  fetchFn: FetchLike,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "vellum-assistant-cli",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetchFn(url, { headers });
}
