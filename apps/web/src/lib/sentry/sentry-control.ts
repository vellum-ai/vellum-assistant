import * as Sentry from "@sentry/react";

/**
 * Gates the browser-side Sentry client on the user's Share Diagnostics
 * toggle (`vellum_share_diagnostics`), matching the macOS app's behavior.
 *
 * Strict opt-in semantics:
 *   - stored "true"  → Sentry ON  (explicit consent)
 *   - stored "false" → Sentry OFF (explicit opt-out)
 *   - absent         → Sentry OFF (no consent on record yet)
 *
 * Reference: https://docs.sentry.io/platforms/javascript/guides/react/configuration/options/
 */

const STORAGE_KEY = "vellum_share_diagnostics";
const PREF_CHANGED_EVENT = "vellum:pref-changed";

export interface PrefChangedEventDetail {
  key: string;
  value: string;
}

function readConsent(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
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
 * dispatched from the prefs utility).
 *
 * Returns a cleanup function that removes both listeners.
 */
export function installSentryControlListeners(
  options: Sentry.BrowserOptions,
): () => void {
  if (typeof window === "undefined") return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    syncSentryClient(options);
  };
  const onPrefChanged = (event: Event) => {
    const detail = (event as CustomEvent<PrefChangedEventDetail>).detail;
    if (detail?.key !== STORAGE_KEY) return;
    syncSentryClient(options);
  };

  window.addEventListener("storage", onStorage);
  window.addEventListener(PREF_CHANGED_EVENT, onPrefChanged);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(PREF_CHANGED_EVENT, onPrefChanged);
  };
}
