/**
 * Zustand store for app-level feature flags.
 *
 * Module-level singleton accessible anywhere via
 * `useFeatureFlagStore.use.flagName()` (React) or
 * `useFeatureFlagStore.getState().flagName` (non-React).
 *
 * Flags initialize with safe defaults and can be bulk-updated via
 * `setFlags()` or individually toggled via `setFlag()`. The toggle
 * API is wired into the Developer → Feature Flags debug panel so
 * flags can be overridden during development.
 *
 * Flag evaluation is hydrated from the platform backend via
 * `useFeatureFlagSync`, which fetches from
 * `/v1/feature-flags/client-flag-values/` and calls `setFlags()`.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 * @see {@link https://zustand.docs.pmnd.rs/guides/auto-generating-selectors}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";

// ---------------------------------------------------------------------------
// Flag types
// ---------------------------------------------------------------------------

export interface AppFeatureFlags {
  a2aChannel: boolean;
  accountDeletion: boolean;
  analyzeConversation: boolean;
  chatPullToRefreshEnabled: boolean;
  conversationGroupsUI: boolean;
  deployToVercel: boolean;
  settingsDeveloperNav: boolean;
  doctor: boolean;
  homePage: boolean;
  multiPlatformAssistant: boolean;
  openAICompatibleEndpoints: boolean;
  platformNotifications: boolean;
  proPlanAdjust: boolean;
  rollbackEnabled: boolean;
  safeStorageLimits: boolean;
  selfHostedAssistant: boolean;
  settingsSleepPolicy: boolean;
  sounds: boolean;
  velvet: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_FLAGS: AppFeatureFlags = {
  a2aChannel: false,
  accountDeletion: false,
  analyzeConversation: false,
  chatPullToRefreshEnabled: false,
  conversationGroupsUI: false,
  deployToVercel: false,
  settingsDeveloperNav: false,
  doctor: false,
  homePage: false,
  multiPlatformAssistant: false,
  openAICompatibleEndpoints: false,
  platformNotifications: false,
  proPlanAdjust: false,
  rollbackEnabled: false,
  safeStorageLimits: false,
  selfHostedAssistant: false,
  settingsSleepPolicy: false,
  sounds: false,
  velvet: false,
};

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

export interface FeatureFlagActions {
  setFlags: (flags: Partial<AppFeatureFlags>) => void;
  setFlag: <K extends keyof AppFeatureFlags>(
    key: K,
    value: AppFeatureFlags[K],
  ) => void;
}

export type FeatureFlagStore = AppFeatureFlags & FeatureFlagActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useFeatureFlagStoreBase = create<FeatureFlagStore>()((set) => ({
  ...DEFAULT_FLAGS,

  setFlags: (flags) =>
    set((prev) => {
      const changed = (Object.keys(flags) as (keyof AppFeatureFlags)[]).some(
        (k) => flags[k] !== prev[k],
      );
      return changed ? flags : prev;
    }),

  setFlag: (key, value) => set({ [key]: value }),
}));

export const useFeatureFlagStore = createSelectors(useFeatureFlagStoreBase);
