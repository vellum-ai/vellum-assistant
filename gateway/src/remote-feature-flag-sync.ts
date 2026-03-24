import { loadFeatureFlagDefaults } from "./feature-flag-defaults.js";
import { writeRemoteFeatureFlags } from "./feature-flag-remote-store.js";
import { getLogger } from "./logger.js";

const log = getLogger("remote-feature-flag-sync");

/**
 * Default polling interval: 5 minutes.
 *
 * Configurable via `REMOTE_FF_POLL_INTERVAL_MS` env var for testing or
 * deployment tuning.
 */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

function getPollIntervalMs(): number {
  const envVal = process.env.REMOTE_FF_POLL_INTERVAL_MS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_POLL_INTERVAL_MS;
}

/**
 * Manages the lifecycle of syncing remote feature flags from the platform.
 *
 * On start, fetches the current flag state and persists it to disk via the
 * remote feature flag store, then polls on a configurable interval. Errors
 * are caught and logged — the system falls through to registry defaults if
 * this fails.
 */
export class RemoteFeatureFlagSync {
  private started = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    this.started = true;

    try {
      await this.fetchAndCache();
    } catch (err) {
      log.warn({ err }, "Failed to sync remote feature flags on startup");
    }

    // TODO: Replace stub fetch with real platform API call to
    // GET ${VELLUM_PLATFORM_URL}/v1/feature-flags (or similar).
    // The poll interval ensures the gateway picks up flag changes
    // without requiring a restart.
    const intervalMs = getPollIntervalMs();
    this.pollTimer = setInterval(() => {
      this.fetchAndCache().catch((err) => {
        log.warn({ err }, "Failed to sync remote feature flags during poll");
      });
    }, intervalMs);

    log.info({ intervalMs }, "Remote feature flag polling started");
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async fetchAndCache(): Promise<void> {
    const values = await this.fetchRemoteFeatureFlags();
    writeRemoteFeatureFlags(values);
    log.info(
      { count: Object.keys(values).length },
      "Synced remote feature flags",
    );
  }

  /**
   * Stub: returns the same values the registry provides so the net effect on
   * resolution is zero until the real platform API replaces this.
   */
  private async fetchRemoteFeatureFlags(): Promise<Record<string, boolean>> {
    log.debug("Fetching remote feature flags (stub)");

    const defaults = loadFeatureFlagDefaults();
    const result: Record<string, boolean> = {};
    for (const [key, entry] of Object.entries(defaults)) {
      result[key] = entry.defaultEnabled;
    }
    return result;
  }
}
