/**
 * Gates the browser-side Sentry client on BOTH the effective diagnostics-
 * reporting gate (`device:diagnostics_reporting`) AND a probe-confirmed live
 * platform session.
 *
 * The reporting gate tracks the saved Share Diagnostics preference with
 * opt-out semantics: it closes only for an explicit opt-out. It is written by
 * the consent-resolution paths (`setDiagnosticsReportingGate`).
 *
 * Diagnostics are recorded against a platform account, so an offline /
 * self-hosted client — including a believed offline restore (LUM-2412) that no
 * live probe has revalidated — stays fail-closed regardless of the device
 * gate, matching the daemon's consent posture. The same composed gate drives
 * the browser client and, via `syncDiagnosticsToMain`, the Electron main client.
 *
 * Opt-out semantics for the reporting gate (when a session is live):
 *   - stored "true"  → Sentry ON  (explicit or default-on consent)
 *   - stored "false" → Sentry OFF (explicit opt-out)
 *   - absent         → Sentry ON  (never asked — telemetry is opt-out)
 *
 * SDK access is dispatched through `selectSentryFlavor()` so each surface
 * (web/electron renderer, capacitor) can supply its own implementation. The
 * composed gate itself lives in `consent-gate.ts` so the capacitor flavor's
 * native `beforeSend` reads the same source without an import cycle.
 *
 * Reference: https://docs.sentry.io/platforms/javascript/guides/react/configuration/options/
 */
import type { BrowserOptions } from "@sentry/react";

import { selectSentryFlavor } from "@/lib/sentry/flavor";
import { diagnosticsConsentGranted } from "@/lib/sentry/consent-gate";
import { watchDeviceSetting } from "@/utils/device-settings";
import { syncDiagnosticsToMain } from "@/runtime/diagnostics";
import { useAuthStore } from "@/stores/auth-store";

function tryInit(options: BrowserOptions): void {
  const flavor = selectSentryFlavor();
  if (flavor.getClientEnabled()) return;
  flavor.init(options);
}

function tryClose(): void {
  void selectSentryFlavor().close();
}

/**
 * Apply the current consent value to the Sentry client — init if consented
 * and not yet running, close if not consented and currently running.
 * Idempotent when consent matches the current client state.
 */
export function syncSentryClient(options: BrowserOptions): void {
  if (!options.dsn) return;
  if (diagnosticsConsentGranted()) {
    tryInit(options);
  } else {
    tryClose();
  }
}

/**
 * Install listeners so both Sentry clients (browser + Electron main) re-apply
 * the composed gate whenever an input changes: the effective reporting gate
 * (`device:diagnostics_reporting`, cross-tab via the native `storage` event,
 * same-tab via the custom event from `setLocalSetting`) or the platform session
 * transitioning in/out of a confirmed-live state.
 *
 * Returns a cleanup function that removes both listeners.
 */
export function installSentryControlListeners(
  options: BrowserOptions,
): () => void {
  const sync = () => {
    syncSentryClient(options);
    syncDiagnosticsToMain(diagnosticsConsentGranted());
  };
  const stopDeviceWatch = watchDeviceSetting("diagnosticsReporting", sync);
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
