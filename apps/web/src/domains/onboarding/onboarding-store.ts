/**
 * Zustand store for onboarding boolean preferences.
 *
 * Replaces the hand-rolled `useSyncExternalStore` + per-key listener
 * boilerplate that previously lived in `prefs.ts`. Public hooks
 * (`useShareAnalytics`, `useShareDiagnostics`, `useTosAccepted`,
 * `useAiDataConsent`, `useOnboardingCompleted`) remain in `prefs.ts`
 * as thin wrappers around `.use.field()` selectors + setter actions.
 *
 * **Storage model — strict per-key, with absence semantics preserved:**
 *
 * Each field maps 1:1 to its existing localStorage key:
 *
 * | Field             | localStorage key              | Read by                |
 * |-------------------|-------------------------------|------------------------|
 * | `shareAnalytics`  | `vellum_share_analytics`      | privacy page (direct)  |
 * | `shareDiagnostics`| `vellum_share_diagnostics`    | privacy page + Sentry  |
 * | `tosAccepted`     | `onboarding.tosAccepted`      | onboarding pages       |
 * | `aiDataConsent`   | `onboarding.aiDataConsent`    | onboarding pages       |
 * | `completed`       | `onboarding.completed`        | onboarding + chat gate |
 *
 * We deliberately do **not** use Zustand's `persist` middleware here.
 * `persist` writes the full state envelope on every update, which would
 * write `vellum_share_diagnostics = "true"` to localStorage whenever any
 * unrelated flag (e.g. `tosAccepted`) changed — silently flipping Sentry
 * consent from "absent / opt-out" to "true / explicit consent" without
 * the user ever toggling the Share Diagnostics control. The Sentry gate
 * (`apps/web/src/lib/sentry/sentry-control.ts`) treats absence as the
 * privacy-safe default and ANY explicit `"true"` as opt-in.
 *
 * Instead, each setter writes only its own key via `setLocalSetting`,
 * preserving the original per-key write semantics. Initial state is
 * read once on module load via `computeInitialFromLS()`.
 *
 * **Cross-tab + cross-surface sync:**
 *
 * - `setLocalSetting` fires a native `storage` event in other tabs and
 *   a same-tab `vellum:pref-changed` CustomEvent. The store registers
 *   listeners for both and updates its state from localStorage whenever
 *   any of the five tracked keys changes elsewhere.
 * - That way a write from the privacy page (same tab, different
 *   surface) and a write from another tab both flow back into the
 *   store and re-render subscribed components.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";
import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/domains/settings/local-settings.js";

// ---------------------------------------------------------------------------
// Storage keys — shared with other surfaces, do NOT rename
// ---------------------------------------------------------------------------

/** Shared with `/settings/privacy`. */
const KEY_SHARE_ANALYTICS = "vellum_share_analytics";
/** Shared with `/settings/privacy` and the Sentry consent gate. */
const KEY_SHARE_DIAGNOSTICS = "vellum_share_diagnostics";
/** Onboarding-only: Terms of Service accepted. */
const KEY_TOS_ACCEPTED = "onboarding.tosAccepted";
/** Onboarding-only: explicit AI-data-sharing consent (Apple Guideline 5.1.2(i)). */
const KEY_AI_DATA_CONSENT = "onboarding.aiDataConsent";
/** Onboarding-only: completed flag (gates pre-chat / chat routes). */
const KEY_COMPLETED = "onboarding.completed";

const PREF_CHANGED_EVENT = "vellum:pref-changed";

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
  /**
   * Reset the three per-user onboarding flags (tos, ai-consent, completed)
   * to defaults and remove them from localStorage. Leaves the device-level
   * `shareAnalytics` / `shareDiagnostics` flags alone — they're framed as
   * device prefs and carry over between user accounts on a shared browser.
   */
  resetOnboardingFlags: () => void;
}

export type OnboardingStore = OnboardingState & OnboardingActions;

// ---------------------------------------------------------------------------
// LS helpers
// ---------------------------------------------------------------------------

function readBooleanFromLS(key: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = getLocalSetting(key, String(defaultValue));
    if (raw === "true") return true;
    if (raw === "false") return false;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

function computeInitialFromLS(): OnboardingState {
  return {
    shareAnalytics: readBooleanFromLS(KEY_SHARE_ANALYTICS, true),
    shareDiagnostics: readBooleanFromLS(KEY_SHARE_DIAGNOSTICS, true),
    tosAccepted: readBooleanFromLS(KEY_TOS_ACCEPTED, false),
    aiDataConsent: readBooleanFromLS(KEY_AI_DATA_CONSENT, false),
    completed: readBooleanFromLS(KEY_COMPLETED, false),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useOnboardingStoreBase = create<OnboardingStore>()((set) => ({
  ...computeInitialFromLS(),

  setShareAnalytics: (value) => {
    set({ shareAnalytics: value });
    setLocalSetting(KEY_SHARE_ANALYTICS, String(value));
  },
  setShareDiagnostics: (value) => {
    set({ shareDiagnostics: value });
    setLocalSetting(KEY_SHARE_DIAGNOSTICS, String(value));
  },
  setTosAccepted: (value) => {
    set({ tosAccepted: value });
    setLocalSetting(KEY_TOS_ACCEPTED, String(value));
  },
  setAiDataConsent: (value) => {
    set({ aiDataConsent: value });
    setLocalSetting(KEY_AI_DATA_CONSENT, String(value));
  },
  setOnboardingCompleted: (value) => {
    set({ completed: value });
    setLocalSetting(KEY_COMPLETED, String(value));
  },
  resetOnboardingFlags: () => {
    set({
      tosAccepted: false,
      aiDataConsent: false,
      completed: false,
    });
    // Remove (not "set to false") to match the prior `clearOnboardingFlags`
    // behavior — these keys default to false on read when absent, so
    // removing them is equivalent to clearing them. Keeps localStorage
    // tidy across logout cycles.
    removeLocalSetting(KEY_TOS_ACCEPTED);
    removeLocalSetting(KEY_AI_DATA_CONSENT);
    removeLocalSetting(KEY_COMPLETED);
  },
}));

export const useOnboardingStore = createSelectors(useOnboardingStoreBase);

// ---------------------------------------------------------------------------
// Cross-tab + cross-surface sync
// ---------------------------------------------------------------------------

function syncFieldFromLS(key: string): void {
  const field = KEY_TO_FIELD.get(key);
  if (!field) return;
  // Default mirrors the field's defined default — keeps absence semantics
  // intact (e.g. an absent `vellum_share_diagnostics` reads as `true` here
  // for UI display, while sentry-control.ts independently treats absence
  // as opt-out for its own consent gate).
  const defaults: Record<keyof OnboardingState, boolean> = {
    shareAnalytics: true,
    shareDiagnostics: true,
    tosAccepted: false,
    aiDataConsent: false,
    completed: false,
  };
  const next = readBooleanFromLS(key, defaults[field]);
  useOnboardingStoreBase.setState({ [field]: next } as Partial<OnboardingState>);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key && KEY_TO_FIELD.has(event.key)) {
      syncFieldFromLS(event.key);
    }
  });

  window.addEventListener(PREF_CHANGED_EVENT, (event) => {
    const detail = (event as CustomEvent<{ key?: string | null }>).detail;
    if (detail?.key && KEY_TO_FIELD.has(detail.key)) {
      syncFieldFromLS(detail.key);
    }
  });
}
