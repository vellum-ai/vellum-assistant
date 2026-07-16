/**
 * Zustand store for onboarding boolean preferences.
 *
 * **Device-persisted fields** (`shareAnalytics`, `shareDiagnostics`) are
 * tri-state: `null` means "never asked" (no device key), a boolean is an
 * explicit user choice. Setters write the `device:` localStorage key for an
 * explicit boolean and remove it for `null`, and the fields sync across tabs
 * via `watchSetting`. They survive logout.
 *
 * **In-memory-only fields** (`tosAccepted`, `privacyConsent`,
 * `analyticsConsentCurrent`, `diagnosticsConsentCurrent`) start `false` and
 * are populated on session sync (e.g. `restoreConsentForUser`, called from
 * the auth store once the user id is known). Persistence to durable per-user
 * device keys is handled by `persistConsentForUser` in
 * `consent-persistence.ts`. `consentHydrated` (also in-memory-only) records
 * that a session sync — or an explicit user acceptance — has populated those
 * flags, so route guards can distinguish "not yet loaded" from a genuine
 * `false`.
 *
 * **Server-effective verdicts** (`serverAnalyticsEffective`,
 * `serverDiagnosticsEffective`) are the platform-computed effective consent
 * values adopted at sync; `null` means no successful sync with a server
 * record yet. In-memory only — never device-persisted, never cross-tab
 * synced — the data-capture gates read them alongside the local tri-state.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import {
  getLocalBoolOrNull,
  removeLocalSetting,
  setLocalBool,
  watchSetting,
} from "@/utils/local-settings";
import { deviceKey } from "@/utils/device-settings";

// ---------------------------------------------------------------------------
// Storage keys — device-persisted fields only
// ---------------------------------------------------------------------------

const KEY_SHARE_ANALYTICS = deviceKey("shareAnalytics");
const KEY_SHARE_DIAGNOSTICS = deviceKey("shareDiagnostics");

/** Explicit boolean → persist; `null` (never asked) → remove the key. */
function persistShareChoice(key: string, value: boolean | null): void {
  if (value === null) {
    removeLocalSetting(key);
  } else {
    setLocalBool(key, value);
  }
}

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface OnboardingState {
  /** `null` = never asked; a boolean is an explicit user choice. */
  shareAnalytics: boolean | null;
  /** `null` = never asked; a boolean is an explicit user choice. */
  shareDiagnostics: boolean | null;
  /**
   * Platform-computed effective analytics consent, adopted at sync; `null`
   * before the first sync that saw a server record.
   */
  serverAnalyticsEffective: boolean | null;
  /**
   * PER-TAB by design (like `serverAnalyticsEffective` above): a verdict
   * adopted in one tab reaches others on their own focus/backstop refresh.
   * The bounded staleness is acceptable because the platform's ingest gate
   * is the enforcement point — uploads from a stale tab under a server
   * opt-out are dropped server-side; the client gate is an efficiency.
   *
   * A local explicit analytics opt-in whose server write has not yet been
   * reflected by a sync. Lets the emit gate re-enable immediately on opt-in
   * without letting server-ADOPTED raw values bypass a divergent effective
   * verdict. Cleared whenever a sync adopts server state. In-memory only.
   */
  pendingAnalyticsOptIn: boolean;
  /** See {@link serverAnalyticsEffective}; the diagnostics verdict. */
  serverDiagnosticsEffective: boolean | null;
  tosAccepted: boolean;
  privacyConsent: boolean;
  analyticsConsentCurrent: boolean;
  diagnosticsConsentCurrent: boolean;
  /**
   * Whether the consent flags above reflect a completed session sync (or an
   * explicit user acceptance) rather than their unhydrated boot defaults.
   */
  consentHydrated: boolean;
}

export interface OnboardingActions {
  setShareAnalytics: (value: boolean | null) => void;
  setShareDiagnostics: (value: boolean | null) => void;
  setServerAnalyticsEffective: (value: boolean | null) => void;
  setPendingAnalyticsOptIn: (value: boolean) => void;
  setServerDiagnosticsEffective: (value: boolean | null) => void;
  setTosAccepted: (value: boolean) => void;
  setPrivacyConsent: (value: boolean) => void;
  setAnalyticsConsentCurrent: (value: boolean) => void;
  setDiagnosticsConsentCurrent: (value: boolean) => void;
  setConsentHydrated: (value: boolean) => void;
}

export type OnboardingStore = OnboardingState & OnboardingActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useOnboardingStoreBase = create<OnboardingStore>()((set) => ({
  shareAnalytics: getLocalBoolOrNull(KEY_SHARE_ANALYTICS),
  shareDiagnostics: getLocalBoolOrNull(KEY_SHARE_DIAGNOSTICS),
  serverAnalyticsEffective: null,
  pendingAnalyticsOptIn: false,
  serverDiagnosticsEffective: null,
  tosAccepted: false,
  privacyConsent: false,
  analyticsConsentCurrent: false,
  diagnosticsConsentCurrent: false,
  consentHydrated: false,

  setShareAnalytics: (value) => {
    set({ shareAnalytics: value });
    persistShareChoice(KEY_SHARE_ANALYTICS, value);
  },
  setShareDiagnostics: (value) => {
    set({ shareDiagnostics: value });
    // Writes only the saved preference. The effective reporting gate
    // (`device:diagnostics_reporting`) — which actually drives the Sentry
    // clients via the `sentry-control.ts` watcher — is written solely by the
    // consent chokepoints in `lib/consent/diagnostics-consent.ts`.
    persistShareChoice(KEY_SHARE_DIAGNOSTICS, value);
  },
  // In-memory only: the server verdicts are re-adopted on every sync, so
  // persisting them would just serve a stale verdict across reloads.
  setPendingAnalyticsOptIn: (value) => {
    set({ pendingAnalyticsOptIn: value });
  },
  setServerAnalyticsEffective: (value) => {
    set({ serverAnalyticsEffective: value });
  },
  setServerDiagnosticsEffective: (value) => {
    set({ serverDiagnosticsEffective: value });
  },
  setTosAccepted: (value) => {
    set({ tosAccepted: value });
  },
  setPrivacyConsent: (value) => {
    set({ privacyConsent: value });
  },
  setAnalyticsConsentCurrent: (value) => {
    set({ analyticsConsentCurrent: value });
  },
  setDiagnosticsConsentCurrent: (value) => {
    set({ diagnosticsConsentCurrent: value });
  },
  setConsentHydrated: (value) => {
    set({ consentHydrated: value });
  },
}));

export const useOnboardingStore = createSelectors(useOnboardingStoreBase);

// ---------------------------------------------------------------------------
// Cross-tab sync — device-persisted fields only
// ---------------------------------------------------------------------------

const SYNCED_KEYS: ReadonlyMap<string, keyof OnboardingState> = new Map([
  [KEY_SHARE_ANALYTICS, "shareAnalytics"],
  [KEY_SHARE_DIAGNOSTICS, "shareDiagnostics"],
]);

for (const [key, field] of SYNCED_KEYS) {
  watchSetting(key, () => {
    useOnboardingStoreBase.setState({
      [field]: getLocalBoolOrNull(key),
    } as Partial<OnboardingState>);
  });
}
