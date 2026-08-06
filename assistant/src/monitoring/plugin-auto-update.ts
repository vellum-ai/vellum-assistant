/**
 * Unattended plugin upgrades, driven from the resource monitor process.
 *
 * A workspace opts in with `pluginUpdates.mode: "auto"`; the default,
 * `"manual"`, keeps the pre-existing behavior where a plugin only ever moves
 * when a human runs `assistant plugins upgrade`. When opted in, this sweep
 * walks every installed, enabled plugin once per `pluginUpdates.checkIntervalMs`
 * (default hourly), inspects which ones can actually move, and upgrades those
 * with the configured merge strategy (default `theirs`).
 *
 * The monitor drives it — not the daemon — for the same reason it drives the
 * plugin source watch and crash recovery: the work is periodic, network-bound,
 * and must not compete with the daemon's turn loop. Drift detection happens
 * here too (`inspectPlugin` reads the catalog; no clone), so a workspace whose
 * plugins are all current costs the daemon nothing. But the monitor does *not*
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
 * instead of re-cloning on every boot.
 */

import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { inspectPlugin } from "../cli/lib/inspect-plugin.js";
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
 * bounded, or one wedged upgrade stalls the sweep forever.
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

/**
 * Inspection verdicts worth asking the daemon about.
 *
 * `update-available` is the obvious one. `unknown-provenance` (an older or
 * manually-copied install with no recorded commit) is included because an
 * upgrade re-pins it, which is how it stops being unknown. So is
 * `not-in-marketplace`: a plugin installed straight from a GitHub URL has no
 * catalog entry to compare against, but it still tracks a ref upstream may
 * have moved — only the daemon's upgrade can resolve that, and it no-ops when
 * the ref still points at the installed commit.
 *
 * Everything else is skipped: `up-to-date` has nowhere to move, and
 * `remote-unavailable` means the catalog could not be read, so an upgrade
 * would fail on the same outage a moment later.
 */
const UPGRADABLE_STATUSES: ReadonlySet<string> = new Set([
  "update-available",
  "unknown-provenance",
  "not-in-marketplace",
]);

/** Outcome the daemon reports for one plugin; mirrors `PluginUpgradeResult`. */
interface UpgradeCallResult {
  readonly outcome?: string;
  readonly fromCommit?: string | null;
  readonly toCommit?: string;
}

function stampPath(): string {
  return join(getMonitoringDataDir(), STAMP_FILENAME);
}

/** Epoch millis of the last completed sweep, or `null` when never swept. */
function lastSweepAt(): number | null {
  try {
    return statSync(stampPath()).mtimeMs;
  } catch {
    return null; // never swept, or an unreadable stamp — treat as due
  }
}

function stampSweep(): void {
  try {
    writeFileSync(stampPath(), "");
  } catch (err) {
    log.warn({ err }, "Could not stamp the plugin auto-update sweep");
  }
}

/**
 * Installed plugins this sweep should ask the daemon to upgrade.
 *
 * Only user-installed plugins are listed (defaults ship with the assistant and
 * have no upstream to advance to). A disabled plugin is deliberately left
 * alone — the user switched it off, and upgrading it would re-materialize code
 * and re-declare schedules for something that isn't running. What survives
 * that is inspected, so the daemon is only asked about plugins that can
 * actually move (see {@link UPGRADABLE_STATUSES}).
 */
async function listUpgradableNames(): Promise<string[]> {
  const installed = listInstalledPlugins()
    .map((plugin) => plugin.name)
    .filter((name) => !isPluginDisabled(name));

  const candidates: string[] = [];
  for (const name of installed) {
    try {
      const inspection = await inspectPlugin(
        { name },
        { fetch: globalThis.fetch.bind(globalThis) },
      );
      if (UPGRADABLE_STATUSES.has(inspection.status)) {
        candidates.push(name);
      }
    } catch (err) {
      // An install whose drift cannot be classified (source unreachable,
      // rate-limited) is skipped rather than handed to the daemon, which
      // would hit the same failure a moment later.
      log.debug({ err, name }, "Plugin auto-update could not inspect plugin");
    }
  }
  return candidates;
}

/** Ask the daemon to upgrade one plugin. */
function requestUpgrade(
  name: string,
  strategy: PluginUpdatesConfig["strategy"],
) {
  return cliIpcCall<UpgradeCallResult>(
    UPGRADE_IPC_METHOD,
    // The target revision is never caller-supplied — the daemon resolves it
    // from the plugin's own source, exactly as an interactive upgrade does.
    { pathParams: { name }, body: { strategy } },
    { timeoutMs: UPGRADE_TIMEOUT_MS },
  );
}

/** What one sweep did, for logging and tests. */
export interface PluginAutoUpdateSweepResult {
  /** Why the sweep did no work, or `null` when it ran. */
  readonly skipped:
    | "manual"
    | "not-due"
    | "no-candidates"
    | "config-unreadable"
    | null;
  readonly upgraded: readonly string[];
  readonly unchanged: readonly string[];
  readonly failed: readonly string[];
  /** True when the daemon could not be reached, so the sweep stays due. */
  readonly daemonUnreachable: boolean;
}

const NOTHING: Omit<PluginAutoUpdateSweepResult, "skipped"> = {
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
export async function runPluginAutoUpdateSweepIfDue(): Promise<PluginAutoUpdateSweepResult> {
  let config: PluginUpdatesConfig;
  try {
    // `getConfigReadOnly` never creates directories or writes config.json —
    // the monitor must not repair the daemon's config file behind its back.
    // It re-reads on change, so flipping the mode needs no restart.
    config = getConfigReadOnly().pluginUpdates;
  } catch (err) {
    // A config that cannot be read is not an invitation to upgrade anything.
    log.warn({ err }, "Plugin auto-update could not read config — skipping");
    return { skipped: "config-unreadable", ...NOTHING };
  }
  if (config.mode !== "auto") {
    return { skipped: "manual", ...NOTHING };
  }

  const lastRunAt = lastSweepAt();
  if (lastRunAt !== null && Date.now() - lastRunAt < config.checkIntervalMs) {
    return { skipped: "not-due", ...NOTHING };
  }

  let names: string[];
  try {
    names = await listUpgradableNames();
  } catch (err) {
    log.warn({ err }, "Plugin auto-update could not list installed plugins");
    return { skipped: "no-candidates", ...NOTHING };
  }
  if (names.length === 0) {
    // Stamp anyway: a workspace with nothing to move is a completed sweep, and
    // re-inspecting every plugin a minute later would be pure churn.
    stampSweep();
    return { skipped: "no-candidates", ...NOTHING };
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
    let call: Awaited<ReturnType<typeof requestUpgrade>>;
    try {
      call = await requestUpgrade(name, config.strategy);
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
    if (call.timedOut) {
      // The request was delivered and the daemon may still be swapping this
      // plugin — closing our socket does not abort its handler. Stop the sweep
      // and stamp it: retrying in a minute would pile work onto an upgrade
      // that is still running (the daemon refuses a second upgrade of the same
      // plugin anyway). The next attempt is a full interval away.
      failed.push(name);
      log.warn(
        { name, timeoutMs: UPGRADE_TIMEOUT_MS },
        "Plugin auto-upgrade timed out — abandoning the sweep until the next interval",
      );
      break;
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
    stampSweep();
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
 * Guarded sweep: a sweep can outlive the poll interval (each plugin gets up to
 * {@link UPGRADE_TIMEOUT_MS}), and two concurrent sweeps would ask the daemon
 * to upgrade the same plugin twice.
 */
async function tick(): Promise<void> {
  if (inFlight) {
    return;
  }
  inFlight = true;
  try {
    await runPluginAutoUpdateSweepIfDue();
  } catch (err) {
    log.warn({ err }, "Plugin auto-update sweep failed (non-fatal)");
  } finally {
    inFlight = false;
  }
}

/**
 * Start the auto-update loop in the monitor process.
 *
 * The timer runs regardless of the current mode — it is the sweep that reads
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
