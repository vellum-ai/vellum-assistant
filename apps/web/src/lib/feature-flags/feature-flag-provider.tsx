/**
 * Client-side feature flag context.
 *
 * Flags are resolved server-side (LaunchDarkly) and injected into the
 * page response. The provider makes them available to any component via
 * `useAppFeatureFlags()`.
 *
 * Reference: https://docs.launchdarkly.com/sdk/client-side/react/react-web
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

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
  platformNotifications: boolean;
  proPlanAdjust: boolean;
  rollbackEnabled: boolean;
  referralCodes: boolean;
  referralCodesAdmin: boolean;
  safeStorageLimits: boolean;
  selfHostedAssistant: boolean;
  settingsSleepPolicy: boolean;
  sounds: boolean;
  velvet: boolean;
}

const DEFAULT_FLAGS: AppFeatureFlags = {
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
  platformNotifications: false,
  proPlanAdjust: false,
  rollbackEnabled: false,
  referralCodes: false,
  referralCodesAdmin: false,
  safeStorageLimits: false,
  selfHostedAssistant: false,
  settingsSleepPolicy: false,
  sounds: false,
  velvet: false,
};

const AppFeatureFlagContext = createContext<AppFeatureFlags>(DEFAULT_FLAGS);

export function AppFeatureFlagProvider({
  children,
  ...flags
}: AppFeatureFlags & { children: ReactNode }) {
  const value = useMemo(() => ({ ...flags }), [
    flags.a2aChannel,
    flags.accountDeletion,
    flags.analyzeConversation,
    flags.chatPullToRefresh,
    flags.conversationGroupsUI,
    flags.deployToVercel,
    flags.developerSettings,
    flags.doctor,
    flags.emailRootDomain,
    flags.homePage,
    flags.isNonProduction,
    flags.multiPlatformAssistant,
    flags.platformNotifications,
    flags.proPlanAdjust,
    flags.rollbackEnabled,
    flags.referralCodes,
    flags.referralCodesAdmin,
    flags.safeStorageLimits,
    flags.selfHostedAssistant,
    flags.settingsSleepPolicy,
    flags.sounds,
    flags.velvet,
  ]);

  return (
    <AppFeatureFlagContext value={value}>{children}</AppFeatureFlagContext>
  );
}

export function useAppFeatureFlags(): AppFeatureFlags {
  return useContext(AppFeatureFlagContext);
}
