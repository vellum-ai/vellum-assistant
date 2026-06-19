import * as Sentry from "@sentry/react";

import { getDeviceBool, watchDeviceSetting } from "@/utils/device-settings";
import { syncDiagnosticsToMain } from "@/runtime/diagnostics";
import { useAuthStore } from "@/stores/auth-store";
import { isConfirmedPlatformSession } from "@/stores/session-status";

/**
 * Gates Sentry on BOTH the user's Share Diagnostics toggle
 * (`device:share_diagnostics`) AND a probe-confirmed live platform session.
 * Diagnostics are recorded against a platform account, so an offline /
 * self-hosted client — including a believed offline restore (LUM-2412) that no
 * live probe has revalidated — stays fail-closed regardless of the device
 * toggle, matching the daemon's consent posture. The same gate drives the
 * browser client and, via `syncDiagnosticsToMain`, the Electron main client.
 *
 * Strict opt-in semantics for the device toggle (when a session is live):
 *   - stored "true"  → Sentry ON  (explicit consent)
 *   - stored "false" → Sentry OFF (explicit opt-out)
 *   - absent         → Sentry OFF (no consent on record yet)
 *
 * Reference: https://docs.sentry.io/platforms/javascript/guides/react/configuration/options/
 */

export function diagnosticsConsentGranted(): boolean {
  const { platformSession, platformSessionRestoredOffline } =
    useAuthStore.getState();
  if (!isConfirmedPlatformSession(platformSession, platformSessionRestoredOffline)) {
    return false;
  }
  return getDeviceBool("shareDiagnostics", false);
}

function tryInit(options: Sentry.BrowserOptions): void {
  const existing = Sentry.getClient();
  if (existing && existing.getOptions().enabled !== false) return;
  Sentry.init({ ...options, enabled: true });
}

function tryClose(): void {
  const client = Sentry.getClient();
  if (!client) return;
  void client.close(2000);
  Sentry.getCurrentScope().setClient(undefined);
}

/**
 * Apply the current consent value to the Sentry client — init if consented
 * and not yet running, close if not consented and currently running.
 * Idempotent when consent matches the current client state.
 */
export function syncSentryClient(options: Sentry.BrowserOptions): void {
  if (!options.dsn) return;
  if (diagnosticsConsentGranted()) {
    tryInit(options);
  } else {
    tryClose();
  }
}

/**
 * Install listeners so both Sentry clients (browser + Electron main) re-apply
 * the gate whenever it changes: the user flipping the Share Diagnostics toggle
 * (cross-tab via the native `storage` event, same-tab via the custom event from
 * `setLocalSetting`) or the platform session transitioning in/out of "present".
 *
 * Returns a cleanup function that removes both listeners.
 */
export function installSentryControlListeners(
  options: Sentry.BrowserOptions,
): () => void {
  const sync = () => {
    syncSentryClient(options);
    syncDiagnosticsToMain(diagnosticsConsentGranted());
  };
  const stopDeviceWatch = watchDeviceSetting("shareDiagnostics", sync);
  const stopSessionWatch = useAuthStore.subscribe((state, prevState) => {
    if (
      state.platformSession !== prevState.platformSession ||
      state.platformSessionRestoredOffline !==
        prevState.platformSessionRestoredOffline
    ) {
      sync();
    }
  });
  return () => {
    stopDeviceWatch();
    stopSessionWatch();
  };
}
