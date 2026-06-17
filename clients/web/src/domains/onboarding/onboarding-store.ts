/**
 * Zustand store for onboarding boolean preferences.
 *
 * **Device-persisted fields** (`shareAnalytics`, `shareDiagnostics`,
 * `shareProductImprovement`) are written to `device:` localStorage keys on
 * every setter call and synced across tabs via `watchSetting`. They survive
 * logout.
 *
 * **In-memory-only fields** (`tosAccepted`, `aiDataConsent`) start `false`
 * and are populated by `restoreConsentForUser` (called from the auth store
 * once the user id is known). Persistence to durable per-user device keys
 * is handled by `persistConsentForUser` in `onboarding-cleanup.ts`.
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
const KEY_SHARE_PRODUCT_IMPROVEMENT = deviceKey("shareProductImprovement");

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface OnboardingState {
  shareAnalytics: boolean;
  shareDiagnostics: boolean;
  shareProductImprovement: boolean;
  tosAccepted: boolean;
  aiDataConsent: boolean;
}

export interface OnboardingActions {
  setShareAnalytics: (value: boolean) => void;
  setShareDiagnostics: (value: boolean) => void;
  setShareProductImprovement: (value: boolean) => void;
  setTosAccepted: (value: boolean) => void;
  setAiDataConsent: (value: boolean) => void;
}

export type OnboardingStore = OnboardingState & OnboardingActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useOnboardingStoreBase = create<OnboardingStore>()((set) => ({
  shareAnalytics: getLocalBool(KEY_SHARE_ANALYTICS, true),
  shareDiagnostics: getLocalBool(KEY_SHARE_DIAGNOSTICS, true),
  shareProductImprovement: getLocalBool(KEY_SHARE_PRODUCT_IMPROVEMENT, true),
  tosAccepted: false,
  aiDataConsent: false,

  setShareAnalytics: (value) => {
    set({ shareAnalytics: value });
    setLocalBool(KEY_SHARE_ANALYTICS, value);
  },
  setShareDiagnostics: (value) => {
    set({ shareDiagnostics: value });
    setLocalBool(KEY_SHARE_DIAGNOSTICS, value);
  },
  setShareProductImprovement: (value) => {
    set({ shareProductImprovement: value });
    setLocalBool(KEY_SHARE_PRODUCT_IMPROVEMENT, value);
  },
  setTosAccepted: (value) => {
    set({ tosAccepted: value });
  },
  setAiDataConsent: (value) => {
    set({ aiDataConsent: value });
  },
}));

export const useOnboardingStore = createSelectors(useOnboardingStoreBase);

// ---------------------------------------------------------------------------
// Cross-tab sync — device-persisted fields only
// ---------------------------------------------------------------------------

const SYNCED_KEYS: ReadonlyMap<string, keyof OnboardingState> = new Map([
  [KEY_SHARE_ANALYTICS, "shareAnalytics"],
  [KEY_SHARE_DIAGNOSTICS, "shareDiagnostics"],
  [KEY_SHARE_PRODUCT_IMPROVEMENT, "shareProductImprovement"],
]);

const SYNCED_DEFAULTS: Record<string, boolean> = {
  shareAnalytics: true,
  shareDiagnostics: true,
  shareProductImprovement: true,
};

for (const [key, field] of SYNCED_KEYS) {
  watchSetting(key, () => {
    const next = getLocalBool(key, SYNCED_DEFAULTS[field] ?? false);
    useOnboardingStoreBase.setState({ [field]: next } as Partial<OnboardingState>);
  });
}
