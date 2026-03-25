import type { CredentialCache } from "./credential-cache.js";
import { credentialKey } from "./credential-key.js";
import { fetchImpl } from "./fetch.js";
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

export type RemoteFeatureFlagSyncConfig = {
  /** Credential cache for resolving platform URL, API key, and assistant ID dynamically. */
  credentials: CredentialCache;
};

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
  private readonly credentials: CredentialCache;

  constructor(config: RemoteFeatureFlagSyncConfig) {
    this.credentials = config.credentials;
  }

  async start(): Promise<void> {
    this.started = true;

    try {
      await this.fetchAndCache();
    } catch (err) {
      log.warn({ err }, "Failed to sync remote feature flags on startup");
    }

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
    if (values === null) {
      log.debug("Skipping cache write — fetch returned no usable data");
      return;
    }
    writeRemoteFeatureFlags(values);
    log.info(
      { count: Object.keys(values).length },
      "Synced remote feature flags",
    );
  }

  private async fetchRemoteFeatureFlags(): Promise<Record<
    string,
    boolean
  > | null> {
    const [platformUrlRaw, assistantIdRaw, platformApiKeyRaw] =
      await Promise.all([
        this.credentials.get(credentialKey("vellum", "platform_base_url")),
        this.credentials.get(credentialKey("vellum", "platform_assistant_id")),
        this.credentials.get(credentialKey("vellum", "assistant_api_key")),
      ]);

    const platformUrl = platformUrlRaw?.trim().replace(/\/+$/, "");
    const assistantId = assistantIdRaw?.trim();
    const platformApiKey = platformApiKeyRaw?.trim();

    if (!platformUrl || !assistantId || !platformApiKey) {
      log.debug(
        {
          hasPlatformUrl: !!platformUrl,
          hasAssistantId: !!assistantId,
          hasPlatformApiKey: !!platformApiKey,
        },
        "Remote feature flag sync skipped: missing credentials",
      );
      return null;
    }

    const url = `${platformUrl}/v1/assistants/${assistantId}/feature-flags/`;
    log.debug({ url }, "Fetching remote feature flags from platform");

    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Api-Key ${platformApiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log.warn(
        { status: response.status, url },
        "Platform feature flags request failed",
      );
      return null;
    }

    const body = (await response.json()) as {
      flags?: Record<string, boolean>;
    };
    if (!body.flags || typeof body.flags !== "object") {
      log.warn("Platform feature flags response missing 'flags' field");
      return null;
    }

    // Filter to boolean values only (defensive)
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(body.flags)) {
      if (typeof value === "boolean") {
        result[key] = value;
      }
    }

    return result;
  }
}
