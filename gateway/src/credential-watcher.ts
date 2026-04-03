/**
 * Watches the assistant's credential metadata file and the v2 store key
 * for changes, triggering a callback when channel credentials are added,
 * updated, or removed.
 *
 * Watches parent directories rather than files themselves because
 * metadata.json is rewritten via atomic rename. File-scoped fs.watch()
 * subscriptions can stay attached to the old inode after the first write,
 * causing later credential changes to be missed until restart.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname, join } from "node:path";
import { getLogger } from "./logger.js";
import {
  readServiceCredentials,
  ALL_CREDENTIAL_SPECS,
  getMetadataPath,
  getRootDir,
} from "./credential-reader.js";

const log = getLogger("credential-watcher");

const DEBOUNCE_MS = 500;
const MANAGED_BOOTSTRAP_POLL_MS = 1_000;
const MANAGED_BOOTSTRAP_TIMEOUT_MS = 1_000;
const MANAGED_BOOTSTRAP_STEADY_POLL_MS = 30_000;

export type CredentialChangeEvent = {
  /** Map from service name to resolved credentials (null if unavailable) */
  credentials: ReadonlyMap<string, Record<string, string> | null>;
  /** Set of service names whose credentials changed since last poll */
  changedServices: ReadonlySet<string>;
};

export type CredentialChangeCallback = (event: CredentialChangeEvent) => void;

export class CredentialWatcher {
  private watchers: FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private managedBootstrapTimer: ReturnType<typeof setInterval> | null = null;
  private managedBootstrapPollInFlight = false;
  private managedBootstrapInSteadyState = false;
  private lastConfiguredServices = new Set<string>();
  private lastReadyServices = new Set<string>();
  private lastSerialized: Map<string, string> = new Map();
  private polling = false;
  private pendingPoll = false;
  private callback: CredentialChangeCallback;
  private metadataPath: string;

  constructor(callback: CredentialChangeCallback) {
    this.callback = callback;
    this.metadataPath = getMetadataPath();
  }

  async start(): Promise<void> {
    await this.pollOnce();

    const metadataDir = dirname(this.metadataPath);
    const protectedDir = join(getRootDir(), "protected");

    // Ensure directories exist so fs.watch() doesn't throw ENOENT
    // on a fresh hatch where no credentials have been written yet.
    mkdirSync(metadataDir, { recursive: true });
    mkdirSync(protectedDir, { recursive: true });

    // Watch the metadata directory for metadata.json changes.
    this.startWatcher(metadataDir, "metadata.json");

    // Watch the protected directory for store.key changes so that
    // creating or restoring the v2 store key triggers a credential reload.
    this.startWatcher(protectedDir, "store.key");

    // Watch keys.enc for credential writes. When credentials are re-saved
    // with the same values (e.g. in-chat credential_store re-entering
    // existing tokens), the serialized credential values won't change —
    // but the encrypted ciphertext will (new IV). Force a full reload so
    // channel listeners restart even when the plaintext values match.
    this.startWatcher(protectedDir, "keys.enc", { forceChanged: true });

    this.startManagedBootstrapRetry();
  }

  private startWatcher(
    dir: string,
    targetFilename: string,
    opts?: { forceChanged?: boolean },
  ): void {
    const forceChanged = opts?.forceChanged ?? false;
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && filename !== targetFilename) {
          return;
        }
        this.scheduleCheck(forceChanged);
      });
      this.watchers.push(watcher);

      log.info(
        { path: dir, file: targetFilename },
        "Watching for credential changes",
      );
    } catch (err) {
      log.warn({ err, path: dir }, "Failed to start credential file watcher");
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.managedBootstrapTimer) {
      clearInterval(this.managedBootstrapTimer);
      this.managedBootstrapTimer = null;
    }
    this.managedBootstrapPollInFlight = false;
    this.managedBootstrapInSteadyState = false;
    this.pendingPoll = false;
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  private startManagedBootstrapRetry(): void {
    const baseUrl = process.env.CES_CREDENTIAL_URL?.trim();
    const serviceToken = process.env.CES_SERVICE_TOKEN?.trim();
    if (!baseUrl || !serviceToken) return;

    const poll = (): void => {
      void this.pollManagedBootstrap(baseUrl, serviceToken);
    };

    this.managedBootstrapTimer = setInterval(poll, MANAGED_BOOTSTRAP_POLL_MS);
    this.managedBootstrapTimer.unref?.();
    poll();
  }

  private async pollManagedBootstrap(
    baseUrl: string,
    serviceToken: string,
  ): Promise<void> {
    if (this.managedBootstrapPollInFlight) return;
    this.managedBootstrapPollInFlight = true;
    try {
      const resp = await fetch(`${baseUrl}/v1/credentials`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(MANAGED_BOOTSTRAP_TIMEOUT_MS),
      });
      if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
        if (this.managedBootstrapTimer) {
          clearInterval(this.managedBootstrapTimer);
          this.managedBootstrapTimer = null;
        }
        log.warn(
          { status: resp.status },
          "Stopping managed credential bootstrap retry due to non-retryable CES response",
        );
        return;
      }
      if (!resp.ok) {
        return;
      }

      await this.pollOnce();

      const ready =
        this.lastConfiguredServices.size > 0 &&
        this.allConfiguredServicesReady();

      if (ready && !this.managedBootstrapInSteadyState) {
        // All configured channel services have their credentials loaded.
        // Switch to a slower steady-state poll as a resilient fallback for
        // environments where fs.watch() doesn't propagate across containers.
        if (this.managedBootstrapTimer) {
          clearInterval(this.managedBootstrapTimer);
          this.managedBootstrapTimer = setInterval(() => {
            void this.pollManagedBootstrap(baseUrl, serviceToken);
          }, MANAGED_BOOTSTRAP_STEADY_POLL_MS);
          this.managedBootstrapTimer.unref?.();
        }
        this.managedBootstrapInSteadyState = true;
      } else if (!ready && this.managedBootstrapInSteadyState) {
        // A configured service lost its credentials — revert to fast polling
        // so we pick up restored credentials quickly.
        if (this.managedBootstrapTimer) {
          clearInterval(this.managedBootstrapTimer);
          this.managedBootstrapTimer = setInterval(() => {
            void this.pollManagedBootstrap(baseUrl, serviceToken);
          }, MANAGED_BOOTSTRAP_POLL_MS);
          this.managedBootstrapTimer.unref?.();
        }
        this.managedBootstrapInSteadyState = false;
      }
    } catch {
      // CES isn't reachable yet. Keep retrying until the sidecar is ready.
    } finally {
      this.managedBootstrapPollInFlight = false;
    }
  }

  /** Whether the next scheduled poll should treat all services as changed. */
  private pendingForceChanged = false;

  private scheduleCheck(forceChanged = false): void {
    if (forceChanged) this.pendingForceChanged = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const force = this.pendingForceChanged;
      this.pendingForceChanged = false;
      void this.pollOnce(force);
    }, DEBOUNCE_MS);
  }

  private async pollOnce(forceChanged = false): Promise<void> {
    if (this.polling) {
      // A poll is already in flight — flag that another round is needed
      // so credential updates arriving mid-poll aren't silently dropped.
      this.pendingPoll = true;
      if (forceChanged) this.pendingForceChanged = true;
      return;
    }
    this.polling = true;
    try {
      const credentials = new Map<string, Record<string, string> | null>();
      const configuredServices = this.loadConfiguredServices();
      for (const spec of ALL_CREDENTIAL_SPECS) {
        credentials.set(spec.service, await readServiceCredentials(spec));
      }
      this.lastConfiguredServices = configuredServices;
      this.lastReadyServices = new Set(
        [...credentials.entries()]
          .filter(([, creds]) => creds !== null)
          .map(([service]) => service),
      );

      const changedServices = new Set<string>();
      for (const [service, creds] of credentials) {
        const newVal = creds ? JSON.stringify(creds) : undefined;
        const oldVal = this.lastSerialized.get(service);
        if (newVal !== oldVal || (forceChanged && newVal !== undefined)) {
          changedServices.add(service);
          if (newVal !== undefined) {
            this.lastSerialized.set(service, newVal);
          } else {
            this.lastSerialized.delete(service);
          }
        }
      }

      if (changedServices.size === 0) return;

      this.callback({ credentials, changedServices });
    } finally {
      this.polling = false;
      if (this.pendingPoll) {
        this.pendingPoll = false;
        const force = this.pendingForceChanged;
        this.pendingForceChanged = false;
        void this.pollOnce(force);
      }
    }
  }

  private loadConfiguredServices(): Set<string> {
    if (!existsSync(this.metadataPath)) return new Set();

    try {
      const raw = readFileSync(this.metadataPath, "utf-8");
      const data = JSON.parse(raw) as {
        credentials?: Array<{ service?: string; field?: string }>;
      };
      if (!Array.isArray(data.credentials)) return new Set();

      const configured = new Set<string>();
      for (const spec of ALL_CREDENTIAL_SPECS) {
        const hasAllRequiredFields = spec.requiredFields.every((field) =>
          data.credentials?.some(
            (credential) =>
              credential.service === spec.service && credential.field === field,
          ),
        );
        if (hasAllRequiredFields) {
          configured.add(spec.service);
        }
      }

      return configured;
    } catch {
      return new Set();
    }
  }

  private allConfiguredServicesReady(): boolean {
    for (const service of this.lastConfiguredServices) {
      if (!this.lastReadyServices.has(service)) {
        return false;
      }
    }
    return true;
  }
}
