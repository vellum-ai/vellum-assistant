/**
 * Install a plugin by name from the canonical GitHub source.
 *
 * A name resolves to a whitelisted external ecosystem plugin — an entry in the
 * curated `plugins/marketplace.json` manifest. The pinned
 * `owner/repo[/path]@ref` (see {@link ./plugin-marketplace}) is fetched with a
 * shallow `git` clone at that ref — one network operation regardless of repo
 * size, immune to GitHub's unauthenticated API rate-limit, and recording the
 * exact resolved commit for provenance — and materialized into
 * `<workspacePluginsDir>/<name>/` so the daemon discovers it on next start.
 *
 * When we curate an adapter stub for the plugin (a `plugins/<name>/` directory
 * in this repo with a `scripts.postinstall` command), the stub is overlaid
 * onto the clone and its postinstall runs to translate a foreign-ecosystem
 * layout into the shape Vellum's loader runs (see {@link applyAdapterStub}). A
 * name with no marketplace entry is a not-found.
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
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { PRESERVED_ENTRIES } from "../../plugins/plugin-tree-walk.js";
import { ensureBun } from "../../util/bun-runtime.js";
import { getWorkspacePluginsDir } from "../../util/platform.js";
import type { FetchLike } from "./fetch-like.js";
import {
  computeContentHash,
  computeFingerprint,
  type Fingerprint,
  parseFingerprint,
} from "./plugin-fingerprint.js";
import {
  fetchMarketplaceEntries,
  MarketplaceFetchError,
  type ResolvedPluginSource,
  resolveMarketplaceSource,
} from "./plugin-marketplace.js";

const execFileAsync = promisify(execFile);

const PLUGIN_SOURCE_OWNER = "vellum-ai";
const PLUGIN_SOURCE_REPO = "vellum-assistant";
const PLUGIN_SOURCE_PATH_PREFIX = "plugins";
/** Default git ref to fetch from when callers don't override. */
export const DEFAULT_PLUGIN_REF = "main";

/** Full Git commit SHA — 40 hex chars (SHA-1) or 64 (SHA-256). */
const FULL_COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** True when `ref` is a full, immutable commit SHA (not a branch/tag/HEAD). */
export function isFullCommitSha(ref: string): boolean {
  return FULL_COMMIT_SHA_RE.test(ref);
}

/** Entry shape returned by the GitHub Contents API for a directory listing. */
interface GitHubContentEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "dir" | "symlink" | "submodule";
  readonly size: number;
  readonly download_url: string | null;
}

/**
 * Runs a `git` subcommand in `cwd` and resolves its stdout. Injected so tests
 * can simulate a clone without spawning a real git process; production callers
 * fall back to {@link defaultGitRunner}.
 */
export type GitRunner = (
  args: readonly string[],
  opts: { readonly cwd: string },
) => Promise<{ readonly stdout: string }>;

/**
 * Runs a plugin's postinstall adapter script in `cwd`. Injected so tests can
 * assert the adapter is invoked (and simulate its effects) without spawning a
 * real subprocess; production callers fall back to {@link defaultPostinstallRunner}.
 */
export type PostinstallRunner = (opts: {
  /** The staged install directory the adapter transforms in place. */
  readonly cwd: string;
  /** Absolute path to the adapter script to execute. */
  readonly script: string;
}) => Promise<void>;

/** Options that control which plugin to install and how. */
export interface InstallPluginOptions {
  readonly name: string;
  /** Overwrite an existing install in place. The previous content is
   *  preserved on disk until the fetch succeeds. */
  readonly force?: boolean;
  /** Git ref (branch, tag, SHA) to fetch from. Defaults to {@link DEFAULT_PLUGIN_REF}. */
  readonly ref?: string;
  /**
   * Materialize this exact plugin commit SHA instead of the pin the marketplace
   * manifest records, while still resolving the plugin's owner/repo/path (and
   * the curated adapter stub) from the manifest at {@link InstallPluginOptions.ref}.
   * This is the CLI-only escape hatch for installing an unreviewed revision; the
   * adapter stub therefore comes from the manifest's `ref`, not the override's
   * era, so an adapted plugin may not reproduce a historical version faithfully.
   * Unset for normal installs, which take the reviewed pin from the manifest.
   */
  readonly commitOverride?: string;
  /**
   * Install directly from these GitHub coordinates, bypassing the curated
   * `plugins/marketplace.json` whitelist. The tree is materialized verbatim —
   * no curated adapter stub is overlaid — and the source is *untrusted*, so the
   * caller is responsible for surfacing a warning. Used to install a plugin not
   * yet in the marketplace (typically one still under development). When set,
   * {@link InstallPluginOptions.ref}, {@link InstallPluginOptions.commitOverride},
   * and marketplace resolution are all skipped; `directSource.ref` selects the
   * commit to clone (a branch, tag, `HEAD`, or full SHA).
   */
  readonly directSource?: PluginFetchSource;
}

/** Dependencies injected by the caller. */
export interface InstallPluginDeps {
  /** HTTP client. Production callers pass `globalThis.fetch.bind(globalThis)`. */
  readonly fetch: FetchLike;
  /** Override the workspace plugins directory. Falls back to {@link getWorkspacePluginsDir}. */
  readonly workspacePluginsDir?: string;
  /** Override the git runner used to clone external plugin sources. Falls back to {@link defaultGitRunner}. */
  readonly runGit?: GitRunner;
  /** Override the runner used to execute a plugin's postinstall adapter. Falls back to {@link defaultPostinstallRunner}. */
  readonly runPostinstall?: PostinstallRunner;
}

/** Successful install result. */
export interface InstallPluginResult {
  readonly name: string;
  /** Absolute path the plugin was materialized into. */
  readonly target: string;
  readonly fileCount: number;
  readonly ref: string;
  /** Resolved commit SHA the external source was cloned at; null when it could not be read. */
  readonly commit: string | null;
  /**
   * ISO-8601 committer timestamp of {@link InstallPluginResult.commit} (UTC);
   * null when the commit or its date could not be read.
   */
  readonly committedAt: string | null;
}

/** Plugin name failed sanitization. */
export class InvalidPluginNameError extends Error {
  constructor(name: string, reason?: string) {
    super(
      reason
        ? `Invalid plugin name "${name}". ${reason}`
        : `Invalid plugin name "${name}". Names must match /^[a-z0-9][a-z0-9_-]*$/.`,
    );
    this.name = "InvalidPluginNameError";
  }
}

/**
 * A plugin's curated postinstall adapter failed — its `scripts.postinstall`
 * command was malformed/unsupported, its script was missing, or the script
 * exited non-zero. The install is aborted and rolled back rather than
 * materializing a half-transformed, non-functional plugin.
 */
export class PluginPostinstallError extends Error {
  constructor(
    readonly pluginName: string,
    detail: string,
  ) {
    super(`Postinstall adapter for "${pluginName}" failed: ${detail}`);
    this.name = "PluginPostinstallError";
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
  if (res.status === 429 || res.status >= 500) {
    return true;
  }
  if (res.status === 403) {
    return res.headers.get("x-ratelimit-remaining") === "0";
  }
  return false;
}

/** Resolved GitHub coordinates a plugin name is fetched from. */
export interface PluginFetchSource {
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

/**
 * Resolve a plugin name to the concrete GitHub coordinates of its pinned
 * marketplace entry, or `null` when no entry claims the name.
 *
 * The marketplace is external-only by construction — a same-named
 * `plugins/<name>` directory is the plugin's optional *adapter stub* (a curated
 * `package.json` + postinstall script overlaid onto the clone to translate it
 * into Vellum's shape; see {@link applyAdapterStub}), not a standalone plugin.
 *
 * A transient marketplace failure (rate-limit / 5xx) surfaces as a retryable
 * {@link PluginSourceUnavailableError}; a malformed manifest propagates as a
 * hard error, since the marketplace is the source of truth for what is
 * installable.
 */
async function resolvePluginSource(
  name: string,
  marketplaceRef: string,
  fetchFn: FetchLike,
): Promise<PluginFetchSource | null> {
  let resolved: ResolvedPluginSource | null;
  try {
    const entries = await fetchMarketplaceEntries(
      { fetch: fetchFn },
      { ref: marketplaceRef },
    );
    resolved = resolveMarketplaceSource(name, entries);
  } catch (err) {
    if (err instanceof MarketplaceFetchError && err.transient) {
      throw new PluginSourceUnavailableError(err.message, err.status ?? 503);
    }
    throw err;
  }

  if (!resolved) {
    return null;
  }

  return {
    owner: resolved.owner,
    repo: resolved.repo,
    rootPath: resolved.path,
    ref: resolved.ref,
  };
}

/**
 * Prefix reserved for first-party default plugins that ship in the assistant
 * source tree. User-installable plugins must not use it — the `.disabled`
 * sentinel and the plugin registry both key on manifest names, and a
 * user plugin with a `default-` name would shadow or collide with the
 * built-in.
 */
export const RESERVED_PLUGIN_PREFIX = "default-";

/**
 * Reject plugin names that could escape the canonical source path or the
 * install target. The source convention is a flat namespace under
 * `plugins/`, so a legitimate name is a single path segment
 * built from kebab-case alphanumerics.
 *
 * Names prefixed with {@link RESERVED_PLUGIN_PREFIX} (`default-`) are also
 * rejected — that prefix is reserved for first-party default plugins.
 *
 * Exported so callers (e.g. the CLI input prompt) can validate up front
 * before invoking {@link installPlugin}.
 */
export function sanitizePluginName(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) {
    throw new InvalidPluginNameError(name);
  }
  if (trimmed.startsWith(RESERVED_PLUGIN_PREFIX)) {
    throw new InvalidPluginNameError(
      name,
      `The "${RESERVED_PLUGIN_PREFIX}" prefix is reserved for first-party default plugins.`,
    );
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

  // A direct install bypasses the marketplace whitelist entirely: the source is
  // supplied by the caller and the tree is materialized verbatim (no curated
  // adapter stub). Otherwise the name is resolved against the reviewed manifest.
  let effectiveSource: PluginFetchSource;
  // Ref the curated adapter stub is fetched at, or `null` to skip the overlay.
  let stubRef: string | null;
  if (opts.directSource) {
    effectiveSource = opts.directSource;
    stubRef = null;
  } else {
    const source = await resolvePluginSource(name, marketplaceRef, deps.fetch);
    if (!source) {
      throw new PluginNotFoundError(
        name,
        marketplaceRef,
        "plugins/marketplace.json",
      );
    }
    // A commit override installs a specific plugin revision while still taking
    // owner/repo/path (and the adapter stub, via `marketplaceRef`) from the
    // manifest; otherwise the reviewed pin from the manifest is materialized.
    effectiveSource = opts.commitOverride
      ? { ...source, ref: opts.commitOverride }
      : source;
    stubRef = marketplaceRef;
  }
  const ref = effectiveSource.ref;

  const pluginsDir = deps.workspacePluginsDir ?? getWorkspacePluginsDir();
  const target = join(pluginsDir, name);

  if (existsSync(target) && !force) {
    throw new PluginAlreadyInstalledError(name, target);
  }

  // Stage *outside* the served `plugins/` directory. The daemon watches that
  // directory and its startup loader enumerates it, so a staging dir living
  // inside it is observed mid-install — before the adapter overlay runs, an
  // external clone still carries its upstream `package.json` (wrong name, no
  // plugin-api peer dep), which the loader rejects with spurious name-mismatch
  // and missing-peer-dependency warnings. Staging in a sibling directory keeps
  // the half-built tree invisible until the final swap. The root is on the
  // same filesystem as the target, so that swap stays an atomic rename.
  // `process.pid` keeps concurrent installs of the same plugin from clobbering
  // each other's staging.
  const stagingRoot = join(dirname(pluginsDir), ".plugins-staging");
  mkdirSync(stagingRoot, { recursive: true });
  const stagingDir = join(stagingRoot, `${name}.installing.${process.pid}`);
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  mkdirSync(stagingDir, { recursive: true });

  let fileCount: number;
  let commit: string | null = null;
  let committedAt: string | null = null;
  try {
    const materialized = await materializePluginTree(
      {
        source: effectiveSource,
        name,
        stubRef,
        destDir: stagingDir,
      },
      deps,
    );
    fileCount = materialized.fileCount;
    commit = materialized.commit;
    committedAt = materialized.committedAt;
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  if (fileCount === 0) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new PluginNotFoundError(name, ref, sourceLabel(effectiveSource));
  }

  finalizeStagedInstall(stagingDir, {
    name,
    source: effectiveSource,
    ref,
    commit,
    committedAt,
    pluginsDir,
  });

  return { name, target, fileCount, ref, commit, committedAt };
}

/** Inputs for {@link finalizeStagedInstall}. */
export interface FinalizeStagedInstallParams {
  readonly name: string;
  /** Source coordinates recorded in the provenance sidecar. */
  readonly source: PluginFetchSource;
  /** Ref recorded in the sidecar (the resolved commit SHA for marketplace installs). */
  readonly ref: string;
  readonly commit: string | null;
  /** ISO-8601 committer timestamp of {@link FinalizeStagedInstallParams.commit} (UTC); null when unknown. */
  readonly committedAt: string | null;
  /** Artifact integrity digest (`sha256:<hex>`) recorded for platform-endpoint installs; omitted for git installs. */
  readonly etag?: string;
  /** Served plugins directory; the staging dir is swapped into `<pluginsDir>/<name>`. */
  readonly pluginsDir: string;
}

/**
 * Fingerprint a fully-populated `stagingDir`, write its provenance sidecar, and
 * atomically swap it into `<pluginsDir>/<name>`. Returns the final install path
 * and the fingerprint that was recorded.
 *
 * Shared by {@link installPlugin} (fresh materialization) and the merge-based
 * `plugins upgrade --strategy` path so both record identical provenance and use
 * the same atomic rm+rename swap.
 */
export function finalizeStagedInstall(
  stagingDir: string,
  {
    name,
    source,
    ref,
    commit,
    committedAt,
    etag,
    pluginsDir,
  }: FinalizeStagedInstallParams,
): { target: string; fingerprint: Fingerprint } {
  // Hash the materialized tree before the sidecar is written (so the sidecar
  // never hashes itself) — the baseline `plugins inspect` uses to detect later
  // local edits. The per-file fingerprint answers "which files changed"; the
  // whole-tree content hash is a compact integrity signal mirroring skills.
  const fingerprint = computeFingerprint(stagingDir, PRESERVED_ENTRIES);
  const contentHash = computeContentHash(stagingDir, PRESERVED_ENTRIES);

  // Record install provenance (source coordinates + resolved commit + content
  // digests) as a sidecar before the swap so it lands atomically with the
  // files. The external plugin loader only reads `package.json` and the
  // `hooks/`/`tools/` dirs, so this JSON file is never mistaken for code.
  writeInstallMeta(stagingDir, {
    name,
    source,
    ref,
    commit,
    committedAt,
    etag,
    fingerprint,
    contentHash,
  });

  // Atomic-ish swap: rmSync + renameSync. On POSIX the rename itself is
  // atomic, so the only window where the target is absent is between the
  // rm and the rename — and at that point the staging dir is fully populated.
  // Ensure the served `plugins/` directory exists: staging now lives outside
  // it, so the target's parent is no longer created as a side effect.
  const target = join(pluginsDir, name);
  mkdirSync(pluginsDir, { recursive: true });

  // Copy preserved entries (config.json, data/, .disabled) from the existing
  // install into the staging dir before the swap so user-owned state survives
  // upgrades and reinstalls. Without this, the rm+rename below would destroy
  // user config and runtime data.
  if (existsSync(target)) {
    for (const entry of PRESERVED_ENTRIES) {
      if (entry === INSTALL_META_FILENAME) {
        continue;
      } // sidecar is rewritten above
      const src = join(target, entry);
      if (!existsSync(src)) {
        continue;
      }
      const dest = join(stagingDir, entry);
      const stat = statSync(src);
      if (stat.isDirectory()) {
        cpSync(src, dest, { recursive: true });
      } else {
        copyFileSync(src, dest);
      }
    }
    rmSync(target, { recursive: true, force: true });
  }
  renameSync(stagingDir, target);

  return { target, fingerprint };
}

/** Cap on any single git invocation; a shallow fetch is well under this. */
const GIT_TIMEOUT_MS = 120_000;

/**
 * Install-provenance sidecar written at the plugin root. Named to match the
 * skills' sidecar (`install-meta.json`, see `src/skills/install-meta.ts`) so
 * both subsystems share one vocabulary. The external plugin loader only reads
 * `package.json` and the `hooks/`/`tools/` surface dirs, so a plain JSON file
 * at the root is ignored by it.
 */
export const INSTALL_META_FILENAME = "install-meta.json";

/**
 * Which catalog manages an installed plugin. Mirrors the skill origin values
 * (`SkillInstallMeta.origin` in `src/skills/install-meta.ts`) so the two
 * systems keep a consistent vocabulary. `"vellum"` denotes the first-party
 * `marketplace.json`; the union widens as new sources are supported.
 */
export type InstallOrigin = "vellum";

/** Resolved source coordinates recorded in the provenance sidecar. */
export interface InstallMetaSource {
  /** Source kind. Only `github` is written today. */
  readonly kind: string;
  readonly owner: string;
  readonly repo: string;
  /** Repo-relative directory holding the plugin root; absent = repo root. */
  readonly path?: string;
  /** Ref the install resolved through (the pinned commit SHA for marketplace installs). */
  readonly ref: string;
}

/**
 * Parsed contents of the `install-meta.json` provenance sidecar — what was
 * installed, from where, and at exactly which commit. Read by
 * {@link readInstallMeta} for provenance reporting (e.g. `plugins inspect`).
 *
 * The leading fields share names (and meaning) with the skills'
 * `SkillInstallMeta`; everything below {@link InstallMeta.name} is the
 * plugin-specific superset that the git-backed install needs.
 */
export interface InstallMeta {
  /** Catalog the install is managed from. */
  readonly origin: InstallOrigin;
  /** ISO-8601 timestamp of when the install was materialized. */
  readonly installedAt: string;
  /** Principal that initiated the install, when known. */
  readonly installedBy?: string;
  /** Set by a backfill migration when provenance was reconstructed after the fact. */
  readonly backfilledBy?: string;
  /** Plugin `package.json` version at install time, when present. */
  readonly version?: string;
  /** Registry slug, recorded when it diverges from {@link InstallMeta.name}. */
  readonly slug?: string;
  /** `owner/repo` the install was sourced from. */
  readonly sourceRepo?: string;
  /**
   * Whole-tree `v2:` content hash — a compact integrity signal using the same
   * scheme as the skills' `contentHash`. Complements the per-file
   * {@link InstallMeta.fingerprint}.
   */
  readonly contentHash?: string;
  /**
   * Authorship provenance, mirroring the skills' `SkillInstallMeta.author`.
   * GitHub installs are user-initiated, so they record `"user"`; this protects
   * them from the usage-based prune that only targets `"assistant"` entries.
   */
  readonly author?: "assistant" | "user";

  /** Install name. Matches the plugins directory and `plugins install <name>`. */
  readonly name: string;
  readonly source: InstallMetaSource;
  /** Resolved commit SHA the source was cloned at; `null` when it could not be read at install time. */
  readonly commit: string | null;
  /**
   * Integrity digest of the downloaded artifact, when the install came through
   * the platform install endpoint (`ETag: "sha256:<hex>"`). Recorded verbatim
   * (including the `sha256:` prefix) as a stable id for caching / dedupe and to
   * document what was verified. Absent for git-cloned installs, which have no
   * single artifact to hash.
   */
  readonly etag?: string;
  /**
   * ISO-8601 committer timestamp of {@link InstallMeta.commit}, in UTC
   * (e.g. `2026-06-01T12:34:56.000Z`). This is a property of the commit
   * itself, distinct from {@link InstallMeta.installedAt} (when the local
   * machine ran the install). `null` for older installs written before commit
   * timestamps were recorded, or when the date could not be read. Reserved for
   * the human-readable "version" surfaced by `plugins inspect`; the optional
   * {@link InstallMeta.version} field stays free for future tag/semver support.
   */
  readonly committedAt?: string | null;
  /**
   * Per-file content digest of the materialized tree, captured at install
   * time. `null` for older installs written before fingerprinting; callers
   * then report local-modification state as unknown rather than clean.
   */
  readonly fingerprint: Fingerprint | null;
}

/** Outcome of materializing an external plugin tree into a directory. */
export interface MaterializedTree {
  /** Number of regular files written into the destination. */
  readonly fileCount: number;
  /** Commit SHA the source was cloned at; `null` when it could not be read. */
  readonly commit: string | null;
  /** ISO-8601 committer timestamp of {@link MaterializedTree.commit}; `null` when unread. */
  readonly committedAt: string | null;
}

/**
 * Produce the exact plugin tree an install stages, into `destDir`: clone the
 * source at `source.ref`, then overlay the curated adapter stub (when one
 * exists) so a foreign-ecosystem clone is translated into Vellum shape.
 *
 * `installPlugin` calls this and then fingerprints, records provenance, and
 * swaps the result into the workspace. `diffPlugin` (see {@link ./diff-plugin})
 * calls it with the *recorded install commit* to reconstruct the install-time
 * baseline. Routing both through one path guarantees a re-materialized commit
 * is byte-identical to what the original install produced, so an install-time
 * adapter transform never reads as local drift when diffing.
 */
export async function materializePluginTree(
  opts: {
    /** Source coordinates; `source.ref` selects the commit to clone. */
    readonly source: PluginFetchSource;
    /** Install name, used to locate the curated adapter stub. */
    readonly name: string;
    /**
     * Ref the curated adapter stub is fetched at (the canonical repo ref), or
     * `null` to skip the adapter overlay entirely. Direct (untrusted) installs
     * pass `null`: they are materialized verbatim, never reshaped by a curated
     * stub keyed on the install name.
     */
    readonly stubRef: string | null;
    /** Directory the tree is written into. */
    readonly destDir: string;
  },
  deps: InstallPluginDeps,
): Promise<MaterializedTree> {
  const cloned = await copyExternalViaGit(
    opts.source,
    opts.destDir,
    deps.runGit ?? defaultGitRunner,
  );
  // An external clone is often a foreign-ecosystem plugin (e.g. a Claude Code
  // plugin) that the Vellum loader can't run as-is. When we curate an adapter
  // stub for it, overlay the stub and run its transform so the materialized
  // tree is a valid Vellum plugin. Raw clones (no stub) are left untouched,
  // except for a minimal package.json synthesis when the upstream repo shipped
  // none — the Vellum loader hard-requires one and would silently skip the
  // plugin without it. The synthesis runs only for direct installs
  // (stubRef === null); the upgrade path re-materializes baselines through
  // this function with a non-null stubRef, and synthesizing a package.json
  // not present at install time would corrupt the fingerprint comparison.
  if (cloned.fileCount > 0 && opts.stubRef !== null) {
    await applyAdapterStub(opts.name, opts.stubRef, opts.destDir, deps);
  }
  if (
    cloned.fileCount > 0 &&
    opts.stubRef === null &&
    !existsSync(join(opts.destDir, "package.json"))
  ) {
    synthesizeMinimalPackageJson(opts.name, opts.destDir);
  }
  return cloned;
}

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
): Promise<{
  fileCount: number;
  commit: string | null;
  committedAt: string | null;
}> {
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
      if (isGitRefNotFound(err)) {
        return { fileCount: 0, commit: null, committedAt: null };
      }
      throw new PluginSourceUnavailableError(
        `git clone failed for ${sourceLabel(source)} @ ${source.ref}: ${subprocessErrorText(err)}`,
        503,
      );
    }

    await runGit(["checkout", "--quiet", "FETCH_HEAD"], { cwd: cloneDir });

    let commit: string | null = null;
    let committedAt: string | null = null;
    try {
      const { stdout } = await runGit(["rev-parse", "HEAD"], { cwd: cloneDir });
      commit = stdout.trim() || null;
    } catch {
      // Provenance is best-effort; a missing commit must not fail the install.
      commit = null;
    }
    if (commit) {
      // The committer date (`%ct`, UNIX seconds) is the version timestamp
      // `plugins inspect` shows. Normalize to a UTC ISO-8601 string so installs
      // made in different local timezones remain directly comparable.
      try {
        const { stdout } = await runGit(
          ["show", "-s", "--format=%ct", "HEAD"],
          { cwd: cloneDir },
        );
        const seconds = Number.parseInt(stdout.trim(), 10);
        if (Number.isFinite(seconds)) {
          committedAt = new Date(seconds * 1000).toISOString();
        }
      } catch {
        // Best-effort: a missing date must not fail the install.
        committedAt = null;
      }
    }

    // Defense in depth: when the requested ref is a full commit SHA (every
    // marketplace ref is — the manifest schema rejects mutable tags/branches),
    // the checked-out commit must equal it. If it ever diverges, refuse the
    // install rather than materialize and `import()` unexpected code. A direct
    // install from a branch/tag/HEAD has no fixed SHA to compare against, so the
    // check only applies to pinned refs.
    if (
      commit &&
      isFullCommitSha(source.ref) &&
      commit.toLowerCase() !== source.ref.toLowerCase()
    ) {
      throw new PluginSourceUnavailableError(
        `git checkout of ${sourceLabel(source)} resolved to ${commit}, ` +
          `which does not match the pinned commit ${source.ref}`,
        502,
      );
    }

    const srcRoot = source.rootPath
      ? join(cloneDir, source.rootPath)
      : cloneDir;
    if (!existsSync(srcRoot) || !statSync(srcRoot).isDirectory()) {
      return { fileCount: 0, commit, committedAt };
    }

    const fileCount = copyTreeSkippingGit(srcRoot, destDir);
    return { fileCount, commit, committedAt };
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}

/** Cap on a postinstall adapter; the curated transforms are fast and file-only. */
const POSTINSTALL_TIMEOUT_MS = 60_000;

/**
 * Overlay our curated adapter stub onto a freshly cloned external plugin and
 * run its postinstall transform, returning whether a transform ran.
 *
 * The stub lives at `plugins/<name>/` in our own repo and carries
 * a `package.json` (with a `scripts.postinstall` adapter command) plus the
 * adapter script it names. We fetch it via the Contents API — a couple of
 * small files, well within the rate limit — and copy it over the clone so the
 * postinstall we run is ours, never the upstream repo's lifecycle script. The
 * overlaid stub `package.json` exists only to name that adapter; the installed
 * plugin's manifest is rebuilt from the upstream `package.json` afterwards (see
 * {@link normalizeInstalledManifest}). Absent a stub (the common case for a
 * plugin already in Vellum shape), nothing is overlaid and the clone is
 * installed as-is.
 *
 * On any adapter failure the error propagates so {@link installPlugin} rolls
 * back staging — better to fail loudly than ship a half-transformed plugin.
 */
async function applyAdapterStub(
  name: string,
  ref: string,
  stagingDir: string,
  deps: InstallPluginDeps,
): Promise<boolean> {
  // Capture the cloned upstream manifest before the stub overlay replaces it,
  // so the installed plugin can preserve it verbatim except for the two fields
  // the Vellum loader requires (name + plugin-api peer dep).
  const upstreamPkg = readPackageJson(join(stagingDir, "package.json"));

  const stubFileCount = await copyDir(
    PLUGIN_SOURCE_OWNER,
    PLUGIN_SOURCE_REPO,
    `${PLUGIN_SOURCE_PATH_PREFIX}/${name}`,
    ref,
    stagingDir,
    deps.fetch,
  );
  if (stubFileCount === 0) {
    return false;
  }

  const script = resolvePostinstallScript(name, stagingDir);
  if (script === null) {
    return false;
  }

  const run = deps.runPostinstall ?? defaultPostinstallRunner;
  try {
    await run({ cwd: stagingDir, script });
  } catch (err) {
    throw new PluginPostinstallError(name, subprocessErrorText(err));
  }

  normalizeInstalledManifest(name, stagingDir, upstreamPkg);
  return true;
}

/**
 * Default `@vellumai/plugin-api` peer-dependency range stamped onto an adapted
 * plugin that doesn't already declare one.
 */
const PLUGIN_API_PEER_RANGE = ">=0.8.0";

type PackageManifest = Record<string, unknown>;

/** Parse the `package.json` at `path`, or null if it's absent or unparseable. */
function readPackageJson(path: string): PackageManifest | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as PackageManifest)
      : null;
  } catch {
    return null;
  }
}

/**
 * Write the installed plugin's final `package.json` after the adapter has run.
 *
 * A curated adapter stub deliberately overlays its own `package.json` onto the
 * clone so the installer can find and run the stub's `scripts.postinstall`.
 * That stub is install-time machinery, not the plugin's manifest, so once the
 * adapter has run we rebuild the manifest from the upstream `package.json`
 * captured before the overlay — preserving its `version`, `description`,
 * `license`, and every other field — and mutate only what the Vellum loader
 * requires: `name` must equal the install directory, and `@vellumai/plugin-api`
 * must be declared as a peer dependency. The spent `postinstall` script is
 * dropped so the installed plugin carries no install-time machinery.
 *
 * When the upstream repo shipped no `package.json`, the overlaid stub is the
 * only manifest available, so it becomes the base instead.
 */
function normalizeInstalledManifest(
  name: string,
  stagingDir: string,
  upstreamPkg: PackageManifest | null,
): void {
  const manifestPath = join(stagingDir, "package.json");
  const base = upstreamPkg ?? readPackageJson(manifestPath) ?? {};

  const peer =
    typeof base.peerDependencies === "object" && base.peerDependencies !== null
      ? (base.peerDependencies as Record<string, unknown>)
      : {};
  const existingRange = peer["@vellumai/plugin-api"];

  const manifest: PackageManifest = {
    ...base,
    name,
    peerDependencies: {
      ...peer,
      "@vellumai/plugin-api":
        typeof existingRange === "string"
          ? existingRange
          : PLUGIN_API_PEER_RANGE,
    },
  };

  if (typeof manifest.scripts === "object" && manifest.scripts !== null) {
    const scripts = { ...(manifest.scripts as Record<string, unknown>) };
    delete scripts.postinstall;
    if (Object.keys(scripts).length === 0) {
      delete manifest.scripts;
    } else {
      manifest.scripts = scripts;
    }
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * Write a minimal Vellum-compatible `package.json` into a staged plugin that
 * shipped no manifest of its own. The Vellum external plugin loader
 * (`buildPluginFromDir`) hard-requires a `package.json` validated against
 * `PluginPackageJsonSchema` and silently skips the plugin when it's missing.
 *
 * When a `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` is
 * present, its `name`, `version`, and `description` fields are carried over so
 * the synthesized manifest reflects the upstream identity rather than an
 * anonymous stub. The `@vellumai/plugin-api` peer dependency is stamped at the
 * same default range used by {@link normalizeInstalledManifest}.
 */
function synthesizeMinimalPackageJson(
  name: string,
  stagingDir: string,
): void {
  const manifestPath = join(stagingDir, "package.json");

  // Try to read metadata from a Claude Code or Codex plugin manifest so the
  // synthesized package.json carries the upstream name, version, and
  // description rather than a bare skeleton.
  const foreignManifest = readForeignPluginManifest(stagingDir);

  const manifest: PackageManifest = {
    name,
    version: foreignManifest?.version ?? "0.0.0",
    ...(foreignManifest?.description
      ? { description: foreignManifest.description }
      : {}),
    peerDependencies: {
      "@vellumai/plugin-api": PLUGIN_API_PEER_RANGE,
    },
  };

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * Read a `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` manifest
 * from a staged plugin directory, returning the `name`, `version`, and
 * `description` fields if present. Returns `undefined` when neither file exists
 * or neither can be parsed.
 */
function readForeignPluginManifest(
  stagingDir: string,
): { name?: string; version?: string; description?: string } | undefined {
  for (const dir of [".claude-plugin", ".codex-plugin"]) {
    const path = join(stagingDir, dir, "plugin.json");
    const parsed = readPackageJson(path);
    if (parsed !== null) {
      const name = typeof parsed.name === "string" ? parsed.name : undefined;
      const version =
        typeof parsed.version === "string" ? parsed.version : undefined;
      const description =
        typeof parsed.description === "string"
          ? parsed.description
          : undefined;
      if (name || version || description) {
        return { name, version, description };
      }
    }
  }
  return undefined;
}

/**
 * Resolve the absolute path of the adapter script named by the (overlaid stub)
 * `package.json`'s `scripts.postinstall`, or `null` when there is no stub
 * package.json / postinstall script.
 *
 * Curated adapters declare a single `bun <script>` invocation; bun is resolved
 * via {@link ensureBun} at execution time (see {@link defaultPostinstallRunner})
 * so the `bun` token marks the convention without hard-coding the binary path.
 * Anything else — extra args, a shell pipeline, a non-script file — is rejected
 * rather than executed, and the script path is constrained to a file inside the
 * staging dir so a stub can never escape it.
 */
function resolvePostinstallScript(
  name: string,
  stagingDir: string,
): string | null {
  const pkgPath = join(stagingDir, "package.json");
  if (!existsSync(pkgPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }

  const scripts =
    typeof parsed === "object" && parsed !== null && "scripts" in parsed
      ? (parsed as { scripts?: unknown }).scripts
      : undefined;
  const command =
    typeof scripts === "object" && scripts !== null && "postinstall" in scripts
      ? (scripts as { postinstall?: unknown }).postinstall
      : undefined;
  if (typeof command !== "string" || command.trim() === "") {
    return null;
  }

  const match = /^bun\s+(\S+)$/.exec(command.trim());
  if (!match) {
    throw new PluginPostinstallError(
      name,
      `unsupported postinstall command ${JSON.stringify(command)} — ` +
        "curated adapters must be a single `bun <script>` invocation",
    );
  }

  let rel = match[1]!;
  if (rel.startsWith("./")) {
    rel = rel.slice(2);
  }
  if (!/\.(?:ts|mts|cts|mjs|cjs|js)$/.test(rel)) {
    throw new PluginPostinstallError(
      name,
      `postinstall script ${JSON.stringify(rel)} must be a ` +
        ".ts/.mts/.cts/.mjs/.cjs/.js file",
    );
  }
  for (const segment of rel.split("/")) {
    assertSafeFilename("postinstall script segment", segment);
  }

  const abs = resolve(stagingDir, rel);
  if (
    abs !== resolve(stagingDir) &&
    !abs.startsWith(`${resolve(stagingDir)}${sep}`)
  ) {
    throw new PluginPostinstallError(
      name,
      `postinstall script ${JSON.stringify(rel)} escapes the plugin directory`,
    );
  }
  if (!existsSync(abs)) {
    throw new PluginPostinstallError(
      name,
      `postinstall script ${JSON.stringify(rel)} was not found in the plugin`,
    );
  }
  return abs;
}

/**
 * Production postinstall runner: executes the adapter with a real `bun` binary
 * resolved via {@link ensureBun}, under a stripped environment and a timeout.
 *
 * `process.execPath` is unusable here: inside a `bun build --compile` binary it
 * is the compiled assistant app, not the bun CLI (see `util/bun-runtime.ts`),
 * so passing the adapter script to it would launch the daemon rather than
 * interpret the script. `ensureBun()` locates (or downloads) a standalone bun
 * the same way every other subsystem that spawns bun does. The minimal env
 * (bun's dir + standard bins, `HOME` only) keeps the adapter from inheriting
 * surprising config while still finding the runtime.
 */
export const defaultPostinstallRunner: PostinstallRunner = async ({
  cwd,
  script,
}) => {
  const bun = await ensureBun();
  await execFileAsync(bun, [script], {
    cwd,
    encoding: "utf8",
    timeout: POSTINSTALL_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: pluginPostinstallEnv(bun),
  });
};

function pluginPostinstallEnv(bun: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: [
      dirname(bun),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]
      .filter(Boolean)
      .join(":"),
  };
  if (process.env.HOME) {
    env.HOME = process.env.HOME;
  }
  return env;
}

/**
 * Recursively copy regular files from `srcRoot` into `destDir`, skipping the
 * top-level `.git` directory, a top-level `bunfig.toml` (see below), and any
 * symlinks. Returns the file count.
 */
function copyTreeSkippingGit(srcRoot: string, destDir: string): number {
  let count = 0;
  const walk = (relDir: string): void => {
    const absDir = relDir ? join(srcRoot, relDir) : srcRoot;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      // Drop git metadata and symlinks: the loader follows neither, and a
      // symlink could otherwise point outside the staging tree.
      if (relDir === "" && entry.name === ".git") {
        continue;
      }
      // Drop a top-level `bunfig.toml`. The adapter postinstall runs `bun` with
      // its cwd at the staged root, and Bun auto-loads `$cwd/bunfig.toml` as
      // project config — including a `preload` list it executes before the
      // entry point. An upstream config would therefore run arbitrary code
      // ahead of the curated adapter, defeating the command/env guards. Bun
      // reads only the cwd's file (it neither walks up nor descends), so
      // dropping it at the root closes the vector; a Vellum plugin never
      // consumes `bunfig.toml`. Match case-insensitively because the macOS
      // install target's filesystem is case-insensitive, where Bun would still
      // open a clone-supplied `BUNFIG.TOML`.
      if (relDir === "" && entry.name.toLowerCase() === "bunfig.toml") {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }

      const rel = relDir ? join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

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
  const text = subprocessErrorText(err).toLowerCase();
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
function subprocessErrorText(err: unknown): string {
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
    if (value !== undefined && !key.startsWith("GIT_")) {
      env[key] = value;
    }
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

/** Inputs for {@link writeInstallMeta}, resolved during a fresh install. */
interface WriteInstallMetaParams {
  readonly name: string;
  readonly source: PluginFetchSource;
  readonly ref: string;
  readonly commit: string | null;
  /** ISO-8601 committer timestamp of {@link WriteInstallMetaParams.commit} (UTC); null when unknown. */
  readonly committedAt: string | null;
  /** Artifact integrity digest (`sha256:<hex>`) recorded for platform-endpoint installs; omitted for git installs. */
  readonly etag?: string;
  readonly fingerprint: Fingerprint;
  readonly contentHash: string;
}

/**
 * Read the `version` field from a staged plugin's `package.json`. Lenient — a
 * missing or malformed manifest simply yields `undefined` so provenance is
 * recorded without it rather than failing the install.
 */
function readStagedPackageVersion(stagingDir: string): string | undefined {
  const pkgPath = join(stagingDir, "package.json");
  if (!existsSync(pkgPath)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const version = (parsed as Record<string, unknown>).version;
      if (typeof version === "string" && version.length > 0) {
        return version;
      }
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

/**
 * Write the `install-meta.json` provenance sidecar into the staged plugin root,
 * recording the resolved source coordinates, commit, and content digests so we
 * can later report or verify exactly what is installed. The schema is an
 * equal-name superset of the skills' `SkillInstallMeta`.
 */
function writeInstallMeta(
  stagingDir: string,
  {
    name,
    source,
    ref,
    commit,
    committedAt,
    etag,
    fingerprint,
    contentHash,
  }: WriteInstallMetaParams,
): void {
  const meta: InstallMeta = {
    origin: "vellum",
    installedAt: new Date().toISOString(),
    version: readStagedPackageVersion(stagingDir),
    sourceRepo: `${source.owner}/${source.repo}`,
    contentHash,
    author: "user",
    name,
    source: {
      kind: "github",
      owner: source.owner,
      repo: source.repo,
      path: source.rootPath || undefined,
      ref,
    },
    commit,
    committedAt,
    ...(etag ? { etag } : {}),
    fingerprint,
  };
  writeFileSync(
    join(stagingDir, INSTALL_META_FILENAME),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
}

/**
 * Read the install-provenance sidecar from an installed plugin's root.
 *
 * Lenient by design — a missing, unreadable, or malformed sidecar yields
 * `null` rather than throwing, mirroring {@link ./list-installed-plugins}.
 * Older or manually-copied installs that predate the sidecar simply report no
 * provenance. The resolved commit is the authoritative record of which bytes
 * are installed, so callers (e.g. `plugins inspect`) can compare it against the
 * marketplace's current pin to detect drift.
 */
export function readInstallMeta(pluginDir: string): InstallMeta | null {
  const metaPath = join(pluginDir, INSTALL_META_FILENAME);
  if (!existsSync(metaPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const src = obj.source;
  if (typeof src !== "object" || src === null || Array.isArray(src)) {
    return null;
  }
  const source = src as Record<string, unknown>;
  if (
    typeof obj.name !== "string" ||
    typeof source.owner !== "string" ||
    typeof source.repo !== "string" ||
    typeof source.ref !== "string"
  ) {
    return null;
  }

  const optionalString = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;

  return {
    origin: "vellum",
    installedAt: typeof obj.installedAt === "string" ? obj.installedAt : "",
    installedBy: optionalString(obj.installedBy),
    backfilledBy: optionalString(obj.backfilledBy),
    version: optionalString(obj.version),
    slug: optionalString(obj.slug),
    sourceRepo: optionalString(obj.sourceRepo),
    contentHash: optionalString(obj.contentHash),
    author:
      obj.author === "assistant" || obj.author === "user"
        ? obj.author
        : undefined,
    name: obj.name,
    source: {
      kind: typeof source.kind === "string" ? source.kind : "github",
      owner: source.owner,
      repo: source.repo,
      path: typeof source.path === "string" ? source.path : undefined,
      ref: source.ref,
    },
    commit: typeof obj.commit === "string" ? obj.commit : null,
    ...(typeof obj.etag === "string" ? { etag: obj.etag } : {}),
    committedAt: typeof obj.committedAt === "string" ? obj.committedAt : null,
    fingerprint: parseFingerprint(obj.fingerprint),
  };
}

/**
 * Recursively copy a curated adapter stub directory via the GitHub Contents API.
 *
 * An adapter stub lives in our own monorepo at `plugins/<name>/` as a small
 * handful of files (a `package.json` + postinstall script), so the
 * per-directory walk stays well within the unauthenticated rate limit — and
 * avoids cloning the entire repository just to overlay it. Returns the number
 * of files written; zero means no stub exists at this ref, in which case the
 * external clone is installed as-is.
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
  if (entries === null) {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    // The daemon loader follows neither symlinks nor submodules; skip them.
    if (entry.type === "symlink" || entry.type === "submodule") {
      continue;
    }
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
  if (res.status === 404) {
    return null;
  }
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
