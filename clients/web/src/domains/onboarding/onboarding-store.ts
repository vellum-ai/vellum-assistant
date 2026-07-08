/**
 * Zustand store for onboarding boolean preferences.
 *
 * **Device-persisted fields** (`shareAnalytics`, `shareDiagnostics`) are
 * written to `device:` localStorage keys on every setter call and synced
 * across tabs via `watchSetting`. They survive logout.
 *
 * **In-memory-only fields** (`tosAccepted`, `privacyConsent`,
 * `analyticsConsentCurrent`, `diagnosticsConsentCurrent`) start `false` and
 * are populated on session sync (e.g. `restoreConsentForUser`, called from
 * the auth store once the user id is known). Persistence to durable per-user
 * device keys is handled by `persistConsentForUser` in
 * `onboarding-cleanup.ts`. `consentHydrated` (also in-memory-only) records
 * that a session sync — or an explicit user acceptance — has populated those
 * flags, so route guards can distinguish "not yet loaded" from a genuine
 * `false`.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import {
  getLocalBool,
  setLocalBool,
  watchSetting,
} from "@/utils/local-settings";
import { deviceKey } from "@/utils/device-settings";

// ---------------------------------------------------------------------------
// Storage keys — device-persisted fields only
// ---------------------------------------------------------------------------

const KEY_SHARE_ANALYTICS = deviceKey("shareAnalytics");
const KEY_SHARE_DIAGNOSTICS = deviceKey("shareDiagnostics");

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface OnboardingState {
  shareAnalytics: boolean;
  shareDiagnostics: boolean;
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
  setShareAnalytics: (value: boolean) => void;
  setShareDiagnostics: (value: boolean) => void;
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
  shareAnalytics: getLocalBool(KEY_SHARE_ANALYTICS, true),
  shareDiagnostics: getLocalBool(KEY_SHARE_DIAGNOSTICS, true),
  tosAccepted: false,
  privacyConsent: false,
  analyticsConsentCurrent: false,
  diagnosticsConsentCurrent: false,
  consentHydrated: false,

  setShareAnalytics: (value) => {
    set({ shareAnalytics: value });
    setLocalBool(KEY_SHARE_ANALYTICS, value);
  },
  setShareDiagnostics: (value) => {
    set({ shareDiagnostics: value });
    // Writes only the saved preference. The effective reporting gate
    // (`device:diagnostics_reporting`) — which actually drives the Sentry
    // clients via the `sentry-control.ts` watcher — is written separately by
    // the consent chokepoint (`setDiagnosticsReportingGate`).
    setLocalBool(KEY_SHARE_DIAGNOSTICS, value);
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

const SYNCED_DEFAULTS: Record<string, boolean> = {
  shareAnalytics: true,
  shareDiagnostics: true,
};

for (const [key, field] of SYNCED_KEYS) {
  watchSetting(key, () => {
    const next = getLocalBool(key, SYNCED_DEFAULTS[field] ?? false);
    useOnboardingStoreBase.setState({ [field]: next } as Partial<OnboardingState>);
  });
}
