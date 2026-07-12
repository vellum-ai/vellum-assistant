import type { AssistantConfig } from "../config/schema.js";
import { getLogger } from "../util/logger.js";
import { recordConfigSettingEvent } from "./config-setting-events-store.js";

const log = getLogger("config-setting-snapshot");

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
 * Consent-gated and retry-friendly: `recordConfigSettingEvent` drops the
 * event (returning false) when `share_analytics` consent is off — including
 * the default-off window before the first successful consent fetch — or when
 * the telemetry DB is unavailable, and the memo is only advanced on a real
 * persist. So a caller that re-invokes this each cycle records the snapshot
 * on its first opted-in cycle with a resolvable DB, then stays quiet until a
 * value changes. Never throws — a storage failure is logged and the key
 * retries on the next invocation.
 */
export function recordConfigSettingSnapshot(config: AssistantConfig): void {
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

/** Test-only: clear the per-process last-recorded memo. */
export function resetConfigSettingSnapshotForTesting(): void {
  lastRecorded.clear();
}
