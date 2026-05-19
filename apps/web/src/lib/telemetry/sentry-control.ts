import * as Sentry from "@sentry/react";

/**
 * Gates the browser-side Sentry client on the user's Share Diagnostics
 * toggle (`vellum_share_diagnostics`), matching the macOS app's behavior
 * in `Features/Onboarding/ImproveExperienceStepView.swift` — `startSentry()`
 * is only called when the user has opted in.
 *
 * Strict opt-in semantics (mirrors macOS `@AppStorage("sendDiagnostics")`
 * gate at the `saveAndContinue()` call site, NOT the UI default):
 *   - stored `"true"`  → Sentry ON  (explicit consent from onboarding Start
 *                                     or from `/settings/privacy`)
 *   - stored `"false"` → Sentry OFF (explicit opt-out)
 *   - absent           → Sentry OFF (no consent on record yet)
 *
 * Server and edge Sentry runtimes are NOT gated by this module — they run
 * outside the browser, catch infrastructure errors rather than per-user
 * events, and have no access to `localStorage`. If a future change wants
 * to propagate user consent to the server, it would need to carry the flag
 * in a cookie or header.
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
    // Storage disabled / private mode — don't report silently.
    return false;
  }
}

function tryInit(options: Sentry.BrowserOptions): void {
  // A client bound to the current scope may be a live one (init already
  // ran) OR a closed one left behind by `tryClose` (Sentry v10's
  // `client.close()` flushes + disables but does NOT unbind the client
  // from the scope — `getClient()` keeps returning it). Only skip when
  // the existing client still accepts events.
  const existing = Sentry.getClient();
  if (existing && existing.getOptions().enabled !== false) return;
  Sentry.init({ ...options, enabled: true });
}

function tryClose(): void {
  const client = Sentry.getClient();
  if (!client) return;
  // Fire-and-forget: `close` flushes pending events; if the page is about
  // to unload we'd miss some, acceptable for an opt-out.
  void client.close(2000);
  // Unbind so `tryInit` will create a fresh client on the next consent
  // flip. Without this, the closed client lingers on the scope and the
  // "existing && enabled" guard above would stay true forever.
  Sentry.getCurrentScope().setClient(undefined);
}

/**
 * Apply the current consent value to the Sentry client — init if consented
 * and not yet running, close if not consented and currently running.
 * Safe to call on every state change; idempotent when consent matches the
 * current client state.
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
 * dispatched from `@/lib/onboarding/prefs`'s `writeBooleanPref`).
 *
 * Returns a cleanup function that removes both listeners, for symmetry
 * with the module's other register-style APIs. The browser entrypoint
 * (`instrumentation-client.ts`) doesn't actually call it, since the listeners
 * should live for the page's lifetime.
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
