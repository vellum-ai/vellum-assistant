/**
 * Zustand store for onboarding boolean preferences.
 *
 * Replaces the hand-rolled `useSyncExternalStore` + per-key listener
 * boilerplate that previously lived in `prefs.ts`. Public hooks
 * (`useShareAnalytics`, `useShareDiagnostics`, `useTosAccepted`,
 * `useAiDataConsent`, `useOnboardingCompleted`) remain in `prefs.ts`
 * as thin wrappers around `.use.field()` selectors + setter actions.
 *
 * **Storage model — per-key, not single-blob:**
 *
 * The persist middleware uses a custom storage adapter that maps each
 * field of the store to the **exact existing localStorage key** the old
 * implementation used:
 *
 * | Field             | localStorage key              | Read by                |
 * |-------------------|-------------------------------|------------------------|
 * | `shareAnalytics`  | `vellum_share_analytics`      | privacy page (direct)  |
 * | `shareDiagnostics`| `vellum_share_diagnostics`    | privacy page + Sentry  |
 * | `tosAccepted`     | `onboarding.tosAccepted`      | onboarding pages       |
 * | `aiDataConsent`   | `onboarding.aiDataConsent`    | onboarding pages       |
 * | `completed`       | `onboarding.completed`        | onboarding + chat gate |
 *
 * Per-key storage is non-negotiable: the privacy settings page
 * (`apps/web/src/domains/settings/pages/privacy-page.tsx`) and the
 * Sentry consent gate (`apps/web/src/lib/sentry/sentry-control.ts`)
 * both read these keys directly via `getLocalSetting`. Migrating the
 * onboarding side to a single combined JSON blob would silently
 * desynchronise those surfaces.
 *
 * **Cross-tab + cross-surface sync:**
 *
 * - `setLocalSetting` fires a native `storage` event in other tabs and
 *   a same-tab `vellum:pref-changed` CustomEvent. The store registers
 *   listeners for both and calls `persist.rehydrate()` whenever any of
 *   its five tracked keys changes elsewhere.
 * - That way a write from the privacy page (same tab, different
 *   surface) and a write from another tab both flow back into the
 *   store and re-render subscribed components.
 *
 * Reference:
 * - {@link https://zustand.docs.pmnd.rs/}
 * - {@link https://zustand.docs.pmnd.rs/integrations/persisting-store-data}
 */

import { create } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";

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

const WATCHED_KEYS: ReadonlySet<string> = new Set([
  KEY_SHARE_ANALYTICS,
  KEY_SHARE_DIAGNOSTICS,
  KEY_TOS_ACCEPTED,
  KEY_AI_DATA_CONSENT,
  KEY_COMPLETED,
]);

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface OnboardingState {
  /** Share anonymous product analytics. Default `true`. */
  shareAnalytics: boolean;
  /** Share crash reports + diagnostics (Sentry consent). Default `true`. */
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
   * to defaults. Leaves the device-level `shareAnalytics` /
   * `shareDiagnostics` flags alone — they're framed as device prefs and
   * carry over between user accounts on a shared browser.
   */
  resetOnboardingFlags: () => void;
}

export type OnboardingStore = OnboardingState & OnboardingActions;

// ---------------------------------------------------------------------------
// Custom per-key storage adapter
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

/**
 * Persist middleware adapter that maps the store's combined state to per-key
 * localStorage entries — the existing keys other surfaces already read.
 *
 * Returning the full envelope from `getItem` lets Zustand hydrate normally
 * even though the underlying storage is split across five keys. `setItem`
 * writes each key on every state change, which is idempotent.
 */
const PERSIST_STORE_NAME = "vellum:onboarding-prefs";

const perKeyStorage: PersistStorage<OnboardingState> = {
  getItem: () => {
    return {
      state: {
        shareAnalytics: readBooleanFromLS(KEY_SHARE_ANALYTICS, true),
        shareDiagnostics: readBooleanFromLS(KEY_SHARE_DIAGNOSTICS, true),
        tosAccepted: readBooleanFromLS(KEY_TOS_ACCEPTED, false),
        aiDataConsent: readBooleanFromLS(KEY_AI_DATA_CONSENT, false),
        completed: readBooleanFromLS(KEY_COMPLETED, false),
      },
      version: 0,
    };
  },
  setItem: (_name, value) => {
    if (typeof window === "undefined") return;
    const s = value.state;
    setLocalSetting(KEY_SHARE_ANALYTICS, String(s.shareAnalytics));
    setLocalSetting(KEY_SHARE_DIAGNOSTICS, String(s.shareDiagnostics));
    setLocalSetting(KEY_TOS_ACCEPTED, String(s.tosAccepted));
    setLocalSetting(KEY_AI_DATA_CONSENT, String(s.aiDataConsent));
    setLocalSetting(KEY_COMPLETED, String(s.completed));
  },
  removeItem: () => {
    if (typeof window === "undefined") return;
    removeLocalSetting(KEY_SHARE_ANALYTICS);
    removeLocalSetting(KEY_SHARE_DIAGNOSTICS);
    removeLocalSetting(KEY_TOS_ACCEPTED);
    removeLocalSetting(KEY_AI_DATA_CONSENT);
    removeLocalSetting(KEY_COMPLETED);
  },
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useOnboardingStoreBase = create<OnboardingStore>()(
  persist(
    (set) => ({
      // Initial values — persist will overwrite on hydrate, but these
      // are the SSR / no-storage defaults.
      shareAnalytics: true,
      shareDiagnostics: true,
      tosAccepted: false,
      aiDataConsent: false,
      completed: false,

      setShareAnalytics: (value) => set({ shareAnalytics: value }),
      setShareDiagnostics: (value) => set({ shareDiagnostics: value }),
      setTosAccepted: (value) => set({ tosAccepted: value }),
      setAiDataConsent: (value) => set({ aiDataConsent: value }),
      setOnboardingCompleted: (value) => set({ completed: value }),
      resetOnboardingFlags: () =>
        set({
          tosAccepted: false,
          aiDataConsent: false,
          completed: false,
        }),
    }),
    {
      name: PERSIST_STORE_NAME,
      storage: perKeyStorage,
      // Only persist state fields. Action functions stay in-memory.
      partialize: (state) => ({
        shareAnalytics: state.shareAnalytics,
        shareDiagnostics: state.shareDiagnostics,
        tosAccepted: state.tosAccepted,
        aiDataConsent: state.aiDataConsent,
        completed: state.completed,
      }),
    },
  ),
);

export const useOnboardingStore = createSelectors(useOnboardingStoreBase);

// ---------------------------------------------------------------------------
// Cross-tab + cross-surface sync
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  const rehydrate = () => {
    void useOnboardingStoreBase.persist.rehydrate();
  };

  window.addEventListener("storage", (event) => {
    if (event.key && WATCHED_KEYS.has(event.key)) {
      rehydrate();
    }
  });

  window.addEventListener(PREF_CHANGED_EVENT, (event) => {
    const detail = (event as CustomEvent<{ key?: string | null }>).detail;
    if (detail?.key && WATCHED_KEYS.has(detail.key)) {
      rehydrate();
    }
  });
}
