
import { createContext, useContext, useMemo, type ReactNode } from "react";

interface AppFeatureFlags {
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
  openAICompatibleEndpoints: false,
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
  a2aChannel,
  accountDeletion,
  analyzeConversation,
  chatPullToRefresh,
  conversationGroupsUI,
  deployToVercel,
  developerSettings,
  doctor,
  emailRootDomain,
  homePage,
  isNonProduction,
  multiPlatformAssistant,
  openAICompatibleEndpoints,
  platformNotifications,
  proPlanAdjust,
  rollbackEnabled,
  referralCodes,
  referralCodesAdmin,
  safeStorageLimits,
  selfHostedAssistant,
  settingsSleepPolicy,
  sounds,
  velvet,
  children,
}: AppFeatureFlags & { children: ReactNode }) {
  const value = useMemo(
    () => ({
      a2aChannel,
      accountDeletion,
      analyzeConversation,
      chatPullToRefresh,
      conversationGroupsUI,
      deployToVercel,
      developerSettings,
      doctor,
      emailRootDomain,
      homePage,
      isNonProduction,
      multiPlatformAssistant,
      openAICompatibleEndpoints,
      platformNotifications,
      proPlanAdjust,
      rollbackEnabled,
      referralCodes,
      referralCodesAdmin,
      safeStorageLimits,
      selfHostedAssistant,
      settingsSleepPolicy,
      sounds,
      velvet,
    }),
    [
      a2aChannel,
      accountDeletion,
      analyzeConversation,
      chatPullToRefresh,
      conversationGroupsUI,
      deployToVercel,
      developerSettings,
      doctor,
      emailRootDomain,
      homePage,
      isNonProduction,
      multiPlatformAssistant,
      openAICompatibleEndpoints,
      platformNotifications,
      proPlanAdjust,
      rollbackEnabled,
      referralCodes,
      referralCodesAdmin,
      safeStorageLimits,
      selfHostedAssistant,
      settingsSleepPolicy,
      sounds,
      velvet,
    ]
  );

  return <AppFeatureFlagContext value={value}>{children}</AppFeatureFlagContext>;
}

export function useAppFeatureFlags(): AppFeatureFlags {
  return useContext(AppFeatureFlagContext);
}
