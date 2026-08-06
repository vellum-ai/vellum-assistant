/**
 * Unattended plugin upgrades, driven from the resource monitor process.
 *
 * A workspace opts in with `pluginUpdates.mode: "auto"`; the default,
 * `"manual"`, keeps the pre-existing behavior where a plugin only ever moves
 * when a human runs `assistant plugins upgrade`. When opted in, this sweep
 * walks every installed, enabled plugin once per `pluginUpdates.checkIntervalMs`
 * (default hourly) and moves each one to its source's current revision using
 * the configured merge strategy (default `theirs`).
 *
 * The monitor drives it — not the daemon — for the same reason it drives the
 * plugin source watch and crash recovery: the work is periodic, network-bound,
 * and must not compete with the daemon's turn loop. But the monitor does *not*
 * perform the upgrade itself. It asks the daemon to, over the CLI IPC socket
 * (`plugins_upgrade`), because the upgrade has in-process lifecycle: the old
 * version's `shutdown` must run at the swap boundary and the new version's
 * `init` must run right after, both inside the process that loaded the plugin.
 * A monitor-local upgrade would swap files under a daemon that never tore the
 * old version down. When the daemon is unreachable nothing is attempted and
 * the sweep stays due, so it retries on the next poll rather than skipping the
 * window.
 *
 * The last completed sweep is stamped in the monitoring data dir, so a daemon
 * that restarts every few minutes still upgrades at most once per interval
 * instead of re-sweeping (and re-cloning) on every boot.
 */

import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listInstalledPlugins } from "../cli/lib/list-installed-plugins.js";
import { getConfigReadOnly } from "../config/loader.js";
import type { PluginUpdatesConfig } from "../config/schemas/plugin-updates.js";
import { cliIpcCall } from "../ipc/cli-client.js";
import { isPluginDisabled } from "../plugins/disabled-state.js";
import { getLogger } from "../util/logger.js";
import { getMonitoringDataDir } from "../util/platform.js";

const log = getLogger("plugin-auto-update");

/** IPC method backing `POST /v1/plugins/:name/upgrade` on the daemon. */
const UPGRADE_IPC_METHOD = "plugins_upgrade";

/**
 * Per-plugin ceiling for the daemon call. An upgrade clones the source, may
 * install dependencies, and runs the plugin's `shutdown`/`init` hooks, so it
 * is far slower than the IPC client's default 60s — but it must still be
 * bounded, or one wedged upgrade stalls every later plugin in the sweep.
 */
const UPGRADE_TIMEOUT_MS = 5 * 60 * 1000;

/** How often the loop re-tests whether a sweep is due. */
const DUE_POLL_INTERVAL_MS = 60_000;

/**
 * Delay before the first due-check. The monitor starts alongside the daemon,
 * which is still migrating and loading plugins; there is nothing to upgrade
 * into until it is up.
 */
const BOOT_DELAY_MS = 60_000;

const STAMP_FILENAME = "plugin-auto-update-last-run-at";

/** Outcome the daemon reports for one plugin; mirrors `PluginUpgradeResult`. */
interface UpgradeCallResult {
  readonly outcome?: string;
  readonly fromCommit?: string | null;
  readonly toCommit?: string;
}

/** Injectable seams. Production callers take every default. */
export interface PluginAutoUpdateDeps {
  /** Effective `pluginUpdates` block. Re-read each pass so a config edit takes effect without a restart. */
  readonly readConfig: () => PluginUpdatesConfig;
  /** Names of installed plugins eligible for an unattended upgrade. */
  readonly listUpgradableNames: () => string[];
  /** Ask the daemon to upgrade one plugin. */
  readonly requestUpgrade: (
    name: string,
    strategy: PluginUpdatesConfig["strategy"],
  ) => Promise<{
    readonly ok: boolean;
    readonly result?: UpgradeCallResult;
    readonly error?: string;
    /** Absent when the call never reached the daemon (transport failure). */
    readonly statusCode?: number;
  }>;
  /** Epoch millis of the last completed sweep, or null when never swept. */
  readonly readLastRunAt: () => number | null;
  /** Stamp a completed sweep. */
  readonly writeLastRunAt: () => void;
  readonly now: () => number;
}

function stampPath(): string {
  return join(getMonitoringDataDir(), STAMP_FILENAME);
}

/**
 * Installed plugins the sweep may move: user-installed (defaults ship with the
 * assistant and have no upstream to advance to) and not disabled. A disabled
 * plugin is deliberately left alone — the user switched it off, and upgrading
 * it would re-materialize code and re-declare schedules for something that
 * isn't running.
 */
function defaultListUpgradableNames(): string[] {
  return listInstalledPlugins()
    .map((plugin) => plugin.name)
    .filter((name) => !isPluginDisabled(name));
}

async function defaultRequestUpgrade(
  name: string,
  strategy: PluginUpdatesConfig["strategy"],
): Promise<{
  ok: boolean;
  result?: UpgradeCallResult;
  error?: string;
  statusCode?: number;
}> {
  return cliIpcCall<UpgradeCallResult>(
    UPGRADE_IPC_METHOD,
    // The target revision is never caller-supplied — the daemon resolves it
    // from the plugin's own source, exactly as an interactive upgrade does.
    { pathParams: { name }, body: { strategy } },
    { timeoutMs: UPGRADE_TIMEOUT_MS },
  );
}

const PRODUCTION_DEPS: PluginAutoUpdateDeps = {
  // `getConfigReadOnly` never creates directories or writes config.json —
  // the monitor must not repair the daemon's config file behind its back.
  readConfig: () => getConfigReadOnly().pluginUpdates,
  listUpgradableNames: defaultListUpgradableNames,
  requestUpgrade: defaultRequestUpgrade,
  readLastRunAt: () => {
    try {
      return statSync(stampPath()).mtimeMs;
    } catch {
      return null; // never swept, or an unreadable stamp — treat as due
    }
  },
  writeLastRunAt: () => {
    try {
      writeFileSync(stampPath(), "");
    } catch (err) {
      log.warn({ err }, "Could not stamp the plugin auto-update sweep");
    }
  },
  now: () => Date.now(),
};

/** What one pass did, for logging and tests. */
export interface PluginAutoUpdatePassResult {
  /** Why the pass did no work, or `null` when a sweep ran. */
  readonly skipped:
    | "manual"
    | "not-due"
    | "no-plugins"
    | "config-unreadable"
    | null;
  readonly upgraded: readonly string[];
  readonly unchanged: readonly string[];
  readonly failed: readonly string[];
  /** True when the daemon could not be reached, so the sweep stays due. */
  readonly daemonUnreachable: boolean;
}

const NOTHING: Omit<PluginAutoUpdatePassResult, "skipped"> = {
  upgraded: [],
  unchanged: [],
  failed: [],
  daemonUnreachable: false,
};

/**
 * Run one sweep if the workspace is opted in and the interval has elapsed.
 *
 * Never throws: a plugin whose upgrade fails (source unreachable, no upstream
 * to advance to, an unreconstructable merge baseline) is logged and skipped so
 * one bad plugin cannot block the rest, and the sweep is stamped regardless —
 * a failure retries on the next interval, not on the next minute.
 */
export async function runPluginAutoUpdatePassIfDue(
  deps: PluginAutoUpdateDeps = PRODUCTION_DEPS,
): Promise<PluginAutoUpdatePassResult> {
  let config: PluginUpdatesConfig;
  try {
    config = deps.readConfig();
  } catch (err) {
    // A config that cannot be read is not an invitation to upgrade anything.
    log.warn({ err }, "Plugin auto-update could not read config — skipping");
    return { skipped: "config-unreadable", ...NOTHING };
  }
  if (config.mode !== "auto") {
    return { skipped: "manual", ...NOTHING };
  }

  const lastRunAt = deps.readLastRunAt();
  if (lastRunAt !== null && deps.now() - lastRunAt < config.checkIntervalMs) {
    return { skipped: "not-due", ...NOTHING };
  }

  let names: string[];
  try {
    names = deps.listUpgradableNames();
  } catch (err) {
    log.warn({ err }, "Plugin auto-update could not list installed plugins");
    return { skipped: "no-plugins", ...NOTHING };
  }
  if (names.length === 0) {
    // Stamp anyway: an empty workspace is a completed sweep, and re-listing an
    // empty directory every minute is pointless.
    deps.writeLastRunAt();
    return { skipped: "no-plugins", ...NOTHING };
  }

  const upgraded: string[] = [];
  const unchanged: string[] = [];
  const failed: string[] = [];
  let daemonUnreachable = false;

  // Sequential on purpose: each upgrade clones a repository and may install
  // dependencies, and the daemon runs the swapped plugin's lifecycle hooks.
  // Running them one at a time keeps the monitor's network and the daemon's
  // event loop from being flooded by a workspace with many plugins.
  for (const name of names) {
    let call: Awaited<ReturnType<PluginAutoUpdateDeps["requestUpgrade"]>>;
    try {
      call = await deps.requestUpgrade(name, config.strategy);
    } catch (err) {
      failed.push(name);
      log.warn({ err, name }, "Plugin auto-update call failed");
      continue;
    }
    if (call.ok) {
      const outcome = call.result?.outcome;
      if (outcome === "upgraded") {
        upgraded.push(name);
        log.info(
          {
            name,
            strategy: config.strategy,
            from: call.result?.fromCommit,
            to: call.result?.toCommit,
          },
          "Plugin auto-upgraded",
        );
      } else {
        unchanged.push(name);
      }
      continue;
    }
    if (call.statusCode === undefined) {
      // Transport failure: the daemon is down, restarting, or still gated on
      // migrations. Nothing after this would fare better, so abandon the
      // sweep without stamping and retry on the next poll.
      daemonUnreachable = true;
      log.debug(
        { name, error: call.error },
        "Plugin auto-update could not reach the daemon — staying due",
      );
      break;
    }
    failed.push(name);
    log.warn(
      { name, statusCode: call.statusCode, error: call.error },
      "Plugin auto-upgrade was refused",
    );
  }

  if (!daemonUnreachable) {
    deps.writeLastRunAt();
    log.info(
      {
        upgraded: upgraded.length,
        unchanged: unchanged.length,
        failed: failed.length,
        strategy: config.strategy,
      },
      "Plugin auto-update sweep complete",
    );
  }

  return { skipped: null, upgraded, unchanged, failed, daemonUnreachable };
}

/** Handle for the running auto-update loop. */
export interface PluginAutoUpdateHandle {
  stop(): void;
}

let inFlight = false;

/**
 * Guarded pass: a sweep can outlive the poll interval (each plugin gets up to
 * {@link UPGRADE_TIMEOUT_MS}), and two concurrent sweeps would ask the daemon
 * to upgrade the same plugin twice.
 */
async function tick(): Promise<void> {
  if (inFlight) {
    return;
  }
  inFlight = true;
  try {
    await runPluginAutoUpdatePassIfDue();
  } catch (err) {
    log.warn({ err }, "Plugin auto-update pass failed (non-fatal)");
  } finally {
    inFlight = false;
  }
}

/**
 * Start the auto-update loop in the monitor process.
 *
 * The timer runs regardless of the current mode — it is the pass that reads
 * `pluginUpdates.mode`, so switching a workspace to `auto` takes effect within
 * one poll instead of at the next daemon restart. Timers are unref'd so the
 * loop never keeps the process alive.
 */
export function startPluginAutoUpdate(): PluginAutoUpdateHandle {
  const bootTimer = setTimeout(() => void tick(), BOOT_DELAY_MS);
  bootTimer.unref?.();
  const pollTimer = setInterval(() => void tick(), DUE_POLL_INTERVAL_MS);
  pollTimer.unref?.();
  return {
    stop() {
      clearTimeout(bootTimer);
      clearInterval(pollTimer);
    },
  };
}
