/**
 * Upgrade a single installed plugin to the marketplace's current pin.
 *
 * The marketplace pins every plugin to a full, immutable commit SHA (see
 * {@link ./plugin-marketplace}); an upgrade re-materializes the install at
 * whatever SHA the catalog currently advertises. Drift is detected with the
 * same exact commit-SHA comparison {@link ./inspect-plugin} uses, so an
 * upgrade is a no-op when the installed copy already matches the pin.
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
 * `ours`/`theirs` instead three-way merge the on-disk tree and the pin against
 * the re-materialized install commit so non-conflicting local edits survive,
 * resolving conflicting hunks toward the local edit or the pin respectively.
 * `assistant` is reserved for assistant-driven conflict resolution and is not
 * yet implemented.
 *
 * Designed for direct programmatic use with injected dependencies, mirroring
 * the sibling plugin libraries. The CLI command `assistant plugins upgrade
 * <name>` is a thin wrapper that supplies production deps and formats the
 * result.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getWorkspacePluginsDir } from "../../util/platform.js";
import {
  inspectPlugin,
  type PluginInspection,
  PluginInspectNotFoundError,
  type PluginLocalInfo,
  type PluginRemoteInfo,
} from "./inspect-plugin.js";
import {
  DEFAULT_PLUGIN_REF,
  type FetchLike,
  finalizeStagedInstall,
  type GitRunner,
  INSTALL_META_FILENAME,
  installPlugin,
  materializePluginTree,
  type PluginFetchSource,
  PluginNotFoundError,
  PluginSourceUnavailableError,
  type PostinstallRunner,
  readInstallMeta,
  sanitizePluginName,
} from "./install-from-github.js";
import { mergePluginTree } from "./merge-plugin-tree.js";
import { computeFingerprint, fingerprintsEqual } from "./plugin-fingerprint.js";
import { PluginNotInstalledError } from "./uninstall-plugin.js";

/**
 * How local edits to an installed plugin are reconciled with the marketplace
 * pin during an upgrade.
 *
 * - `overwrite` (default) — discard all local edits and re-install the pin
 *   wholesale. Matches the historical upgrade behavior.
 * - `ours` — three-way merge; conflicting hunks resolve toward the local edit.
 * - `theirs` — three-way merge; conflicting hunks resolve toward the pin.
 * - `assistant` — hand conflicts to the assistant to resolve (not yet
 *   implemented).
 */
export type PluginUpgradeStrategy =
  | "ours"
  | "theirs"
  | "overwrite"
  | "assistant";

/** The set of accepted `--strategy` values, for validation and help text. */
export const PLUGIN_UPGRADE_STRATEGIES: readonly PluginUpgradeStrategy[] = [
  "ours",
  "theirs",
  "overwrite",
  "assistant",
];

/** The strategy applied when a caller omits `--strategy`. */
export const DEFAULT_PLUGIN_UPGRADE_STRATEGY: PluginUpgradeStrategy =
  "overwrite";

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

/** A requested merge strategy is recognized but not yet implemented. */
export class PluginUpgradeStrategyUnsupportedError extends Error {
  constructor(readonly strategy: PluginUpgradeStrategy) {
    super(
      `Upgrade strategy "${strategy}" is not yet supported. Use one of: ours, theirs, overwrite.`,
    );
    this.name = "PluginUpgradeStrategyUnsupportedError";
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
 * Move an installed plugin to the marketplace's current pin.
 *
 * The `strategy` controls how local edits are reconciled with the pin:
 * `overwrite` (default) re-installs the pin wholesale; `ours`/`theirs` do a
 * three-way merge that carries non-conflicting local edits forward, resolving
 * conflicting hunks toward the local edit or the pin respectively; `assistant`
 * is not yet implemented.
 *
 * Throws {@link PluginNotInstalledError} when no copy is installed,
 * {@link PluginNotUpgradableError} when the install has no marketplace entry to
 * advance to, {@link PluginUpgradeStrategyUnsupportedError} for the `assistant`
 * strategy, {@link PluginMergeBaselineError} when a merge strategy is requested
 * but the install-time baseline cannot be reconstructed,
 * {@link PluginSourceUnavailableError} when the marketplace catalog is
 * temporarily unreachable (a retryable outage, distinct from the permanent
 * no-entry case), and propagates {@link installPlugin}'s errors (e.g. source
 * unavailable, postinstall failure) when the re-install itself fails.
 */
export async function upgradePlugin(
  opts: UpgradePluginOptions,
  deps: UpgradePluginDeps,
): Promise<PluginUpgradeResult> {
  const name = sanitizePluginName(opts.name);
  const dryRun = opts.dryRun ?? false;
  const strategy = opts.strategy ?? DEFAULT_PLUGIN_UPGRADE_STRATEGY;

  if (strategy === "assistant") {
    throw new PluginUpgradeStrategyUnsupportedError(strategy);
  }

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
    case "not-in-marketplace":
      throw new PluginNotUpgradableError(
        name,
        "it has no marketplace entry to upgrade from",
      );
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
      provenanceWasUnknown,
    };
  }

  // `ours`/`theirs` carry local edits forward via a three-way merge; the
  // default `overwrite` discards them and re-installs the pin wholesale.
  if (strategy === "ours" || strategy === "theirs") {
    return mergeUpgrade(
      {
        name,
        strategy,
        local,
        remote,
        fromCommit,
        fromTimestamp,
        provenanceWasUnknown,
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
    provenanceWasUnknown,
  };
}

/**
 * Carry local edits forward by three-way merging the on-disk install (`ours`)
 * and the marketplace pin (`theirs`) against the re-materialized install commit
 * (`base`), then atomically swapping the merged tree into place pinned at the
 * new commit. Conflicting hunks resolve toward `ours` or `theirs` per the
 * strategy; non-conflicting edits from both sides survive.
 */
async function mergeUpgrade(
  ctx: {
    readonly name: string;
    readonly strategy: "ours" | "theirs";
    readonly local: PluginLocalInfo;
    readonly remote: PluginRemoteInfo;
    readonly fromCommit: string | null;
    readonly fromTimestamp: string | null;
    readonly provenanceWasUnknown: boolean;
  },
  deps: UpgradePluginDeps,
): Promise<PluginUpgradeResult> {
  const { name, strategy, local, remote } = ctx;

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
  const [remoteOwner, remoteRepo] = remote.repo.split("/");
  const theirsSource: PluginFetchSource = {
    owner: remoteOwner ?? "",
    repo: remoteRepo ?? "",
    rootPath: remote.path,
    ref: remote.commit,
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
        stubRef: DEFAULT_PLUGIN_REF,
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
    const baseFingerprint = computeFingerprint(baseDir, [
      INSTALL_META_FILENAME,
    ]);
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
        stubRef: remote.marketplaceRef,
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

    const fileCount = await mergePluginTree({
      baseDir,
      oursDir: local.target,
      theirsDir,
      destDir: stagingDir,
      strategy,
    });

    const toCommit = theirs.commit ?? remote.commit;
    const toTimestamp = theirs.committedAt ?? remote.committedAt;
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
      fileCount,
      dryRun: false,
      strategy,
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
