/**
 * Install a plugin by name from the canonical GitHub source.
 *
 * A name resolves to one of two sources, materialized into
 * `<workspacePluginsDir>/<name>/` so the daemon discovers it on next start:
 *   1. A whitelisted external ecosystem plugin, when the name matches an entry
 *      in the curated `experimental/plugins/marketplace.json` manifest. The
 *      pinned `owner/repo[/path]@ref` (see {@link ./plugin-marketplace}) is
 *      fetched with a shallow `git` clone at that ref — one network operation
 *      regardless of repo size, immune to GitHub's unauthenticated API
 *      rate-limit, and recording the exact resolved commit for provenance.
 *   2. Otherwise the first-party convention
 *      `vellum-ai/vellum-assistant/experimental/plugins/<name>/` at the
 *      configured ref, fetched via the GitHub Contents API (a small handful of
 *      in-repo files — cloning the whole monorepo to install one would be
 *      wasteful).
 *
 * Designed for direct programmatic use. The CLI command
 * `assistant plugins install <name>` is a thin wrapper that supplies
 * production deps (`globalThis.fetch`, the live workspace directory) and
 * formats the result for the terminal; downstream callers may supply their
 * own `fetch` (e.g. an authenticated client, a retry-decorated client, or
 * a test fixture) and an override workspace directory.
 */

import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { getWorkspacePluginsDir } from "../../util/platform.js";
import {
  fetchMarketplaceEntries,
  resolveMarketplaceSource,
} from "./plugin-marketplace.js";

const execFileAsync = promisify(execFile);

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

/**
 * Runs a `git` subcommand in `cwd` and resolves its stdout. Injected so tests
 * can simulate a clone without spawning a real git process; production callers
 * fall back to {@link defaultGitRunner}.
 */
export type GitRunner = (
  args: readonly string[],
  opts: { readonly cwd: string },
) => Promise<{ readonly stdout: string }>;

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
  /** Override the git runner used to clone external plugin sources. Falls back to {@link defaultGitRunner}. */
  readonly runGit?: GitRunner;
}

/** Successful install result. */
export interface InstallPluginResult {
  readonly name: string;
  /** Absolute path the plugin was materialized into. */
  readonly target: string;
  readonly fileCount: number;
  readonly ref: string;
  /** Resolved commit SHA for git-cloned external sources; null for first-party (no clone). */
  readonly commit: string | null;
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

/**
 * The plugin source is temporarily unreachable — GitHub rate-limited us or
 * returned a 5xx. Distinct from a hard failure (the plugin genuinely doesn't
 * exist) so the caller can surface a retryable 503 instead of a 500.
 */
export class PluginSourceUnavailableError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PluginSourceUnavailableError";
    this.status = status;
  }
}

/**
 * Classify an upstream GitHub status as transient (worth retrying) vs hard.
 * A 429 or 5xx is always transient. A 403 is GitHub's unauthenticated
 * rate-limit signal only when the remaining-quota header is exhausted —
 * a 403 without it is a genuine authorization failure and stays hard.
 */
function isTransientUpstreamStatus(res: Response): boolean {
  if (res.status === 429 || res.status >= 500) return true;
  if (res.status === 403) {
    return res.headers.get("x-ratelimit-remaining") === "0";
  }
  return false;
}

/** Resolved GitHub coordinates a plugin name is fetched from. */
interface PluginFetchSource {
  /** Whether the plugin lives in our monorepo or an external whitelisted repo. */
  readonly kind: "first-party" | "external";
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
    kind: "first-party",
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
    kind: "external",
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
  let commit: string | null = null;
  try {
    if (source.kind === "external") {
      const cloned = await copyExternalViaGit(
        source,
        stagingDir,
        deps.runGit ?? defaultGitRunner,
      );
      fileCount = cloned.fileCount;
      commit = cloned.commit;
    } else {
      fileCount = await copyDir(
        source.owner,
        source.repo,
        source.rootPath,
        ref,
        stagingDir,
        deps.fetch,
      );
    }
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  if (fileCount === 0) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new PluginNotFoundError(name, ref, sourceLabel(source));
  }

  // Record install provenance (source coordinates + resolved commit) as a
  // hidden sidecar before the swap so it lands atomically with the files. The
  // daemon loader enumerates plugin directories and reads each plugin's
  // `package.json`, skipping dotfiles — so this never gets mistaken for code.
  writeInstallManifest(stagingDir, name, source, ref, commit);

  // Atomic-ish swap: rmSync + renameSync. On POSIX the rename itself is
  // atomic, so the only window where the target is absent is between the
  // rm and the rename — and at that point the staging dir is fully populated.
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  renameSync(stagingDir, target);

  return { name, target, fileCount, ref, commit };
}

/** Cap on any single git invocation; a shallow fetch is well under this. */
const GIT_TIMEOUT_MS = 120_000;

/** Install-provenance sidecar written at the plugin root. */
const INSTALL_MANIFEST_FILENAME = ".vellum-plugin.json";

/**
 * Materialize an external plugin by shallow-cloning its repo at the pinned ref.
 *
 * A single `git fetch --depth 1 <ref>` transfers the tree in one network
 * operation regardless of how many directories the plugin spans, so it is
 * immune to GitHub's 60/hr unauthenticated Contents-API rate limit — the
 * failure mode a recursive per-directory walk hit on plugins like caveman
 * (dozens of nested folders, one API request each). Cloning also resolves the
 * exact commit the ref points at, recorded for version provenance.
 *
 * The clone lands in a sibling scratch dir; only the plugin root (the repo
 * root, or `source.rootPath` within it) is copied into `destDir`, minus the
 * `.git` metadata and any symlinks (the loader follows neither). Returns the
 * file count and resolved commit; zero files means the ref exists but the
 * declared sub-path doesn't, which the caller maps to not-found.
 */
async function copyExternalViaGit(
  source: PluginFetchSource,
  destDir: string,
  runGit: GitRunner,
): Promise<{ fileCount: number; commit: string | null }> {
  const cloneDir = `${destDir}.gitclone`;
  rmSync(cloneDir, { recursive: true, force: true });
  mkdirSync(cloneDir, { recursive: true });

  try {
    const repoUrl = `https://github.com/${source.owner}/${source.repo}.git`;
    await runGit(["init", "--quiet"], { cwd: cloneDir });
    await runGit(["remote", "add", "origin", repoUrl], { cwd: cloneDir });

    try {
      await runGit(["fetch", "--depth", "1", "--quiet", "origin", source.ref], {
        cwd: cloneDir,
      });
    } catch (err) {
      // A missing repo/ref (or a private one we can't reach) is a hard
      // not-found, surfaced as zero files. Anything else — network loss, a
      // transient GitHub outage — is retryable, so map it to a 503.
      if (isGitRefNotFound(err)) return { fileCount: 0, commit: null };
      throw new PluginSourceUnavailableError(
        `git clone failed for ${sourceLabel(source)} @ ${source.ref}: ${gitErrorText(err)}`,
        503,
      );
    }

    await runGit(["checkout", "--quiet", "FETCH_HEAD"], { cwd: cloneDir });

    let commit: string | null = null;
    try {
      const { stdout } = await runGit(["rev-parse", "HEAD"], { cwd: cloneDir });
      commit = stdout.trim() || null;
    } catch {
      // Provenance is best-effort; a missing commit must not fail the install.
      commit = null;
    }

    const srcRoot = source.rootPath
      ? join(cloneDir, source.rootPath)
      : cloneDir;
    if (!existsSync(srcRoot) || !statSync(srcRoot).isDirectory()) {
      return { fileCount: 0, commit };
    }

    const fileCount = copyTreeSkippingGit(srcRoot, destDir);
    return { fileCount, commit };
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}

/**
 * Recursively copy regular files from `srcRoot` into `destDir`, skipping the
 * top-level `.git` directory and any symlinks. Returns the file count.
 */
function copyTreeSkippingGit(srcRoot: string, destDir: string): number {
  let count = 0;
  const walk = (relDir: string): void => {
    const absDir = relDir ? join(srcRoot, relDir) : srcRoot;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      // Drop git metadata and symlinks: the loader follows neither, and a
      // symlink could otherwise point outside the staging tree.
      if (relDir === "" && entry.name === ".git") continue;
      if (entry.isSymbolicLink()) continue;

      const rel = relDir ? join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!entry.isFile()) continue;

      const dest = join(destDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(srcRoot, rel), dest);
      count++;
    }
  };
  walk("");
  return count;
}

/** True when a git fetch failed because the repo or ref is unreachable. */
function isGitRefNotFound(err: unknown): boolean {
  const text = gitErrorText(err).toLowerCase();
  return [
    "could not find remote ref",
    "couldn't find remote ref",
    "remote branch",
    "repository not found",
    "could not read from remote repository",
    "could not read username",
    "terminal prompts disabled",
    "authentication failed",
  ].some((needle) => text.includes(needle));
}

/** Extract a stderr/message blob from a spawn error for classification/logging. */
function gitErrorText(err: unknown): string {
  if (err instanceof Error) {
    const withStreams = err as Error & { stderr?: unknown };
    const stderr =
      typeof withStreams.stderr === "string" ? withStreams.stderr : "";
    return `${err.message} ${stderr}`.trim();
  }
  return String(err);
}

/**
 * Hardened `git` runner used in production. Strips inherited `GIT_*` vars
 * (which could redirect config, hooks, or the object store), disables the
 * credential prompt so a private/missing repo fails fast instead of hanging
 * the daemon, and augments `PATH` so the real git is found when the daemon is
 * launched from a macOS `.app` bundle with a minimal environment.
 */
export const defaultGitRunner: GitRunner = async (args, opts) => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: pluginGitEnv(),
  });
  return { stdout };
};

function pluginGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"];
  const current = (env.PATH ?? "").split(":").filter(Boolean);
  const missing = extraPaths.filter((p) => !current.includes(p));
  if (missing.length > 0) {
    env.PATH = [...current, ...missing].join(":");
  }
  return env;
}

/**
 * Write the install-provenance sidecar into the staged plugin root, recording
 * the resolved source coordinates and commit so we can later report or verify
 * exactly what is installed. Hidden (dot-prefixed) so the daemon loader, which
 * skips dotfiles, never mistakes it for plugin code.
 */
function writeInstallManifest(
  stagingDir: string,
  name: string,
  source: PluginFetchSource,
  ref: string,
  commit: string | null,
): void {
  const manifest = {
    name,
    source: {
      kind: source.kind,
      owner: source.owner,
      repo: source.repo,
      path: source.rootPath || undefined,
      ref,
    },
    commit: commit ?? undefined,
    installedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(stagingDir, INSTALL_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

/**
 * Recursively copy a first-party plugin directory via the GitHub Contents API.
 *
 * First-party plugins live in our own monorepo as a small handful of files, so
 * the per-directory walk stays well within the unauthenticated rate limit —
 * and avoids cloning the entire repository just to install one plugin. Returns
 * the number of files written; zero means the directory doesn't exist at this
 * ref, which the caller maps to a not-found error.
 */
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
    // The daemon loader follows neither symlinks nor submodules; skip them.
    if (entry.type === "symlink" || entry.type === "submodule") continue;
    assertSafeFilename("entry name", entry.name);

    if (entry.type === "dir") {
      const subDest = join(destDir, entry.name);
      mkdirSync(subDest, { recursive: true });
      count += await copyDir(owner, repo, entry.path, ref, subDest, fetchFn);
      continue;
    }

    await copyFile(entry, join(destDir, entry.name), fetchFn);
    count++;
  }
  return count;
}

/** Download one file entry from the Contents API into `dest`. */
async function copyFile(
  entry: GitHubContentEntry,
  dest: string,
  fetchFn: FetchLike,
): Promise<void> {
  if (!entry.download_url) {
    throw new Error(`No download URL for ${entry.path}`);
  }
  const res = await githubFetch(
    entry.download_url,
    "application/octet-stream",
    fetchFn,
  );
  if (!res.ok) {
    const label = `Download failed for ${entry.path}: HTTP ${res.status}`;
    if (isTransientUpstreamStatus(res)) {
      throw new PluginSourceUnavailableError(label, res.status);
    }
    throw new Error(label);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
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
    const label = `GitHub contents listing failed for ${apiPath} @ ${ref}: HTTP ${res.status}`;
    if (isTransientUpstreamStatus(res)) {
      throw new PluginSourceUnavailableError(label, res.status);
    }
    throw new Error(label);
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
