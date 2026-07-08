/**
 * Inspect a single plugin: what is installed locally versus what the curated
 * marketplace currently pins, and whether the two have drifted.
 *
 * The marketplace pins every plugin to a full, immutable commit SHA (see
 * {@link ./plugin-marketplace}); an install records the exact commit it
 * materialized in an `install-meta.json` provenance sidecar (see
 * {@link ./install-from-github}). Drift detection is therefore an exact
 * commit-SHA comparison — the pin only moves when a curator bumps it, so a
 * mismatch means a newer pin is available. The local `package.json` version is
 * surfaced as informational metadata, not the drift signal: a semver string may
 * not change between pins, whereas the SHA always determines the bytes.
 *
 * Designed for direct programmatic use with an injected `fetch`, mirroring the
 * sibling plugin libraries. The CLI command `assistant plugins inspect <name>`
 * is a thin wrapper that supplies production deps and formats the result.
 */

import { PRESERVED_ENTRIES } from "../../plugins/plugin-tree-walk.js";
import type { FetchLike } from "./fetch-like.js";
import {
  DEFAULT_PLUGIN_REF,
  type InstallMeta,
  readInstallMeta,
  sanitizePluginName,
} from "./install-from-github.js";
import {
  type InstalledPluginInfo,
  readInstalledPlugin,
} from "./list-installed-plugins.js";
import {
  compareFingerprint,
  type FingerprintComparison,
} from "./plugin-fingerprint.js";
import {
  fetchMarketplaceEntries,
  type MarketplaceEntry,
} from "./plugin-marketplace.js";
import {
  detectPluginSurfaces,
  type PluginSurfaces,
} from "./plugin-surfaces.js";

/** Full commit SHA (40 hex SHA-1 or 64 hex SHA-256). */
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Drift classification between the installed copy and the marketplace pin.
 *
 * - `up-to-date` — installed commit equals the current marketplace pin.
 * - `update-available` — installed commit differs from the pin; a newer
 *   reviewed revision is available via `plugins install --force`.
 * - `not-installed` — no local copy; the marketplace metadata is shown as a
 *   preview of what would be installed.
 * - `not-in-marketplace` — installed but no catalog entry claims the name, so
 *   there is no advertised remote to compare against.
 * - `unknown-provenance` — installed and in the catalog, but no resolvable
 *   commit was recorded (an older or manually-copied install); reinstall to
 *   record provenance.
 * - `remote-unavailable` — installed, but the marketplace could not be reached
 *   to determine the current pin (rate-limit / network); local info is shown.
 */
export type PluginUpdateStatus =
  | "up-to-date"
  | "update-available"
  | "not-installed"
  | "not-in-marketplace"
  | "unknown-provenance"
  | "remote-unavailable";

/** Locally installed copy of a plugin. */
export interface PluginLocalInfo {
  /** Absolute path to the installed plugin directory. */
  readonly target: string;
  /** Resolved commit the copy was installed at; `null` when no provenance was recorded. */
  readonly commit: string | null;
  /**
   * ISO-8601 committer timestamp of {@link PluginLocalInfo.commit} (UTC), the
   * human-readable version `plugins inspect` shows. `null` for older installs
   * written before commit timestamps were recorded. Distinct from
   * {@link PluginLocalInfo.installedAt} (when this machine ran the install).
   */
  readonly committedAt: string | null;
  /** `package.json` `version`, when present. */
  readonly version: string | null;
  /** `package.json` `description`, when present. */
  readonly description: string | null;
  /** ISO-8601 install timestamp from the provenance sidecar; `null` when absent. */
  readonly installedAt: string | null;
  /** Source coordinates recorded at install time; `null` when no sidecar exists. */
  readonly source: InstallMeta["source"] | null;
  /**
   * Local-edit state relative to the install-time fingerprint: `null` when no
   * fingerprint was recorded (an older or manually-copied install), so
   * modification cannot be determined.
   */
  readonly localChanges: FingerprintComparison | null;
  /** Non-fatal issues with the installed copy (e.g. malformed `package.json`). */
  readonly issues: readonly string[];
}

/** The marketplace's current pin and advertised metadata for a plugin. */
export interface PluginRemoteInfo {
  /** `owner/repo` of the external plugin repository. */
  readonly repo: string;
  /** Repo-relative directory holding the plugin root; `""` = repo root. */
  readonly path: string;
  /** Pinned commit SHA the marketplace currently resolves installs to. */
  readonly commit: string;
  /**
   * ISO-8601 committer timestamp of {@link PluginRemoteInfo.commit} (UTC),
   * resolved from GitHub. `null` when the commit metadata could not be fetched
   * (network / rate-limit); the SHA is still reported.
   */
  readonly committedAt: string | null;
  readonly description: string | null;
  readonly homepage: string | null;
  readonly license: string | null;
  readonly category: string | null;
  /** Ref of the canonical repo the marketplace manifest was read from. */
  readonly marketplaceRef: string;
}

/** Resolved inspection of a single plugin. */
export interface PluginInspection {
  /** Install name. Matches `assistant plugins install <name>`. */
  readonly name: string;
  /** Whether a copy is materialized under the workspace plugins directory. */
  readonly installed: boolean;
  /** Drift classification between the installed copy and the marketplace pin. */
  readonly status: PluginUpdateStatus;
  /** Locally installed copy; `null` when the plugin is not installed. */
  readonly local: PluginLocalInfo | null;
  /** Marketplace pin + metadata; `null` when no entry claims the name or it was unreachable. */
  readonly remote: PluginRemoteInfo | null;
  /** Marketplace fetch error message, when the catalog could not be read. */
  readonly remoteError: string | null;
  /**
   * Surfaces the installed copy contributes (skills, hooks, tools), read from
   * its on-disk tree. `null` when the plugin is not installed — there is no
   * tree to inspect, and the marketplace metadata does not enumerate surfaces.
   */
  readonly surfaces: PluginSurfaces | null;
}

/** Neither an installed copy nor a marketplace entry claims the name. */
export class PluginInspectNotFoundError extends Error {
  constructor(readonly pluginName: string) {
    super(
      `Plugin "${pluginName}" is not installed and has no marketplace entry.`,
    );
    this.name = "PluginInspectNotFoundError";
  }
}

/** Options that control which plugin to inspect. */
export interface InspectPluginOptions {
  /** Install name (kebab-case directory name). */
  readonly name: string;
}

/** Dependencies injected by the caller. */
export interface InspectPluginDeps {
  /** HTTP client. Production callers pass `globalThis.fetch.bind(globalThis)`. */
  readonly fetch: FetchLike;
  /** Override the workspace plugins directory. Falls back to the live workspace. */
  readonly workspacePluginsDir?: string;
}

function readLocal(
  entry: InstalledPluginInfo,
  manifest: InstallMeta | null,
): PluginLocalInfo {
  // The provenance commit is authoritative; fall back to the recorded ref only
  // when it is itself a full SHA (marketplace installs always pin one), so a
  // sidecar written before the commit could be read still yields a comparable
  // revision instead of dropping to "unknown".
  const commit =
    manifest?.commit ??
    (manifest && FULL_SHA_RE.test(manifest.source.ref)
      ? manifest.source.ref
      : null);
  // Compare the on-disk tree against the install-time baseline, applying the
  // same exclusion so the sidecar is never counted as a local addition.
  const localChanges = manifest?.fingerprint
    ? compareFingerprint(entry.target, manifest.fingerprint, PRESERVED_ENTRIES)
    : null;
  return {
    target: entry.target,
    commit,
    committedAt: manifest?.committedAt ?? null,
    version: entry.packageJson?.version ?? null,
    description: entry.packageJson?.description ?? null,
    installedAt: manifest?.installedAt || null,
    source: manifest?.source ?? null,
    localChanges,
    issues: entry.issues,
  };
}

function readRemote(
  entry: MarketplaceEntry,
  marketplaceRef: string,
  committedAt: string | null,
): PluginRemoteInfo {
  return {
    repo: entry.source.repo,
    path: entry.source.path ?? "",
    commit: entry.source.ref,
    committedAt,
    description: entry.description ?? null,
    homepage: entry.homepage ?? null,
    license: entry.license ?? null,
    category: entry.category ?? null,
    marketplaceRef,
  };
}

/**
 * Resolve the committer date of a pinned commit from GitHub, normalized to a
 * UTC ISO-8601 string so it is directly comparable with the install-time
 * {@link PluginLocalInfo.committedAt}.
 *
 * Best-effort: any failure (network, rate-limit, unexpected shape) yields
 * `null` so inspection still reports the remote pin's SHA without its date,
 * mirroring how the local side degrades to `unknown` when no date was recorded.
 */
async function fetchCommitDate(
  repo: string,
  sha: string,
  fetch: FetchLike,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(sha)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "vellum-assistant-cli",
      },
    });
    if (!res.ok) {
      return null;
    }
    const json: unknown = JSON.parse(await res.text());
    if (typeof json !== "object" || json === null) {
      return null;
    }
    const commit = (json as Record<string, unknown>).commit;
    if (typeof commit !== "object" || commit === null) {
      return null;
    }
    const committer = (commit as Record<string, unknown>).committer;
    if (typeof committer !== "object" || committer === null) {
      return null;
    }
    const date = (committer as Record<string, unknown>).date;
    if (typeof date !== "string") {
      return null;
    }
    const ms = Date.parse(date);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the local-vs-remote inspection for a single plugin.
 *
 * Throws {@link PluginInspectNotFoundError} only when the plugin is neither
 * installed nor present in the marketplace — there is nothing to show. A
 * marketplace fetch failure for an *installed* plugin is not fatal: the local
 * copy is reported with `status: "remote-unavailable"`.
 */
export async function inspectPlugin(
  opts: InspectPluginOptions,
  deps: InspectPluginDeps,
): Promise<PluginInspection> {
  const name = sanitizePluginName(opts.name);
  const marketplaceRef = DEFAULT_PLUGIN_REF;

  const entry = readInstalledPlugin(name, {
    workspacePluginsDir: deps.workspacePluginsDir,
  });
  const installed = entry !== null;
  const local = entry ? readLocal(entry, readInstallMeta(entry.target)) : null;
  const surfaces = entry ? detectPluginSurfaces(entry.target) : null;

  let remote: PluginRemoteInfo | null = null;
  let remoteError: string | null = null;
  try {
    const entries = await fetchMarketplaceEntries(
      { fetch: deps.fetch },
      { ref: marketplaceRef },
    );
    const match = entries.find((e) => e.name === name);
    if (match) {
      const committedAt = await fetchCommitDate(
        match.source.repo,
        match.source.ref,
        deps.fetch,
      );
      remote = readRemote(match, marketplaceRef, committedAt);
    }
  } catch (err) {
    remoteError = err instanceof Error ? err.message : String(err);
  }

  if (!installed && !remote) {
    // A reachable-but-empty catalog with no local copy is a genuine not-found;
    // a fetch failure with no local copy leaves nothing to report either.
    throw new PluginInspectNotFoundError(name);
  }

  const status = classify(installed, local, remote, remoteError);
  return { name, installed, status, local, remote, remoteError, surfaces };
}

function classify(
  installed: boolean,
  local: PluginLocalInfo | null,
  remote: PluginRemoteInfo | null,
  remoteError: string | null,
): PluginUpdateStatus {
  if (!installed) {
    return "not-installed";
  }
  if (remoteError && !remote) {
    return "remote-unavailable";
  }
  if (!remote) {
    return "not-in-marketplace";
  }
  if (!local?.commit) {
    return "unknown-provenance";
  }
  return local.commit.toLowerCase() === remote.commit.toLowerCase()
    ? "up-to-date"
    : "update-available";
}
