import { loadFeatureFlagDefaults } from "./feature-flag-defaults.js";
import { writeRemoteFeatureFlags } from "./feature-flag-remote-store.js";
import { getLogger } from "./logger.js";

const log = getLogger("remote-feature-flag-sync");

/**
 * Manages the lifecycle of syncing remote feature flags from the platform.
 *
 * On start, fetches the current flag state and persists it to disk via the
 * remote feature flag store. Errors are caught and logged — the system falls
 * through to registry defaults if this fails.
 */
export class RemoteFeatureFlagSync {
  private started = false;

  // TODO: Replace fetchRemoteFeatureFlags with an SSE EventSource connection
  // to the platform. On initial connection, the platform sends the full flag
  // state. On subsequent events, call fetchAndCache() again with the updated
  // values.

  async start(): Promise<void> {
    this.started = true;

    try {
      await this.fetchAndCache();
    } catch (err) {
      log.warn({ err }, "Failed to sync remote feature flags");
    }
  }

  stop(): void {
    this.started = false;
    // TODO: Close SSE EventSource connection here
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
   * resolution is zero until the real platform SSE replaces this.
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
