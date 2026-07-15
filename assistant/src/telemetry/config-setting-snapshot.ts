import { getConfigReadOnly } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";
import { getRawShareAnalytics } from "../platform/consent-cache.js";
import { getLogger } from "../util/logger.js";
import { recordConfigSettingEvent } from "./config-setting-events-store.js";

const log = getLogger("config-setting-snapshot");

/**
 * How often the config snapshot re-records the tracked settings. The snapshot
 * memoizes per key, so a steady-state tick records nothing; the cadence
 * exists so the first opted-in tick (consent resolves asynchronously after
 * boot) lands and a live config edit is captured within one window. Hourly is
 * ample — these values change rarely and every boot re-asserts them.
 */
const CONFIG_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The explicit allowlist of settings reported as `config_setting` telemetry,
 * as `(config_key, config_value)` pairs. Keys are dotted config paths; values
 * are the effective (defaults-applied) values rendered as strings. Add only
 * non-sensitive settings — never free-form config content, paths, or
 * credentials.
 *
 * Optional chaining is defensive: the effective config always carries these
 * fields, but a partial config (a mocked config in tests) skips the key
 * rather than recording a bogus value or throwing out of the emitter.
 */
function trackedConfigSettings(
  config: AssistantConfig,
): ReadonlyArray<readonly [string, string]> {
  const pairs: ReadonlyArray<readonly [string, boolean | undefined]> = [
    ["memory.enabled", config.memory?.enabled],
    ["memory.v2.enabled", config.memory?.v2?.enabled],
  ];
  return pairs
    .filter((pair): pair is readonly [string, boolean] => pair[1] != null)
    .map(([key, value]) => [key, String(value)] as const);
}

/**
 * Per-process memo of the last value recorded for each tracked key, so a
 * repeated snapshot only persists a row when the effective value actually
 * changed. Process-scoped on purpose: a restart re-records the current
 * values, giving downstream consumers a fresh per-boot assertion of each
 * setting.
 */
const lastRecorded = new Map<string, string>();

/**
 * Record a `config_setting` event for every tracked setting whose effective
 * value differs from what this process last recorded.
 *
 * Consent-gated with a memo reset on opt-out. While `share_analytics` is a
 * confirmed opt-out, nothing is recorded and the memo is cleared: the
 * reporter's opt-out flush discards any config_setting rows still pending
 * upload, so a memo entry from before the opt-out no longer corresponds to a
 * delivered row. Clearing it means a later re-opt-in (in the same process,
 * unchanged config) re-records the full current snapshot rather than skipping
 * memoized keys — consumers that expect a complete snapshot after re-opt-in
 * stay correct. An unknown consent state records normally — the record-time
 * drop is a courtesy for known opt-outs only, never a reason to lose data.
 *
 * Retry-friendly when opted in: `recordConfigSettingEvent` returns false when
 * the telemetry DB is momentarily unavailable, and the memo is only advanced
 * on a real persist, so a caller that re-invokes this each cycle records the
 * snapshot on its first cycle with a resolvable DB, then stays quiet until a
 * value changes. Never throws — a storage failure is logged and the key
 * retries on the next invocation.
 */
export function recordConfigSettingSnapshot(config: AssistantConfig): void {
  if (getRawShareAnalytics() === false) {
    lastRecorded.clear();
    return;
  }
  for (const [configKey, configValue] of trackedConfigSettings(config)) {
    if (lastRecorded.get(configKey) === configValue) {
      continue;
    }
    try {
      if (recordConfigSettingEvent({ configKey, configValue })) {
        lastRecorded.set(configKey, configValue);
      }
    } catch (err) {
      log.warn(
        { err, configKey },
        "Failed to record config_setting telemetry event — will retry on the next snapshot",
      );
    }
  }
}

let snapshotTimer: ReturnType<typeof setInterval> | null = null;

function recordSnapshotFromConfig(): void {
  try {
    // `getConfigReadOnly()` re-reads config.json on change (capturing live
    // edits) and never writes to disk — safe for the monitor process.
    recordConfigSettingSnapshot(getConfigReadOnly());
  } catch (err) {
    log.warn({ err }, "Config-setting snapshot failed (non-fatal)");
  }
}

/**
 * Start the config-setting snapshot loop in the resource monitor process:
 * record the tracked settings once at boot, then hourly. No-op in dev mode
 * (VELLUM_DEV=1) and idempotent if already started. Mirrors
 * {@link import("./usage-telemetry-reporter.js").startMonitorUsageTelemetryReporter}
 * — the snapshot feeds the same config_setting pipeline the monitor flushes.
 */
export function startConfigSnapshotReporter(): void {
  if (process.env.VELLUM_DEV === "1") {
    return;
  }
  if (snapshotTimer) {
    return;
  }
  recordSnapshotFromConfig();
  snapshotTimer = setInterval(
    recordSnapshotFromConfig,
    CONFIG_SNAPSHOT_INTERVAL_MS,
  );
}

/** Stop the config-setting snapshot loop. Idempotent. */
export function stopConfigSnapshotReporter(): void {
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
}

/** Test-only: clear the per-process last-recorded memo. */
export function resetConfigSettingSnapshotForTesting(): void {
  lastRecorded.clear();
}
