import type { AssistantConfig } from "../config/schema.js";
import { getCachedShareAnalytics } from "../platform/consent-cache.js";
import { getLogger } from "../util/logger.js";
import { recordConfigSettingEvent } from "./config-setting-events-store.js";

const log = getLogger("config-setting-snapshot");

/**
 * The explicit allowlist of config settings reported as `config_setting`
 * telemetry events, as `(config_key, config_value)` pairs. Keys are dotted
 * config paths; values are the effective (defaults-applied) values rendered
 * as strings. Only add non-sensitive settings here — never free-form config
 * content, paths, or credentials.
 */
function trackedConfigSettings(
  config: AssistantConfig,
): ReadonlyArray<readonly [string, string]> {
  // Defensive optional chaining: the effective (defaults-applied) config
  // always carries these fields, but a partial config (degraded loader,
  // mocked config in tests) must skip the key rather than record a bogus
  // value or throw out of a telemetry hook.
  const pairs: ReadonlyArray<readonly [string, boolean | undefined]> = [
    ["memory.enabled", config.memory?.enabled],
    ["memory.v2.enabled", config.memory?.v2?.enabled],
  ];
  return pairs
    .filter((pair): pair is readonly [string, boolean] => pair[1] != null)
    .map(([key, value]) => [key, String(value)] as const);
}

/**
 * Per-process memo of the last value recorded for each tracked key, so
 * repeated snapshots (every reporter flush, every config reload) only
 * persist a row when the effective value actually changed. Process-scoped
 * on purpose: a restart re-records the current values, giving downstream
 * consumers a fresh per-boot assertion of each setting.
 */
const lastRecorded = new Map<string, string>();

/**
 * Record a `config_setting` telemetry event for every tracked setting whose
 * effective value differs from what this process last recorded.
 *
 * Consent-gated and retry-friendly: when `share_analytics` consent is off
 * (including the default-off window before the first successful consent
 * fetch) nothing is recorded AND the memo is left untouched, so a caller
 * that re-invokes this periodically (the usage telemetry reporter's flush
 * cycle) records the snapshot on its first opted-in invocation. Never
 * throws — a storage failure is logged and the failed key retries on the
 * next invocation.
 */
export function recordConfigSettingSnapshot(config: AssistantConfig): void {
  if (!getCachedShareAnalytics()) {
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

/** Test-only: clear the per-process last-recorded memo. */
export function resetConfigSettingSnapshotForTesting(): void {
  lastRecorded.clear();
}
