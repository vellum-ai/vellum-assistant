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
 * Flag evaluation from a remote source (LaunchDarkly, platform API)
 * is not yet wired — see LUM-1710 for context. When a fetch mechanism
 * is added, call `setFlags()` with the evaluated values.
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
  chatPullToRefresh: boolean;
  conversationGroupsUI: boolean;
  deployToVercel: boolean;
  developerSettings: boolean;
  doctor: boolean;
  emailRootDomain: string;
  homePage: boolean;
  isNonProduction: boolean;
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
  chatPullToRefresh: false,
  conversationGroupsUI: false,
  deployToVercel: false,
  developerSettings: false,
  doctor: false,
  emailRootDomain: "vellum.me",
  homePage: false,
  isNonProduction: false,
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

  setFlags: (flags) => set(flags),

  setFlag: (key, value) => set({ [key]: value }),
}));

export const useFeatureFlagStore = createSelectors(useFeatureFlagStoreBase);
