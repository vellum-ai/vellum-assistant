import * as Sentry from "@sentry/react";

import { getDeviceBool, watchDeviceSetting } from "@/utils/device-settings";

/**
 * Gates the browser-side Sentry client on the user's Share Diagnostics
 * toggle (`device:share_diagnostics`), matching the macOS app's behavior.
 *
 * Strict opt-in semantics:
 *   - stored "true"  → Sentry ON  (explicit consent)
 *   - stored "false" → Sentry OFF (explicit opt-out)
 *   - absent         → Sentry OFF (no consent on record yet)
 *
 * Reference: https://docs.sentry.io/platforms/javascript/guides/react/configuration/options/
 */

function readConsent(): boolean {
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
  if (readConsent()) {
    tryInit(options);
  } else {
    tryClose();
  }
}

/**
 * Install listeners so the Sentry client turns on/off whenever the user
 * flips the Share Diagnostics toggle — covering cross-tab writes (via the
 * native `storage` event) and same-tab writes (via the custom event
 * dispatched by `setLocalSetting`).
 *
 * Returns a cleanup function that removes both listeners.
 */
export function installSentryControlListeners(
  options: Sentry.BrowserOptions,
): () => void {
  return watchDeviceSetting("shareDiagnostics", () => {
    syncSentryClient(options);
  });
}
