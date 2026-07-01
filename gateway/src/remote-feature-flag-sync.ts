import type { CredentialCache } from "./credential-cache.js";
import { credentialKey } from "./credential-key.js";
import { getDeviceId } from "./device-id.js";
import { fetchImpl } from "./fetch.js";
import { loadFeatureFlagDefaults } from "./feature-flag-defaults.js";
import { writeRemoteFeatureFlags } from "./feature-flag-remote-store.js";
import { arePlatformFeaturesEnabled } from "./feature-flag-resolver.js";
import { GA_NORMALIZATION_EXEMPT_FLAGS } from "./feature-flag-staged-rollout.js";
import { getLogger } from "./logger.js";

const log = getLogger("remote-feature-flag-sync");

/**
 * Steady-state polling interval: 5 minutes.
 *
 * Configurable via `REMOTE_FF_POLL_INTERVAL_MS` env var for testing or
 * deployment tuning.
 */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Initial polling interval when the first fetch fails (e.g. CES sidecar
 * not ready yet). Doubles on each consecutive failure until it reaches
 * the steady-state interval.
 */
const INITIAL_POLL_INTERVAL_MS = 10_000;

function getMaxPollIntervalMs(): number {
  const envVal = process.env.REMOTE_FF_POLL_INTERVAL_MS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_POLL_INTERVAL_MS;
}

/** Discriminated result from a remote feature flag fetch attempt. */
type RemoteFetchResult =
  | { status: "success"; values: Record<string, boolean | string> }
  | { status: "missing_credentials" }
  | { status: "error" };

export type RemoteFeatureFlagSyncConfig = {
  /** Credential cache for resolving platform URL and API key dynamically. */
  credentials: CredentialCache;
  /** Override the initial poll interval (ms) — useful for testing. Defaults to 10 000. */
  initialPollIntervalMs?: number;
  /** Called when remote flags change on disk after a successful fetch. */
  onChanged?: () => void;
};

/**
 * Manages the lifecycle of syncing remote feature flags from the platform.
 *
 * On start, fetches the current flag state and persists it to disk via the
 * remote feature flag store, then polls with adaptive back-off: starts at
 * {@link INITIAL_POLL_INTERVAL_MS} and doubles on each failure until it
 * reaches the steady-state interval. On the first success the interval
 * snaps to steady-state immediately.
 *
 * When credentials are not configured (user not logged in), polling pauses
 * entirely and resumes automatically when the credential cache is
 * invalidated (e.g. after login).
 */
export class RemoteFeatureFlagSync {
  private started = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private syncNowActive = false;
  /**
   * Set when `syncNow()` is called while a sync is already in flight. The
   * active loop runs one more fetch after it settles, so a credential/identity
   * change that lands mid-fetch is never dropped (see `syncNow`).
   */
  private pendingResync = false;
  private hasAuthedSuccessfully = false;
  private waitingForCredentials = false;
  private unsubscribeCredentials: (() => void) | null = null;
  private currentIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly credentials: CredentialCache;
  private readonly onChanged?: () => void;

  constructor(config: RemoteFeatureFlagSyncConfig) {
    this.credentials = config.credentials;
    this.currentIntervalMs =
      config.initialPollIntervalMs ?? INITIAL_POLL_INTERVAL_MS;
    this.maxIntervalMs = getMaxPollIntervalMs();
    this.onChanged = config.onChanged;
  }

  async start(): Promise<void> {
    this.started = true;

    let result: RemoteFetchResult["status"] = "error";
    try {
      result = await this.fetchAndCache();
    } catch (err) {
      log.warn({ err }, "Failed to sync remote feature flags on startup");
    }

    if (result === "success") {
      // First fetch succeeded — jump straight to steady-state polling.
      this.currentIntervalMs = this.maxIntervalMs;
      this.scheduleNextPoll();
    } else if (result === "missing_credentials") {
      this.pauseForCredentials();
    } else {
      this.scheduleNextPoll();
    }

    log.info(
      {
        intervalMs: this.currentIntervalMs,
        waitingForCredentials: this.waitingForCredentials,
      },
      "Remote feature flag polling started",
    );
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.clearCredentialWatch();
  }

  /**
   * Trigger an immediate remote flag sync (e.g. after system wake).
   *
   * Resets the poll timer so the next scheduled poll starts fresh from the
   * steady-state interval after this fetch completes.
   */
  async syncNow(): Promise<void> {
    // Re-entrancy guard: if a syncNow is already in-flight (e.g. triggered
    // by onInvalidate callback during a wake that also calls syncNow
    // explicitly), don't start a second concurrent fetch. Instead record
    // that a follow-up is needed: the in-flight fetch may have been
    // authenticated with now-stale credentials (a warm-pool claim writes
    // several credential files in quick succession, each firing the change
    // handler), so the active loop runs one more fetch after it settles to
    // guarantee the latest identity's flags are fetched (JARVIS-1018).
    if (this.syncNowActive) {
      this.pendingResync = true;
      return;
    }

    let result: RemoteFetchResult["status"] = "error";

    // Loop so a credential change that arrives mid-fetch triggers exactly one
    // more fetch after the current one settles, until none is pending. Each
    // iteration re-reads credentials via fetchAndCache, so the final pass
    // always reflects the latest identity.
    do {
      this.pendingResync = false;

      // Guard: tell poll()'s .finally() not to reschedule — we'll handle it.
      this.syncNowActive = true;

      // If we were waiting for credentials, clear that state.
      this.clearCredentialWatch();

      // Cancel the pending poll so we don't double-fetch.
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }

      try {
        result = await this.fetchAndCache();
        if (result === "success") {
          this.currentIntervalMs = this.maxIntervalMs;
        }
      } catch (err) {
        log.warn({ err }, "Failed to sync remote feature flags (syncNow)");
        result = "error";
      } finally {
        this.syncNowActive = false;
      }
    } while (this.started && this.pendingResync);

    if (this.started) {
      // A concurrent poll() may have called pauseForCredentials() during
      // our await, re-establishing credential-watch state and setting a
      // safety-net timer. Clean that up before deciding what to do next
      // so we don't leak timers or leave waitingForCredentials stale.
      this.clearCredentialWatch();
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }

      if (result === "missing_credentials") {
        this.pauseForCredentials();
      } else {
        this.scheduleNextPoll();
      }
    }
  }

  private scheduleNextPoll(): void {
    this.pollTimer = setTimeout(() => {
      this.poll();
    }, this.currentIntervalMs);
  }

  private poll(): void {
    if (!this.started) return;
    this.fetchAndCache()
      .then((result) => {
        if (result === "success") {
          // Success — snap to steady-state interval.
          this.currentIntervalMs = this.maxIntervalMs;
        } else if (result === "missing_credentials") {
          this.pauseForCredentials();
        } else {
          // Failure — double the interval, capped at max.
          this.currentIntervalMs = Math.min(
            this.currentIntervalMs * 2,
            this.maxIntervalMs,
          );
        }
      })
      .catch((err) => {
        log.warn({ err }, "Failed to sync remote feature flags during poll");
        this.currentIntervalMs = Math.min(
          this.currentIntervalMs * 2,
          this.maxIntervalMs,
        );
      })
      .finally(() => {
        // If syncNow() is active it owns rescheduling — skip to avoid
        // creating a duplicate poll chain.
        // If waitingForCredentials, credential watch owns resumption.
        if (
          this.started &&
          !this.syncNowActive &&
          !this.waitingForCredentials
        ) {
          this.scheduleNextPoll();
        }
      });
  }

  /**
   * Stop polling and watch for credential changes instead.
   *
   * Called when credentials are not configured (user not logged in).
   * Resumes sync automatically via two paths:
   * 1. Primary: credential cache invalidation (e.g. after login).
   * 2. Safety net: a delayed retry at the steady-state interval, in case
   *    the "missing" result was caused by a transient credential-reader
   *    failure (readCesCredential swallows errors as undefined) or an
   *    invalidation event was missed between the credential check and
   *    the listener registration.
   */
  private pauseForCredentials(): void {
    if (this.waitingForCredentials) return;
    this.waitingForCredentials = true;

    // Stop any pending poll.
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Primary resume path: credential cache invalidation.
    this.unsubscribeCredentials = this.credentials.onInvalidate(() => {
      if (!this.started || !this.waitingForCredentials) return;
      log.info("Credentials changed — attempting remote feature flag sync");
      this.syncNow().catch((err) => {
        log.warn(
          { err },
          "Failed to sync remote feature flags after credential change",
        );
      });
    });

    // Safety net: re-check after the steady-state interval. If credentials
    // are still missing, syncNow → pauseForCredentials re-arms this timer.
    this.pollTimer = setTimeout(() => {
      if (!this.started || !this.waitingForCredentials) return;
      log.debug("Safety re-check: retrying credential read after pause");
      this.syncNow().catch((err) => {
        log.warn(
          { err },
          "Failed to sync remote feature flags (safety re-check)",
        );
      });
    }, this.maxIntervalMs);

    log.debug("Paused remote flag polling — waiting for credentials");
  }

  /** Clear the credential invalidation watch if active. */
  private clearCredentialWatch(): void {
    this.waitingForCredentials = false;
    if (this.unsubscribeCredentials) {
      this.unsubscribeCredentials();
      this.unsubscribeCredentials = null;
    }
  }

  /**
   * Fetch remote flags and write them to the store.
   * Returns the status of the fetch attempt.
   */
  private async fetchAndCache(): Promise<RemoteFetchResult["status"]> {
    const result = await this.fetchRemoteFeatureFlags();
    if (result.status === "missing_credentials") {
      log.debug("Skipping remote flag sync — credentials not configured");
      return "missing_credentials";
    }
    if (result.status === "error") {
      log.warn("Skipping cache write — fetch returned no usable data");
      return "error";
    }
    const changed = writeRemoteFeatureFlags(result.values);
    const msg = "Synced remote feature flags";
    const meta = { count: Object.keys(result.values).length };
    if (changed) {
      log.info(meta, msg);
      this.onChanged?.();
    } else {
      log.debug(meta, msg);
    }
    return "success";
  }

  private async fetchRemoteFeatureFlags(): Promise<RemoteFetchResult> {
    if (!arePlatformFeaturesEnabled()) {
      log.debug("Remote feature flag sync skipped: platform features disabled");
      return { status: "missing_credentials" };
    }

    // Wrap credential reads so transient failures (CES unreachable, keychain
    // errors) are treated as retriable errors with backoff, not as "missing
    // credentials" which would pause polling indefinitely.
    let platformUrlRaw: string | undefined;
    let assistantApiKeyRaw: string | undefined;
    try {
      [platformUrlRaw, assistantApiKeyRaw] = await Promise.all([
        this.credentials.get(credentialKey("vellum", "platform_base_url")),
        this.credentials.get(credentialKey("vellum", "assistant_api_key")),
      ]);
    } catch (err) {
      log.warn({ err }, "Failed to read credentials — will retry on next poll");
      return { status: "error" };
    }

    // Fall back to env vars when managed pod credentials are not yet cached.
    const platformUrl = (
      platformUrlRaw?.trim() ||
      process.env.VELLUM_PLATFORM_URL?.trim() ||
      ""
    ).replace(/\/+$/, "");

    const assistantCredential =
      assistantApiKeyRaw?.trim() ||
      process.env.ASSISTANT_API_KEY?.trim() ||
      undefined;

    if (!platformUrl) {
      log.debug("Remote feature flag sync skipped: no platform URL configured");
      return { status: "missing_credentials" };
    }

    // If we previously fetched with auth and the API key is now missing,
    // treat it as a transient error (backoff + retry) rather than
    // downgrading to an anonymous fetch that would overwrite per-assistant
    // flag values with anonymous defaults.
    if (!assistantCredential && this.hasAuthedSuccessfully) {
      log.warn(
        "API key previously available but now missing — treating as transient error",
      );
      return { status: "error" };
    }

    const url = `${platformUrl}/v1/feature-flags/assistant-flag-values/`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (assistantCredential) {
      headers["Authorization"] = `Api-Key ${assistantCredential}`;
    }
    const deviceId = getDeviceId();
    if (deviceId) {
      headers["Vellum-Device-Id"] = deviceId;
    }
    log.debug(
      { url, authenticated: !!assistantCredential },
      "Fetching remote feature flags from platform",
    );

    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log.warn(
        { status: response.status, url },
        "Platform feature flags request failed",
      );
      return { status: "error" };
    }

    const body = (await response.json()) as {
      flags?: Record<string, boolean | string>;
    };
    if (!body.flags || typeof body.flags !== "object") {
      log.warn("Platform feature flags response missing 'flags' field");
      return { status: "error" };
    }

    // Accept boolean and string values from the platform. Prevent the
    // platform from disabling boolean flags that are already GA
    // (defaultEnabled: true in the registry). The platform uses a
    // blanket-deny posture, sending false for every flag it knows about.
    // GA normalization only applies to boolean false values; string flag
    // values pass through unchanged.
    //
    // Flags in GA_NORMALIZATION_EXEMPT_FLAGS are excluded: they default on in
    // the registry (so local/self-hosted installs get the new default) but must
    // still honor a platform-sent `false` so managed assistants can be rolled
    // out gradually via LaunchDarkly targeting instead of switching all at once.
    const registry = loadFeatureFlagDefaults();
    const values: Record<string, boolean | string> = {};
    for (const [key, value] of Object.entries(body.flags)) {
      if (typeof value !== "boolean" && typeof value !== "string") continue;
      if (
        value === false &&
        registry[key]?.defaultEnabled === true &&
        !GA_NORMALIZATION_EXEMPT_FLAGS.has(key)
      ) {
        log.debug(
          { key },
          "Normalizing remote false for GA flag to true (defaultEnabled: true)",
        );
        values[key] = true;
        continue;
      }
      values[key] = value;
    }

    if (assistantCredential) {
      this.hasAuthedSuccessfully = true;
    }

    return { status: "success", values };
  }
}
