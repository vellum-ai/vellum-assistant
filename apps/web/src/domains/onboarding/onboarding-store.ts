/**
 * Zustand store for onboarding boolean preferences.
 *
 * Owns the five onboarding/privacy flags consumed by the privacy page,
 * the onboarding pages, the chat-gate, and Sentry. `prefs.ts` exposes
 * thin hooks (`useShareAnalytics`, `useShareDiagnostics`,
 * `useTosAccepted`, `useAiDataConsent`, `useOnboardingCompleted`) that
 * wrap `.use.field()` selectors and setter actions on this store.
 *
 * **Storage model — strict per-key, with absence semantics preserved:**
 *
 * Each field maps 1:1 to its own localStorage key:
 *
 * | Field             | localStorage key              | Read by                |
 * |-------------------|-------------------------------|------------------------|
 * | `shareAnalytics`  | `device:share_analytics`      | privacy page (direct)  |
 * | `shareDiagnostics`| `device:share_diagnostics`    | privacy page + Sentry  |
 * | `tosAccepted`     | `vellum:onboarding:tosAccepted`  | onboarding pages       |
 * | `aiDataConsent`   | `vellum:onboarding:aiDataConsent`| onboarding pages       |
 * | `completed`       | `vellum:onboarding:completed`    | onboarding + chat gate |
 *
 * We deliberately do **not** use Zustand's `persist` middleware here.
 * `persist` writes the full state envelope on every update, which would
 * write `device:share_diagnostics = "true"` to localStorage whenever any
 * unrelated flag (e.g. `tosAccepted`) changed — silently flipping Sentry
 * consent from "absent / opt-out" to "true / explicit consent" without
 * the user ever toggling the Share Diagnostics control. The Sentry gate
 * (`apps/web/src/lib/sentry/sentry-control.ts`) treats absence as the
 * privacy-safe default and ANY explicit `"true"` as opt-in.
 *
 * Instead, each setter writes only its own key via `setLocalBool`,
 * so a field that was never explicitly set stays absent in localStorage
 * — keeping the privacy-safe default intact. Initial state is read once
 * on module load via `computeInitialFromLS()`.
 *
 * **Cross-tab + cross-surface sync:**
 *
 * - `setLocalBool` fires a native `storage` event in other tabs and
 *   a same-tab `vellum:pref-changed` CustomEvent. The store registers
 *   `watchSetting` listeners for each tracked key and updates its state
 *   from localStorage whenever any of the five keys changes elsewhere.
 * - That way a write from the privacy page (same tab, different
 *   surface) and a write from another tab both flow back into the
 *   store and re-render subscribed components.
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
import {
  KEY_TOS_ACCEPTED,
  KEY_AI_DATA_CONSENT,
  KEY_COMPLETED,
} from "@/utils/onboarding-cleanup";

// ---------------------------------------------------------------------------
// Storage keys — shared with other surfaces
// ---------------------------------------------------------------------------

/** Shared with `/settings/privacy`. */
const KEY_SHARE_ANALYTICS = deviceKey("shareAnalytics");
/** Shared with `/settings/privacy` and the Sentry consent gate. */
const KEY_SHARE_DIAGNOSTICS = deviceKey("shareDiagnostics");

/**
 * Lookup table from localStorage key → which state field to refresh.
 * Used by the cross-tab / cross-surface listeners to map an external
 * write back into the store.
 */
const KEY_TO_FIELD: ReadonlyMap<string, keyof OnboardingState> = new Map([
  [KEY_SHARE_ANALYTICS, "shareAnalytics" as const],
  [KEY_SHARE_DIAGNOSTICS, "shareDiagnostics" as const],
  [KEY_TOS_ACCEPTED, "tosAccepted" as const],
  [KEY_AI_DATA_CONSENT, "aiDataConsent" as const],
  [KEY_COMPLETED, "completed" as const],
]);

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface OnboardingState {
  /** Share anonymous product analytics. Default `true`. */
  shareAnalytics: boolean;
  /** Share crash reports + diagnostics (Sentry consent). Default `true` UI-wise; **absent in LS means OFF** per the Sentry gate. */
  shareDiagnostics: boolean;
  /** User accepted Terms of Service. Default `false`. */
  tosAccepted: boolean;
  /** Explicit AI-data-sharing consent. Default `false`. */
  aiDataConsent: boolean;
  /** Onboarding flow completed. Default `false`. */
  completed: boolean;
}

export interface OnboardingActions {
  setShareAnalytics: (value: boolean) => void;
  setShareDiagnostics: (value: boolean) => void;
  setTosAccepted: (value: boolean) => void;
  setAiDataConsent: (value: boolean) => void;
  setOnboardingCompleted: (value: boolean) => void;
}

export type OnboardingStore = OnboardingState & OnboardingActions;

// ---------------------------------------------------------------------------
// LS helpers
// ---------------------------------------------------------------------------

const FIELD_DEFAULTS: Record<keyof OnboardingState, boolean> = {
  shareAnalytics: true,
  shareDiagnostics: true,
  tosAccepted: false,
  aiDataConsent: false,
  completed: false,
};

function computeInitialFromLS(): OnboardingState {
  return {
    shareAnalytics: getLocalBool(KEY_SHARE_ANALYTICS, true),
    shareDiagnostics: getLocalBool(KEY_SHARE_DIAGNOSTICS, true),
    tosAccepted: getLocalBool(KEY_TOS_ACCEPTED, false),
    aiDataConsent: getLocalBool(KEY_AI_DATA_CONSENT, false),
    completed: getLocalBool(KEY_COMPLETED, false),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useOnboardingStoreBase = create<OnboardingStore>()((set) => ({
  ...computeInitialFromLS(),

  setShareAnalytics: (value) => {
    set({ shareAnalytics: value });
    setLocalBool(KEY_SHARE_ANALYTICS, value);
  },
  setShareDiagnostics: (value) => {
    set({ shareDiagnostics: value });
    setLocalBool(KEY_SHARE_DIAGNOSTICS, value);
  },
  setTosAccepted: (value) => {
    set({ tosAccepted: value });
    setLocalBool(KEY_TOS_ACCEPTED, value);
  },
  setAiDataConsent: (value) => {
    set({ aiDataConsent: value });
    setLocalBool(KEY_AI_DATA_CONSENT, value);
  },
  setOnboardingCompleted: (value) => {
    set({ completed: value });
    setLocalBool(KEY_COMPLETED, value);
  },
}));

export const useOnboardingStore = createSelectors(useOnboardingStoreBase);

// ---------------------------------------------------------------------------
// Cross-tab + cross-surface sync
// ---------------------------------------------------------------------------

function syncFieldFromLS(key: string): void {
  const field = KEY_TO_FIELD.get(key);
  if (!field) return;
  const next = getLocalBool(key, FIELD_DEFAULTS[field]);
  useOnboardingStoreBase.setState({ [field]: next } as Partial<OnboardingState>);
}

for (const key of KEY_TO_FIELD.keys()) {
  watchSetting(key, () => syncFieldFromLS(key));
}
