import type { CredentialCache } from "./credential-cache.js";
import { credentialKey } from "./credential-key.js";
import { fetchImpl } from "./fetch.js";
import { loadFeatureFlagDefaults } from "./feature-flag-defaults.js";
import { writeRemoteFeatureFlags } from "./feature-flag-remote-store.js";
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
  | { status: "success"; values: Record<string, boolean> }
  | { status: "missing_credentials" }
  | { status: "error" };

export type RemoteFeatureFlagSyncConfig = {
  /** Credential cache for resolving platform URL and API key dynamically. */
  credentials: CredentialCache;
  /** Override the initial poll interval (ms) — useful for testing. Defaults to 10 000. */
  initialPollIntervalMs?: number;
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
  private waitingForCredentials = false;
  private unsubscribeCredentials: (() => void) | null = null;
  private currentIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly credentials: CredentialCache;

  constructor(config: RemoteFeatureFlagSyncConfig) {
    this.credentials = config.credentials;
    this.currentIntervalMs =
      config.initialPollIntervalMs ?? INITIAL_POLL_INTERVAL_MS;
    this.maxIntervalMs = getMaxPollIntervalMs();
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
    // explicitly), skip to avoid leaking duplicate poll timers.
    if (this.syncNowActive) return;

    // Guard: tell poll()'s .finally() not to reschedule — we'll handle it.
    this.syncNowActive = true;

    // If we were waiting for credentials, clear that state.
    this.clearCredentialWatch();

    // Cancel the pending poll so we don't double-fetch.
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    let result: RemoteFetchResult["status"] = "error";
    try {
      result = await this.fetchAndCache();
      if (result === "success") {
        this.currentIntervalMs = this.maxIntervalMs;
      }
    } catch (err) {
      log.warn({ err }, "Failed to sync remote feature flags (syncNow)");
    } finally {
      this.syncNowActive = false;
    }

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
    } else {
      log.debug(meta, msg);
    }
    return "success";
  }

  private async fetchRemoteFeatureFlags(): Promise<RemoteFetchResult> {
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

    // Feature flag sync hits the public platform API and requires assistant
    // API key auth.
    const assistantCredential =
      assistantApiKeyRaw?.trim() ||
      process.env.ASSISTANT_API_KEY?.trim() ||
      undefined;

    if (!platformUrl || !assistantCredential) {
      log.debug(
        {
          hasPlatformUrl: !!platformUrl,
          hasApiKey: !!assistantCredential,
        },
        "Remote feature flag sync skipped: missing credentials",
      );
      return { status: "missing_credentials" };
    }

    const url = `${platformUrl}/v1/feature-flags/assistant-flag-values/`;
    log.debug({ url }, "Fetching remote feature flags from platform");

    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Api-Key ${assistantCredential}`,
        Accept: "application/json",
      },
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
      flags?: Record<string, boolean>;
    };
    if (!body.flags || typeof body.flags !== "object") {
      log.warn("Platform feature flags response missing 'flags' field");
      return { status: "error" };
    }

    // Filter to boolean values only (defensive), and prevent the platform
    // from disabling flags that are already GA (defaultEnabled: true in the
    // registry). The platform uses a blanket-deny posture, sending false for
    // every flag it knows about. Without this filter, shipped features get
    // silently turned off for all users.
    const registry = loadFeatureFlagDefaults();
    const values: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(body.flags)) {
      if (typeof value !== "boolean") continue;
      if (!value && registry[key]?.defaultEnabled) {
        log.debug(
          { key },
          "Ignoring remote false for GA flag (defaultEnabled: true)",
        );
        continue;
      }
      values[key] = value;
    }

    return { status: "success", values };
  }
}
