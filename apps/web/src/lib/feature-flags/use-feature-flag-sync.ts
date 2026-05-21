import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen.js";
import { assertHasResponse } from "@/lib/api-errors.js";
import {
  useFeatureFlagStore,
  type AppFeatureFlags,
} from "@/lib/feature-flags/feature-flag-store.js";

interface ClientFlagValuesResponse {
  flags: Record<string, boolean>;
}

const LD_KEY_TO_STORE_KEY: Record<string, keyof AppFeatureFlags> = {
  "a2a-channel": "a2aChannel",
  "account-deletion": "accountDeletion",
  "analyze-conversation": "analyzeConversation",
  "chat-pull-to-refresh-enabled": "chatPullToRefresh",
  "conversation-groups-ui": "conversationGroupsUI",
  "deploy-to-vercel": "deployToVercel",
  "settings-developer-nav": "developerSettings",
  doctor: "doctor",
  "home-page": "homePage",
  "multi-platform-assistant": "multiPlatformAssistant",
  "openai-compatible-endpoints": "openAICompatibleEndpoints",
  "platform-notifications": "platformNotifications",
  "pro-plan-adjust": "proPlanAdjust",
  "rollback-enabled": "rollbackEnabled",
  "safe-storage-limits": "safeStorageLimits",
  "self-hosted-assistant": "selfHostedAssistant",
  "settings-sleep-policy": "settingsSleepPolicy",
  sounds: "sounds",
  velvet: "velvet",
};

const FEATURE_FLAG_QUERY_KEY = ["feature-flag-values"] as const;

async function fetchClientFlagValues(): Promise<ClientFlagValuesResponse> {
  const { data, error, response } = await client.get<
    ClientFlagValuesResponse,
    Record<string, unknown>,
    false
  >({
    url: "/v1/feature-flags/client-flag-values/" as "/v1/feature-flags/client-flag-values/",
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch feature flags");
  if (!response.ok) {
    throw new Error(`Failed to fetch feature flags: ${response.status}`);
  }
  return data as ClientFlagValuesResponse;
}

function mapFlags(
  serverFlags: Record<string, boolean>,
): Partial<AppFeatureFlags> {
  const mapped: Partial<AppFeatureFlags> = {};
  for (const [ldKey, value] of Object.entries(serverFlags)) {
    const storeKey = LD_KEY_TO_STORE_KEY[ldKey];
    if (storeKey) {
      Object.assign(mapped, { [storeKey]: value });
    }
  }
  return mapped;
}

export function useFeatureFlagSync(enabled: boolean) {
  const { data } = useQuery({
    queryKey: FEATURE_FLAG_QUERY_KEY,
    queryFn: fetchClientFlagValues,
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (data?.flags) {
      useFeatureFlagStore.getState().setFlags(mapFlags(data.flags));
    }
  }, [data]);
}
