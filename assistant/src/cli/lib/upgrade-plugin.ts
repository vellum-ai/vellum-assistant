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
 * Mechanically the move is a forced re-install at the current pin, which the
 * underlying {@link ./install-from-github.installPlugin} performs atomically —
 * the previously installed copy is preserved until the fetch succeeds.
 *
 * Conflict resolution for locally-modified plugins is intentionally out of
 * scope here: this overwrites the install with the pinned tree. A future
 * iteration will detect local edits (installed SHA = merge base) and resolve
 * them before the swap.
 *
 * Designed for direct programmatic use with injected dependencies, mirroring
 * the sibling plugin libraries. The CLI command `assistant plugins upgrade
 * <name>` is a thin wrapper that supplies production deps and formats the
 * result.
 */

import { join } from "node:path";

import { getWorkspacePluginsDir } from "../../util/platform.js";
import {
  inspectPlugin,
  type PluginInspection,
  PluginInspectNotFoundError,
} from "./inspect-plugin.js";
import {
  type FetchLike,
  type GitRunner,
  installPlugin,
  type PostinstallRunner,
  sanitizePluginName,
} from "./install-from-github.js";
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
  /** Marketplace-pinned commit the install was (or would be) moved to. */
  readonly toCommit: string;
  /** Absolute path to the installed plugin directory. */
  readonly target: string;
  /** Files materialized by the upgrade; `null` for a no-op or dry run. */
  readonly fileCount: number | null;
  /** Whether this was a dry run (no changes made). */
  readonly dryRun: boolean;
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

function pluginTarget(name: string, deps: UpgradePluginDeps): string {
  const dir = deps.workspacePluginsDir ?? getWorkspacePluginsDir();
  return join(dir, name);
}

/**
 * Move an installed plugin to the marketplace's current pin.
 *
 * Throws {@link PluginNotInstalledError} when no copy is installed,
 * {@link PluginNotUpgradableError} when the install has no marketplace pin to
 * advance to (no catalog entry, or the catalog was unreachable), and
 * propagates {@link installPlugin}'s errors (e.g. source unavailable,
 * postinstall failure) when the re-install itself fails.
 */
export async function upgradePlugin(
  opts: UpgradePluginOptions,
  deps: UpgradePluginDeps,
): Promise<PluginUpgradeResult> {
  const name = sanitizePluginName(opts.name);
  const dryRun = opts.dryRun ?? false;

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
      throw new PluginNotUpgradableError(
        name,
        `the marketplace could not be reached (${inspection.remoteError ?? "unknown error"})`,
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
  const toCommit = remote.commit;
  const provenanceWasUnknown = inspection.status === "unknown-provenance";

  if (inspection.status === "up-to-date") {
    return {
      name,
      outcome: "already-up-to-date",
      fromCommit,
      toCommit,
      target: local.target,
      fileCount: null,
      dryRun,
      provenanceWasUnknown: false,
    };
  }

  if (dryRun) {
    return {
      name,
      outcome: "would-upgrade",
      fromCommit,
      toCommit,
      target: local.target,
      fileCount: null,
      dryRun: true,
      provenanceWasUnknown,
    };
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
    toCommit: result.commit ?? toCommit,
    target: result.target,
    fileCount: result.fileCount,
    dryRun: false,
    provenanceWasUnknown,
  };
}
