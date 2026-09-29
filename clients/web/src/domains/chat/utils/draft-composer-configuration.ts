import type { QueryClient } from "@tanstack/react-query";

import { isDispatchableProfile } from "@/assistant/profile-pickers";
import { useComposerStore } from "@/domains/chat/composer-store";
import {
  composerProfiles,
  type Autonomy,
} from "@/domains/chat/utils/composer-configuration";
import {
  composerSettingsGetOptions,
  configGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  ComposerSettingsGetResponse,
  ConfigGetResponse,
} from "@/generated/daemon/types.gen";
import { assistantCapabilityOptions } from "@/hooks/use-assistant-capability";
import { getGlobalThresholds } from "@/lib/threshold-api";
import { useConversationStore } from "@/stores/conversation-store";

export function composerGlobalThresholdOptions(assistantId: string) {
  return {
    queryKey: ["globalThresholds", assistantId],
    queryFn: () => getGlobalThresholds(assistantId),
  };
}

export function initializeDraftComposerConfiguration(
  id: string,
  llm: ConfigGetResponse["llm"],
  globalThreshold: Autonomy,
  preferences?: ComposerSettingsGetResponse["preferences"],
) {
  const store = useConversationStore.getState();
  if (
    !store.draftConversationIds.has(id) ||
    store.initializedDraftComposerIds.has(id)
  ) {
    return;
  }
  const profiles = composerProfiles(
    llm?.profiles ?? {},
    llm?.profileOrder ?? [],
  );
  const preferred = profiles.find(
    (entry) => entry.name === preferences?.lastModeId,
  );
  const seedMode =
    preferred &&
    isDispatchableProfile(preferred, profiles, {
      requireOwnProviderAndModel: true,
    })
      ? preferred.name
      : llm?.activeProfile;
  if (!store.pendingDraftProfiles.has(id) && seedMode) {
    store.setPendingDraftProfile(id, seedMode);
  }
  if (preferences && !store.pendingDraftAutonomy.has(id)) {
    store.setPendingDraftAutonomy(
      id,
      preferences.lastAutonomy ?? globalThreshold,
    );
  }
  store.initializeDraftComposer(id);
}

export async function resolveDraftComposerConfiguration(
  queryClient: QueryClient,
  assistantId: string,
  id: string,
) {
  const store = useConversationStore.getState();
  if (
    !store.draftConversationIds.has(id) ||
    store.initializedDraftComposerIds.has(id)
  ) {
    return;
  }
  const sessionGeneration = useComposerStore.getState().sessionGeneration;
  const supportsPreferences = await queryClient.ensureQueryData(
    assistantCapabilityOptions("composerSettings", assistantId),
  );
  if (useComposerStore.getState().sessionGeneration !== sessionGeneration) {
    throw new Error("Composer context changed");
  }
  const [config, threshold, settings] = await Promise.all([
    queryClient.ensureQueryData(
      configGetOptions({ path: { assistant_id: assistantId } }),
    ),
    queryClient.ensureQueryData(composerGlobalThresholdOptions(assistantId)),
    supportsPreferences
      ? queryClient.ensureQueryData(
          composerSettingsGetOptions({ path: { assistant_id: assistantId } }),
        )
      : undefined,
  ]);
  if (useComposerStore.getState().sessionGeneration !== sessionGeneration) {
    throw new Error("Composer context changed");
  }
  initializeDraftComposerConfiguration(
    id,
    config.llm,
    threshold.interactive,
    settings?.preferences,
  );
}
