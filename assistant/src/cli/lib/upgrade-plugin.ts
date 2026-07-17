/**
 * Upgrade a single installed plugin to its source's current revision.
 *
 * A marketplace plugin pins to a full, immutable commit SHA (see
 * {@link ./plugin-marketplace}); an upgrade re-materializes the install at
 * whatever SHA the catalog currently advertises. Drift is detected with the
 * same exact commit-SHA comparison {@link ./inspect-plugin} uses, so an
 * upgrade is a no-op when the installed copy already matches the pin.
 *
 * A plugin installed directly from a GitHub URL (untrusted, not in the
 * marketplace) is upgraded against its *recorded* source instead: its
 * `install-meta.json` names the owner/repo/path/ref it was cloned from, and the
 * upgrade target is whatever that ref resolves to now — a pinned SHA is
 * immutable (a no-op), a branch / tag / `HEAD` advances as upstream does. Such
 * an upgrade re-materializes verbatim, with no curated adapter overlay, exactly
 * as the original untrusted install was (see {@link directUpgrade}).
 *
 * This is deliberately a distinct operation from install: `install` is
 * first-time materialization (and errors on an existing install unless
 * `--force` is passed), whereas `upgrade` moves an existing install forward.
 *
 * How local edits are reconciled with the pin is controlled by the
 * {@link PluginUpgradeStrategy}. `overwrite` (the default) moves via a forced
 * re-install at the current pin — the underlying
 * {@link ./install-from-github.installPlugin} performs that atomically, and the
 * previously installed copy (including any local edits) is replaced wholesale.
 * `ours`/`theirs`/`assistant` instead three-way merge the on-disk tree and the
 * pin against the re-materialized install commit so non-conflicting local edits
 * survive; conflicting hunks resolve toward the local edit (`ours`) or the pin
 * (`theirs`), while `assistant` writes git conflict markers into the file and
 * reports the conflicted paths for the assistant to resolve.
 *
 * Designed for direct programmatic use with injected dependencies, mirroring
 * the sibling plugin libraries. The CLI command `assistant plugins upgrade
 * <name>` is a thin wrapper that supplies production deps and formats the
 * result.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PRESERVED_ENTRIES } from "../../plugins/plugin-tree-walk.js";
import { getWorkspacePluginsDir } from "../../util/platform.js";
import type { FetchLike } from "./fetch-like.js";
import {
  fetchCommitDate,
  inspectPlugin,
  type PluginInspection,
  PluginInspectNotFoundError,
  type PluginLocalInfo,
} from "./inspect-plugin.js";
import {
  finalizeStagedInstall,
  type GitRunner,
  installPlugin,
  materializePluginTree,
  type PluginFetchSource,
  PluginNotFoundError,
  PluginSourceUnavailableError,
  type PostinstallRunner,
  readInstallMeta,
  resolveRefCommit,
  sanitizePluginName,
} from "./install-from-github.js";
import { type ConflictLabels, mergePluginTree } from "./merge-plugin-tree.js";
/**
 * How local edits to an installed plugin are reconciled with the marketplace
 * pin during an upgrade.
 *
 * - `overwrite` (default) — discard all local edits and re-install the pin
 *   wholesale. Matches the historical upgrade behavior.
 * - `ours` — three-way merge; conflicting hunks resolve toward the local edit.
 * - `theirs` — three-way merge; conflicting hunks resolve toward the pin.
 * - `assistant` — three-way merge that writes git conflict markers into
 *   conflicting files and reports them for the assistant to resolve.
 */
import {
  DEFAULT_PLUGIN_REF,
  DEFAULT_PLUGIN_UPGRADE_STRATEGY,
  type PluginUpgradeStrategy,
} from "./plugin-constants.js";
import { computeFingerprint, fingerprintsEqual } from "./plugin-fingerprint.js";
import { PluginNotInstalledError } from "./uninstall-plugin.js";

/**
 * Outcome of an upgrade attempt.
 *
 * - `upgraded` — the install was moved to the current marketplace pin.
 * - `already-up-to-date` — the installed commit already equals the pin; no-op.
 * - `would-upgrade` — a `--dry-run` that found drift but made no changes.
 */
export type PluginUpgradeOutcome =
  | "upgraded"
  | "already-up-to-date"
  | "would-upgrade";

/** Options that control which plugin to upgrade and how. */
export interface UpgradePluginOptions {
  /** Install name (kebab-case directory name). */
  readonly name: string;
  /** Report what would change without modifying the install. */
  readonly dryRun?: boolean;
  /**
   * How to reconcile local edits with the pin. Defaults to
   * {@link DEFAULT_PLUGIN_UPGRADE_STRATEGY}.
   */
  readonly strategy?: PluginUpgradeStrategy;
}

/** Dependencies injected by the caller. */
export interface UpgradePluginDeps {
  /** HTTP client. Production callers pass `globalThis.fetch.bind(globalThis)`. */
  readonly fetch: FetchLike;
  /** Override the workspace plugins directory. Falls back to the live workspace. */
  readonly workspacePluginsDir?: string;
  /** Override the git runner used to clone the source. Forwarded to {@link installPlugin}. */
  readonly runGit?: GitRunner;
  /** Override the postinstall adapter runner. Forwarded to {@link installPlugin}. */
  readonly runPostinstall?: PostinstallRunner;
}

/** Result of an upgrade attempt. */
export interface PluginUpgradeResult {
  readonly name: string;
  readonly outcome: PluginUpgradeOutcome;
  /** Installed commit before the upgrade; `null` when no provenance was recorded. */
  readonly fromCommit: string | null;
  /**
   * ISO-8601 committer timestamp (UTC) of {@link PluginUpgradeResult.fromCommit},
   * the human-readable version moved from; `null` when it was not recorded.
   */
  readonly fromTimestamp: string | null;
  /** Marketplace-pinned commit the install was (or would be) moved to. */
  readonly toCommit: string;
  /**
   * ISO-8601 committer timestamp (UTC) of {@link PluginUpgradeResult.toCommit},
   * the human-readable version moved to; `null` when it could not be resolved.
   */
  readonly toTimestamp: string | null;
  /** Absolute path to the installed plugin directory. */
  readonly target: string;
  /** Files materialized by the upgrade; `null` for a no-op or dry run. */
  readonly fileCount: number | null;
  /** Whether this was a dry run (no changes made). */
  readonly dryRun: boolean;
  /** Conflict-resolution strategy the upgrade applied. */
  readonly strategy: PluginUpgradeStrategy;
  /**
   * Paths (relative to {@link PluginUpgradeResult.target}) left for the
   * assistant to resolve under the `assistant` strategy: text files carry git
   * conflict markers, modify/delete divergences keep the surviving content.
   * Always empty for other strategies.
   */
  readonly conflicts: readonly string[];
  /**
   * Paths of binary files that conflicted under the `assistant` strategy; the
   * local copy was kept since markers cannot be written into binary content.
   * Always empty for other strategies.
   */
  readonly binaryConflicts: readonly string[];
  /**
   * Whether the installed copy lacked resolvable provenance before the
   * upgrade. Such installs are re-pinned to the current SHA, which also
   * records provenance going forward.
   */
  readonly provenanceWasUnknown: boolean;
}

/** An installed plugin has no marketplace pin to upgrade to. */
export class PluginNotUpgradableError extends Error {
  constructor(
    readonly pluginName: string,
    reason: string,
  ) {
    super(`Plugin "${pluginName}" cannot be upgraded: ${reason}.`);
    this.name = "PluginNotUpgradableError";
  }
}

/**
 * A merge strategy (`ours`/`theirs`) was requested but the install-time
 * baseline needed for a three-way merge cannot be reconstructed.
 */
export class PluginMergeBaselineError extends Error {
  constructor(
    readonly pluginName: string,
    reason: string,
  ) {
    super(
      `Plugin "${pluginName}" cannot be merge-upgraded: ${reason}. Use '--strategy overwrite' to take the pin wholesale, or reinstall with 'plugins install ${pluginName} --force'.`,
    );
    this.name = "PluginMergeBaselineError";
  }
}

function pluginTarget(name: string, deps: UpgradePluginDeps): string {
  const dir = deps.workspacePluginsDir ?? getWorkspacePluginsDir();
  return join(dir, name);
}

/**
 * Move an installed plugin to its source's current revision — the marketplace
 * pin for a catalog plugin, or the recorded GitHub ref's current commit for a
 * directly-installed one (delegated to {@link directUpgrade}).
 *
 * The `strategy` controls how local edits are reconciled with the target:
 * `overwrite` (default) re-installs it wholesale; `ours`/`theirs`/
 * `assistant` do a three-way merge that carries non-conflicting local edits
 * forward, resolving conflicting hunks toward the local edit (`ours`) or the
 * target (`theirs`), or leaving git conflict markers in the file for the
 * assistant to resolve (`assistant`).
 *
 * Throws {@link PluginNotInstalledError} when no copy is installed,
 * {@link PluginNotUpgradableError} when the install is neither in the
 * marketplace nor carries a recorded GitHub source to advance,
 * {@link PluginMergeBaselineError} when a merge strategy is requested but the
 * install-time baseline cannot be reconstructed,
 * {@link PluginSourceUnavailableError} when the marketplace catalog or the
 * plugin source is temporarily unreachable (a retryable outage, distinct from
 * the permanent no-source case), and propagates {@link installPlugin}'s errors
 * (e.g. source unavailable, postinstall failure) when the re-install itself
 * fails.
 */
export async function upgradePlugin(
  opts: UpgradePluginOptions,
  deps: UpgradePluginDeps,
): Promise<PluginUpgradeResult> {
  const name = sanitizePluginName(opts.name);
  const dryRun = opts.dryRun ?? false;
  const strategy = opts.strategy ?? DEFAULT_PLUGIN_UPGRADE_STRATEGY;

  let inspection: PluginInspection;
  try {
    inspection = await inspectPlugin(
      { name },
      { fetch: deps.fetch, workspacePluginsDir: deps.workspacePluginsDir },
    );
  } catch (err) {
    if (err instanceof PluginInspectNotFoundError) {
      throw new PluginNotInstalledError(name, pluginTarget(name, deps));
    }
    throw err;
  }

  switch (inspection.status) {
    case "not-installed":
      throw new PluginNotInstalledError(name, pluginTarget(name, deps));
    case "not-in-marketplace": {
      // The marketplace doesn't claim this name, but a plugin installed directly
      // from a GitHub URL (untrusted) still has a recorded source to advance:
      // upgrade it by re-fetching whatever its recorded ref now resolves to.
      const local = inspection.local;
      if (!local) {
        throw new PluginNotUpgradableError(
          name,
          "it has no marketplace entry and no installed copy to upgrade",
        );
      }
      return directUpgrade({ name, local, dryRun, strategy }, deps);
    }
    case "remote-unavailable":
      // A transient catalog outage is not a permanent "cannot upgrade" state:
      // the same request can succeed once the marketplace source recovers, so
      // surface it as a retryable source-unavailable error rather than a
      // conflict.
      throw new PluginSourceUnavailableError(
        `Plugin "${name}" cannot be upgraded: the marketplace could not be reached (${inspection.remoteError ?? "unknown error"}).`,
        503,
      );
  }

  // The remaining statuses (up-to-date, update-available, unknown-provenance)
  // all imply an installed copy and a resolvable marketplace pin.
  const { local, remote } = inspection;
  if (!local || !remote) {
    throw new PluginNotUpgradableError(
      name,
      "its install or marketplace metadata could not be resolved",
    );
  }

  const fromCommit = local.commit;
  const fromTimestamp = local.committedAt;
  const toCommit = remote.commit;
  const toTimestamp = remote.committedAt;
  const provenanceWasUnknown = inspection.status === "unknown-provenance";

  if (inspection.status === "up-to-date") {
    return {
      name,
      outcome: "already-up-to-date",
      fromCommit,
      fromTimestamp,
      toCommit,
      toTimestamp,
      target: local.target,
      fileCount: null,
      dryRun,
      strategy,
      conflicts: [],
      binaryConflicts: [],
      provenanceWasUnknown: false,
    };
  }

  if (dryRun) {
    return {
      name,
      outcome: "would-upgrade",
      fromCommit,
      fromTimestamp,
      toCommit,
      toTimestamp,
      target: local.target,
      fileCount: null,
      dryRun: true,
      strategy,
      conflicts: [],
      binaryConflicts: [],
      provenanceWasUnknown,
    };
  }

  // `ours`/`theirs`/`assistant` carry local edits forward via a three-way
  // merge; the default `overwrite` discards them and re-installs the pin
  // wholesale.
  if (
    strategy === "ours" ||
    strategy === "theirs" ||
    strategy === "assistant"
  ) {
    const [remoteOwner, remoteRepo] = remote.repo.split("/");
    return mergeUpgrade(
      {
        name,
        strategy,
        local,
        fromCommit,
        fromTimestamp,
        toCommit,
        toTimestamp,
        provenanceWasUnknown,
        theirsSource: {
          owner: remoteOwner ?? "",
          repo: remoteRepo ?? "",
          rootPath: remote.path,
          ref: remote.commit,
        },
        // The install baseline re-materializes with the curated adapter overlay
        // (canonical ref); the target reads its overlay at the marketplace ref
        // the pin was advertised from.
        baseStubRef: DEFAULT_PLUGIN_REF,
        theirsStubRef: remote.marketplaceRef,
      },
      deps,
    );
  }

  const result = await installPlugin(
    { name, force: true },
    {
      fetch: deps.fetch,
      workspacePluginsDir: deps.workspacePluginsDir,
      runGit: deps.runGit,
      runPostinstall: deps.runPostinstall,
    },
  );

  return {
    name,
    outcome: "upgraded",
    fromCommit,
    fromTimestamp,
    toCommit: result.commit ?? toCommit,
    toTimestamp: result.committedAt ?? toTimestamp,
    target: result.target,
    fileCount: result.fileCount,
    dryRun: false,
    strategy,
    conflicts: [],
    binaryConflicts: [],
    provenanceWasUnknown,
  };
}

/**
 * Upgrade a plugin the marketplace does not claim by re-fetching its recorded
 * GitHub source — the untrusted-direct-install analogue of the marketplace
 * upgrade above.
 *
 * A direct install (`plugins install <github-url>`) records the exact
 * owner/repo/path/ref it was cloned from in its `install-meta.json`. Its
 * "latest" is whatever that ref currently resolves to, so the upgrade target is
 * {@link resolveRefCommit} of the recorded ref — a pinned full SHA is immutable
 * (nothing to advance to), while a branch / tag / `HEAD` moves as upstream does.
 * The move is then materialized verbatim, with no curated adapter overlay,
 * exactly as the original untrusted install was.
 *
 * Throws {@link PluginNotUpgradableError} when no resolvable GitHub source was
 * recorded (a manually-copied install), {@link PluginNotFoundError} when the
 * recorded ref has vanished from the remote, {@link PluginMergeBaselineError}
 * when a merge strategy's install-time baseline cannot be reconstructed, and
 * {@link PluginSourceUnavailableError} on a transient source outage.
 */
async function directUpgrade(
  ctx: {
    readonly name: string;
    readonly local: PluginLocalInfo;
    readonly dryRun: boolean;
    readonly strategy: PluginUpgradeStrategy;
  },
  deps: UpgradePluginDeps,
): Promise<PluginUpgradeResult> {
  const { name, local, dryRun, strategy } = ctx;
  const source = local.source;
  // Without resolvable GitHub coordinates in the provenance sidecar (a
  // manually-copied install, or a sidecar naming a non-github source) there is
  // nothing to re-fetch.
  if (!source || source.kind !== "github" || !source.owner || !source.repo) {
    throw new PluginNotUpgradableError(
      name,
      "it has no marketplace entry and no recorded GitHub source to re-fetch from",
    );
  }
  const fetchSource: PluginFetchSource = {
    owner: source.owner,
    repo: source.repo,
    rootPath: source.path ?? "",
    ref: source.ref,
  };

  const fromCommit = local.commit;
  const fromTimestamp = local.committedAt;
  const provenanceWasUnknown = fromCommit === null;

  // Resolve what the recorded ref points at now, without cloning. A pinned
  // full-SHA ref is immutable, so it resolves to itself — nothing to advance to.
  const toCommit = await resolveRefCommit(fetchSource, deps.runGit);
  if (toCommit === null) {
    // The recorded ref is gone from the remote (deleted branch / tag) or the
    // repo is unreachable as a hard failure — there is no revision to move to.
    throw new PluginNotFoundError(
      name,
      fetchSource.ref,
      `${fetchSource.owner}/${fetchSource.repo}`,
    );
  }

  if (
    fromCommit !== null &&
    toCommit.toLowerCase() === fromCommit.toLowerCase()
  ) {
    return {
      name,
      outcome: "already-up-to-date",
      fromCommit,
      fromTimestamp,
      toCommit,
      // The ref still points at the installed commit, so the "to" version is the
      // "from" version — reuse its recorded timestamp rather than a fresh fetch.
      toTimestamp: fromTimestamp,
      target: local.target,
      fileCount: null,
      dryRun,
      strategy,
      conflicts: [],
      binaryConflicts: [],
      provenanceWasUnknown: false,
    };
  }

  if (dryRun) {
    // Preview: resolve the target commit's date the same way `plugins inspect`
    // does, so the dry run shows the human-readable version it would move to.
    const toTimestamp = await fetchCommitDate(
      `${fetchSource.owner}/${fetchSource.repo}`,
      toCommit,
      deps.fetch,
    );
    return {
      name,
      outcome: "would-upgrade",
      fromCommit,
      fromTimestamp,
      toCommit,
      toTimestamp,
      target: local.target,
      fileCount: null,
      dryRun: true,
      strategy,
      conflicts: [],
      binaryConflicts: [],
      provenanceWasUnknown,
    };
  }

  if (
    strategy === "ours" ||
    strategy === "theirs" ||
    strategy === "assistant"
  ) {
    // A direct install carries no curated adapter overlay, so both the install
    // baseline and the incoming revision re-materialize verbatim (`stubRef`
    // null), pinned to the recorded install commit and the resolved target.
    return mergeUpgrade(
      {
        name,
        strategy,
        local,
        fromCommit,
        fromTimestamp,
        toCommit,
        toTimestamp: null,
        provenanceWasUnknown,
        theirsSource: { ...fetchSource, ref: toCommit },
        baseStubRef: null,
        theirsStubRef: null,
      },
      deps,
    );
  }

  // overwrite (default): re-install the recorded direct source verbatim, moving
  // to whatever its ref now resolves to. Untrusted — no curated adapter overlay,
  // just as the original direct install was materialized.
  const result = await installPlugin(
    { name, force: true, directSource: fetchSource },
    {
      fetch: deps.fetch,
      workspacePluginsDir: deps.workspacePluginsDir,
      runGit: deps.runGit,
      runPostinstall: deps.runPostinstall,
    },
  );

  return {
    name,
    outcome: "upgraded",
    fromCommit,
    fromTimestamp,
    toCommit: result.commit ?? toCommit,
    toTimestamp: result.committedAt,
    target: result.target,
    fileCount: result.fileCount,
    dryRun: false,
    strategy,
    conflicts: [],
    binaryConflicts: [],
    provenanceWasUnknown,
  };
}

/**
 * Carry local edits forward by three-way merging the on-disk install (`ours`)
 * and the incoming revision (`theirs`) against the re-materialized install commit
 * (`base`), then atomically swapping the merged tree into place pinned at the
 * new commit. Conflicting hunks resolve toward `ours` or `theirs` per the
 * strategy, or are left as git conflict markers under `assistant`;
 * non-conflicting edits from both sides survive.
 */
async function mergeUpgrade(
  ctx: {
    readonly name: string;
    readonly strategy: "ours" | "theirs" | "assistant";
    readonly local: PluginLocalInfo;
    readonly fromCommit: string | null;
    readonly fromTimestamp: string | null;
    readonly toCommit: string;
    readonly toTimestamp: string | null;
    readonly provenanceWasUnknown: boolean;
    /** Coordinates of the revision being merged in (`theirs`), pinned to {@link ctx.toCommit}. */
    readonly theirsSource: PluginFetchSource;
    /**
     * Curated-adapter-stub ref overlaid when re-materializing the install
     * baseline, or `null` for a direct (untrusted) install that carries no
     * curated overlay.
     */
    readonly baseStubRef: string | null;
    /** Curated-adapter-stub ref overlaid on the incoming revision, or `null` for a direct install. */
    readonly theirsStubRef: string | null;
  },
  deps: UpgradePluginDeps,
): Promise<PluginUpgradeResult> {
  const { name, strategy, local, theirsSource } = ctx;

  // Marker labels name each side by its commit so the assistant can tell the
  // local edit from the incoming pin when resolving.
  const shortSha = (sha: string | null): string =>
    sha ? sha.slice(0, 7) : "unknown";
  const conflictLabels: ConflictLabels = {
    ours: `local edits (was ${shortSha(ctx.fromCommit)})`,
    base: `install baseline ${shortSha(ctx.fromCommit)}`,
    theirs: `upgrade pin ${shortSha(ctx.toCommit)}`,
  };

  const meta = readInstallMeta(local.target);
  if (!meta || !meta.commit || !meta.fingerprint) {
    throw new PluginMergeBaselineError(
      name,
      "no install commit or fingerprint was recorded (an older or manually-copied install)",
    );
  }
  const recorded = meta.fingerprint;

  const baseSource: PluginFetchSource = {
    owner: meta.source.owner,
    repo: meta.source.repo,
    rootPath: meta.source.path ?? "",
    ref: meta.commit,
  };

  const pluginsDir = deps.workspacePluginsDir ?? getWorkspacePluginsDir();
  const baseDir = mkdtempSync(join(tmpdir(), `plugin-upgrade-base-${name}-`));
  const theirsDir = mkdtempSync(
    join(tmpdir(), `plugin-upgrade-theirs-${name}-`),
  );
  // Stage outside the served `plugins/` directory and on its filesystem so the
  // final swap is an atomic rename, mirroring `installPlugin`.
  const stagingRoot = join(dirname(pluginsDir), ".plugins-staging");
  mkdirSync(stagingRoot, { recursive: true });
  const stagingDir = join(stagingRoot, `${name}.upgrading.${process.pid}`);
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  mkdirSync(stagingDir, { recursive: true });

  try {
    const base = await materializePluginTree(
      {
        source: baseSource,
        name,
        stubRef: ctx.baseStubRef,
        destDir: baseDir,
      },
      deps,
    );
    if (base.fileCount === 0) {
      throw new PluginNotFoundError(
        name,
        baseSource.ref,
        `${baseSource.owner}/${baseSource.repo}`,
      );
    }
    // The merge base must faithfully reproduce what install materialized;
    // otherwise a curated adapter overlay that moved since install would read
    // as base→ours/theirs edits and corrupt the merge. Verify against the
    // recorded fingerprint, exactly as `plugins diff` does.
    const baseFingerprint = computeFingerprint(baseDir, PRESERVED_ENTRIES);
    if (!fingerprintsEqual(baseFingerprint, recorded)) {
      throw new PluginMergeBaselineError(
        name,
        "the install-time baseline could not be faithfully reconstructed (a curated adapter overlay it was built from has changed since install)",
      );
    }

    const theirs = await materializePluginTree(
      {
        source: theirsSource,
        name,
        stubRef: ctx.theirsStubRef,
        destDir: theirsDir,
      },
      deps,
    );
    if (theirs.fileCount === 0) {
      throw new PluginNotFoundError(
        name,
        theirsSource.ref,
        `${theirsSource.owner}/${theirsSource.repo}`,
      );
    }

    const merge = await mergePluginTree({
      baseDir,
      oursDir: local.target,
      theirsDir,
      destDir: stagingDir,
      strategy,
      conflictLabels,
    });

    const toCommit = theirs.commit ?? ctx.toCommit;
    const toTimestamp = theirs.committedAt ?? ctx.toTimestamp;
    finalizeStagedInstall(stagingDir, {
      name,
      source: theirsSource,
      ref: theirsSource.ref,
      commit: toCommit,
      committedAt: toTimestamp,
      pluginsDir,
    });

    return {
      name,
      outcome: "upgraded",
      fromCommit: ctx.fromCommit,
      fromTimestamp: ctx.fromTimestamp,
      toCommit,
      toTimestamp,
      target: join(pluginsDir, name),
      fileCount: merge.fileCount,
      dryRun: false,
      strategy,
      conflicts: merge.conflicts,
      binaryConflicts: merge.binaryConflicts,
      provenanceWasUnknown: ctx.provenanceWasUnknown,
    };
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(theirsDir, { recursive: true, force: true });
  }
}
