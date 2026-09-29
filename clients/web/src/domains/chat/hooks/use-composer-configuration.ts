import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "@vellumai/design-library";

import {
  visibleProfilesForPicker,
  type ProfilePickerEntry,
} from "@/assistant/profile-pickers";
import { useStickyProfiles } from "@/assistant/use-sticky-profiles";
import { useProfileQuickAdd } from "@/components/profile-quick-add-provider";
import {
  composerProfiles,
  favoriteModes,
  serializeComposerWrite,
  type Autonomy,
} from "@/domains/chat/utils/composer-configuration";
import {
  composerGlobalThresholdOptions,
  initializeDraftComposerConfiguration,
} from "@/domains/chat/utils/draft-composer-configuration";
import {
  composerSettingsGetOptions,
  composerSettingsGetQueryKey,
  configGetOptions,
  configGetQueryKey,
  conversationsByIdGetOptions,
  conversationsByIdGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  composerSettingsPatch,
  conversationsByIdInferenceprofilePut,
} from "@/generated/daemon/sdk.gen";
import type {
  ComposerSettingsGetResponse,
  ComposerSettingsPatchData,
  ConfigGetResponse,
} from "@/generated/daemon/types.gen";
import {
  assistantCapabilityOptions,
  useAssistantCapabilityQuery,
} from "@/hooks/use-assistant-capability";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { useSupportsCompleteProfileSnapshots } from "@/lib/backwards-compat/complete-profile-snapshots";
import {
  getConversationOverride,
  setConversationOverride,
} from "@/lib/threshold-api";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useConversationStore } from "@/stores/conversation-store";
import { badRequestMessage } from "@/utils/api-errors";
import { findConversation } from "@/utils/conversation-cache";

export type ComposerPreferences = ComposerSettingsGetResponse["preferences"];
type PreferencePatch = NonNullable<ComposerSettingsPatchData["body"]>;
const DEFAULT_PREFERENCES: ComposerPreferences = {
  favoriteModeIds: [],
  lastModeId: null,
  lastAutonomy: null,
};

export function useComposerConfiguration(
  assistantId: string,
  conversationId: string | undefined,
) {
  const { t } = useTranslation("chat");
  const queryClient = useQueryClient();
  const sessionGeneration = useComposerStore.use.sessionGeneration();
  const orgReady = useIsOrgReady();
  const capability = useAssistantCapabilityQuery("composerSettings");
  const capabilityKnown = capability.data !== undefined;
  const supportsPreferences = capability.data === true;
  const requireOwnProviderAndModel = useSupportsCompleteProfileSnapshots();
  const activeId = useConversationStore.use.activeConversationId();
  const draftIds = useConversationStore.use.draftConversationIds();
  const pendingProfiles = useConversationStore.use.pendingDraftProfiles();
  const pendingAutonomy = useConversationStore.use.pendingDraftAutonomy();
  const initializedDrafts =
    useConversationStore.use.initializedDraftComposerIds();
  const id = conversationId ?? activeId;
  const scope = `${sessionGeneration}:${assistantId}:${id ?? ""}`;
  const isDraft = !!id && draftIds.has(id);
  const hasRow =
    !!conversationId &&
    !isDraft &&
    !findConversation(queryClient, assistantId, conversationId)?.draft;
  const config = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: orgReady,
    staleTime: 30_000,
  });
  const conversation = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId, id: conversationId ?? "" },
    }),
    enabled: orgReady && hasRow,
  });
  const globalThreshold = useQuery({
    ...composerGlobalThresholdOptions(assistantId),
    enabled: orgReady,
  });
  const threshold = useQuery({
    queryKey: ["conversationThresholdOverride", assistantId, id],
    queryFn: () => getConversationOverride(assistantId, id!),
    enabled: orgReady && hasRow,
  });
  const settings = useQuery({
    ...composerSettingsGetOptions({ path: { assistant_id: assistantId } }),
    enabled: orgReady && supportsPreferences,
  });
  const preferences = settings.data?.preferences ?? DEFAULT_PREFERENCES;
  const { profiles, profileOrder } = useStickyProfiles(
    config.data?.llm,
    assistantId,
  );
  const allProfiles = useMemo<ProfilePickerEntry[]>(
    () => composerProfiles(profiles, profileOrder),
    [profiles, profileOrder],
  );
  const [optimistic, setOptimistic] = useState<{
    scope: string;
    mode?: string;
    autonomy?: Autonomy;
  }>({ scope });
  const local = optimistic.scope === scope ? optimistic : undefined;
  const mode =
    local?.mode ??
    (id ? pendingProfiles.get(id) : undefined) ??
    conversation.data?.conversation.inferenceProfile ??
    config.data?.llm?.activeProfile ??
    null;
  const rawAutonomy =
    local?.autonomy ??
    (id ? pendingAutonomy.get(id) : undefined) ??
    (hasRow && !threshold.isSuccess
      ? undefined
      : (threshold.data ?? globalThreshold.data?.interactive));
  const autonomy: Autonomy | null =
    rawAutonomy === "none" ||
    rawAutonomy === "low" ||
    rawAutonomy === "medium" ||
    rawAutonomy === "high"
      ? rawAutonomy
      : null;
  const visibleProfiles = visibleProfilesForPicker(allProfiles, [mode], {
    requireOwnProviderAndModel,
  });
  const favorites = favoriteModes(
    preferences.favoriteModeIds,
    visibleProfiles,
    mode,
  );
  const [saving, setSaving] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);
  const currentScope = useRef(scope);
  useLayoutEffect(() => {
    currentScope.current = scope;
  }, [scope]);
  const revision = useRef({ mode: 0, autonomy: 0 });
  useEffect(() => {
    setOpen(false);
  }, [scope]);

  const savePreferences = useCallback(
    async (
      selection: Promise<void>,
      patch:
        | PreferencePatch
        | ((current: ComposerPreferences) => PreferencePatch),
    ) => {
      await serializeComposerWrite(`preferences:${assistantId}`, async () => {
        try {
          await selection;
        } catch {
          return;
        }
        if (
          useComposerStore.getState().sessionGeneration !== sessionGeneration
        ) {
          return;
        }
        const supported = await queryClient.fetchQuery(
          assistantCapabilityOptions("composerSettings", assistantId),
        );
        if (
          !supported ||
          useComposerStore.getState().sessionGeneration !== sessionGeneration
        ) {
          return;
        }
        const key = composerSettingsGetQueryKey({
          path: { assistant_id: assistantId },
        });
        const settings = await queryClient.ensureQueryData(
          composerSettingsGetOptions({ path: { assistant_id: assistantId } }),
        );
        await queryClient.cancelQueries({ queryKey: key });
        if (
          useComposerStore.getState().sessionGeneration !== sessionGeneration
        ) {
          return;
        }
        const current =
          queryClient.getQueryData<ComposerSettingsGetResponse>(key)
            ?.preferences ?? settings.preferences;
        const result = await composerSettingsPatch({
          path: { assistant_id: assistantId },
          body: typeof patch === "function" ? patch(current) : patch,
          throwOnError: true,
        });
        if (
          useComposerStore.getState().sessionGeneration === sessionGeneration
        ) {
          queryClient.setQueryData(key, result.data);
        }
      });
    },
    [assistantId, queryClient, sessionGeneration],
  );

  // Capture defaults once per real draft. Existing unloaded conversations never inherit them.
  useEffect(() => {
    if (
      !id ||
      !isDraft ||
      initializedDrafts.has(id) ||
      !config.isSuccess ||
      !globalThreshold.isSuccess ||
      !capabilityKnown ||
      (supportsPreferences && !settings.isSuccess)
    ) {
      return;
    }
    initializeDraftComposerConfiguration(
      id,
      config.data.llm,
      globalThreshold.data.interactive,
      supportsPreferences ? preferences : undefined,
    );
  }, [
    id,
    isDraft,
    initializedDrafts,
    config.isSuccess,
    config.data,
    globalThreshold.isSuccess,
    globalThreshold.data,
    capabilityKnown,
    supportsPreferences,
    settings.isSuccess,
    preferences,
  ]);

  const persistSelection = useCallback(
    async (kind: "mode" | "autonomy", value: string, target: string) => {
      if (useComposerStore.getState().sessionGeneration !== sessionGeneration) {
        throw new Error("Composer context changed");
      }
      if (kind === "mode") {
        await conversationsByIdInferenceprofilePut({
          path: { assistant_id: assistantId, id: target },
          body: { profile: value },
          throwOnError: true,
        });
        if (
          useComposerStore.getState().sessionGeneration !== sessionGeneration
        ) {
          throw new Error("Composer context changed");
        }
        await queryClient.invalidateQueries({
          queryKey: conversationsByIdGetQueryKey({
            path: { assistant_id: assistantId, id: target },
          }),
        });
      } else if (
        value === "none" ||
        value === "low" ||
        value === "medium" ||
        value === "high"
      ) {
        await setConversationOverride(assistantId, target, value);
        if (
          useComposerStore.getState().sessionGeneration !== sessionGeneration
        ) {
          throw new Error("Composer context changed");
        }
        await queryClient.invalidateQueries({
          queryKey: ["conversationThresholdOverride", assistantId, target],
        });
      }
      if (useComposerStore.getState().sessionGeneration !== sessionGeneration) {
        throw new Error("Composer context changed");
      }
    },
    [assistantId, queryClient, sessionGeneration],
  );

  const select = async (kind: "mode" | "autonomy", value: string) => {
    if (
      !id ||
      !config.isSuccess ||
      (kind === "autonomy" && (!autonomy || (!hasRow && !supportsPreferences)))
    ) {
      return false;
    }
    const target = id;
    setSaving((current) => ({
      ...current,
      [scope]: (current[scope] ?? 0) + 1,
    }));
    const version = ++revision.current[kind];
    if (kind === "mode") {
      setOptimistic((prev) => ({
        ...(prev.scope === scope ? prev : {}),
        scope,
        mode: value,
      }));
    } else if (
      value === "none" ||
      value === "low" ||
      value === "medium" ||
      value === "high"
    ) {
      setOptimistic((prev) => ({
        ...(prev.scope === scope ? prev : {}),
        scope,
        autonomy: value,
      }));
    }
    try {
      const selection = (async () => {
        if (!hasRow) {
          const store = useConversationStore.getState();
          if (kind === "mode") {
            store.setPendingDraftProfile(target, value);
          } else if (
            value === "none" ||
            value === "low" ||
            value === "medium" ||
            value === "high"
          ) {
            store.setPendingDraftAutonomy(target, value);
          }
        } else {
          await serializeComposerWrite(
            `${assistantId}:${target}:${kind}`,
            async () => {
              await persistSelection(kind, value, target);
              const store = useConversationStore.getState();
              if (kind === "mode") {
                store.clearPendingDraftProfile(target);
              } else {
                store.clearPendingDraftAutonomy(target);
              }
            },
          );
        }
      })();
      const preferencesSaved = savePreferences(selection, (current) => {
        if (kind === "mode") {
          const llm = queryClient.getQueryData<ConfigGetResponse>(
            configGetQueryKey({ path: { assistant_id: assistantId } }),
          )?.llm;
          const catalog = llm?.profiles
            ? composerProfiles(llm.profiles, llm.profileOrder ?? [])
            : allProfiles;
          return {
            lastModeId: value,
            favoriteModeIds: favoriteModes(
              current.favoriteModeIds,
              catalog,
              value,
            ).map((entry) => entry.name),
          };
        }
        return {
          lastAutonomy:
            value === "none" ||
            value === "low" ||
            value === "medium" ||
            value === "high"
              ? value
              : null,
        };
      }).catch(() => {
        if (
          useComposerStore.getState().sessionGeneration === sessionGeneration
        ) {
          toast.error(t("composerConfiguration.preferencesFailed"));
        }
      });
      await selection;
      if (
        currentScope.current === scope &&
        useComposerStore.getState().sessionGeneration === sessionGeneration &&
        revision.current[kind] === version
      ) {
        setOptimistic((prev) => ({ ...prev, [kind]: undefined }));
      }
      await preferencesSaved;
      return true;
    } catch (error) {
      if (
        currentScope.current === scope &&
        useComposerStore.getState().sessionGeneration === sessionGeneration &&
        revision.current[kind] === version
      ) {
        setOptimistic((prev) => ({ ...prev, [kind]: undefined }));
        toast.error(
          badRequestMessage(error) ?? t("composerConfiguration.saveFailed"),
        );
      }
      return false;
    } finally {
      setSaving((current) => ({
        ...current,
        [scope]: Math.max(0, (current[scope] ?? 1) - 1),
      }));
    }
  };

  const promoting = useRef(new Set<string>());
  useEffect(() => {
    if (!id || !hasRow) {
      return;
    }
    const promote = (kind: "mode" | "autonomy", value: string | undefined) => {
      const key = `${assistantId}:${id}:${kind}`;
      const promotionKey = `${sessionGeneration}:${key}`;
      if (value === undefined || promoting.current.has(promotionKey)) {
        return;
      }
      promoting.current.add(promotionKey);
      void serializeComposerWrite(key, () => persistSelection(kind, value, id))
        .catch(() => {
          if (
            useComposerStore.getState().sessionGeneration === sessionGeneration
          ) {
            toast.error(t("composerConfiguration.saveFailed"));
          }
        })
        .finally(() => {
          promoting.current.delete(promotionKey);
          if (
            useComposerStore.getState().sessionGeneration !== sessionGeneration
          ) {
            return;
          }
          const store = useConversationStore.getState();
          const pendingValue =
            kind === "mode"
              ? store.pendingDraftProfiles.get(id)
              : store.pendingDraftAutonomy.get(id);
          if (pendingValue === value) {
            if (kind === "mode") {
              store.clearPendingDraftProfile(id);
            } else {
              store.clearPendingDraftAutonomy(id);
            }
          } else {
            promote(kind, pendingValue);
          }
        });
    };
    promote("mode", pendingProfiles.get(id));
    promote("autonomy", pendingAutonomy.get(id));
  }, [
    id,
    assistantId,
    hasRow,
    pendingProfiles,
    pendingAutonomy,
    persistSelection,
    sessionGeneration,
    t,
  ]);

  const { openProfileQuickAdd } = useProfileQuickAdd();
  const newMode = () => {
    setOpen(false);
    openProfileQuickAdd({
      existingNames: Object.keys(profiles),
      onCreated: (name) => {
        if (
          currentScope.current === scope &&
          useComposerStore.getState().sessionGeneration === sessionGeneration
        ) {
          void select("mode", name);
        }
      },
    });
  };
  return {
    open,
    setOpen,
    mode,
    autonomy,
    profiles: visibleProfiles,
    allProfiles,
    favorites,
    preferences,
    preferencesAvailable: settings.isSuccess,
    supportsPreferences,
    modeReady: config.isSuccess && !!id,
    autonomyReady: !!autonomy && !!id && (hasRow || supportsPreferences),
    readyForDraft:
      !(saving[scope] ?? 0) &&
      (!isDraft ||
        initializedDrafts.has(id!) ||
        (capabilityKnown &&
          (config.isError || globalThreshold.isError || settings.isError))),
    selectMode: (name: string) => select("mode", name),
    selectAutonomy: (value: Autonomy) => select("autonomy", value),
    newMode,
    requireOwnProviderAndModel,
  };
}
export type ComposerConfiguration = ReturnType<typeof useComposerConfiguration>;
