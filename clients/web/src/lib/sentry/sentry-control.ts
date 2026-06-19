import type { BrowserOptions } from "@sentry/react";

import { selectSentryFlavor } from "@/lib/sentry/flavor";
import { getDeviceBool, watchDeviceSetting } from "@/utils/device-settings";

/**
 * Gates the browser-side Sentry client on the effective diagnostics-reporting
 * gate (`device:diagnostics_reporting`), matching the macOS app's behavior.
 *
 * The gate is the saved Share Diagnostics preference AND a current privacy-
 * consent version, so a stale-version record stops reporting until re-accept
 * without losing the saved opt-in. It is written by the consent-resolution
 * paths (`setDiagnosticsReportingGate`).
 *
 * Strict opt-in semantics:
 *   - stored "true"  → Sentry ON  (current consent)
 *   - stored "false" → Sentry OFF (opt-out or stale version)
 *   - absent         → Sentry OFF (no consent on record yet)
 *
 * SDK access is dispatched through `selectSentryFlavor()` so each surface
 * (web/electron renderer, capacitor) can supply its own implementation.
 *
 * Reference: https://docs.sentry.io/platforms/javascript/guides/react/configuration/options/
 */

function readConsent(): boolean {
  return getDeviceBool("diagnosticsReporting", false);
}

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
  if (readConsent()) {
    tryInit(options);
  } else {
    tryClose();
  }
}

/**
 * Install listeners so the Sentry client turns on/off whenever the effective
 * reporting gate changes — covering cross-tab writes (via the native `storage`
 * event) and same-tab writes (via the custom event dispatched by
 * `setLocalSetting`).
 *
 * Returns a cleanup function that removes both listeners.
 */
export function installSentryControlListeners(
  options: BrowserOptions,
): () => void {
  return watchDeviceSetting("diagnosticsReporting", () => {
    syncSentryClient(options);
  });
}
