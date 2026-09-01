import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { useStickyProfiles } from "@/assistant/use-sticky-profiles";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  orderedProfileEntries,
  pickManagedRecoveryProfile,
  type RecoveryProfileEntry,
} from "@/domains/chat/utils/managed-recovery-profile";
import {
  configGetOptions,
  configGetQueryKey,
  conversationsByIdGetOptions,
  conversationsByIdGetQueryKey,
  inferenceProfilesGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  conversationsByIdInferenceprofilePut,
  inferenceActiveprofilePut,
} from "@/generated/daemon/sdk.gen";
import { t } from "@/i18n";
import { useSupportsCompleteProfileSnapshots } from "@/lib/backwards-compat/complete-profile-snapshots";
import { useSupportsActiveProfileRoute } from "@/lib/backwards-compat/use-supports-active-profile-route";
import { captureError } from "@/lib/sentry/capture-error";
import { useConversationStore } from "@/stores/conversation-store";
import { badRequestMessage } from "@/utils/api-errors";
import { toast } from "@vellumai/design-library/components/toast";

export interface UseInvalidApiKeyRecoveryArgs {
  assistantId: string | null | undefined;
  conversationId: string | null | undefined;
  isDraft: boolean;
}

export interface InvalidApiKeyRecovery {
  canUseDefaultModel: boolean;
  useDefaultModel: () => Promise<void>;
  pending: boolean;
}

/**
 * Recovers a chat turn that failed on a rejected personal API key by
 * switching to a Vellum-managed profile. Conversation pin always; workspace
 * `activeProfile` only when the current default is a user-owned profile.
 */
export function useInvalidApiKeyRecovery({
  assistantId,
  conversationId,
  isDraft,
}: UseInvalidApiKeyRecoveryArgs): InvalidApiKeyRecovery {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const requireOwnProviderAndModel = useSupportsCompleteProfileSnapshots();
  const supportsActiveProfileRoute =
    useSupportsActiveProfileRoute(assistantId);

  const configQuery = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: !!assistantId,
    staleTime: 30_000,
  });
  const conversationQuery = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: conversationId ?? "" },
    }),
    enabled: !!assistantId && !!conversationId && !isDraft,
  });

  const { profiles, profileOrder } = useStickyProfiles(
    configQuery.data?.llm,
    assistantId ?? undefined,
  );
  const globalActiveProfile = configQuery.data?.llm?.activeProfile ?? null;
  const conversationProfileOverride =
    conversationQuery.data?.conversation.inferenceProfile ?? null;

  const entries = useMemo(
    () =>
      orderedProfileEntries(
        profiles as Record<string, Omit<RecoveryProfileEntry, "name">>,
        profileOrder,
      ),
    [profiles, profileOrder],
  );

  const excludeName =
    conversationProfileOverride ?? globalActiveProfile ?? null;
  const recoveryProfile = useMemo(
    () =>
      pickManagedRecoveryProfile(
        entries,
        { requireOwnProviderAndModel },
        excludeName,
      ),
    [entries, excludeName, requireOwnProviderAndModel],
  );

  const activeEntry = globalActiveProfile
    ? entries.find((entry) => entry.name === globalActiveProfile)
    : undefined;
  const shouldSwitchWorkspaceDefault = activeEntry?.source === "user";

  const canUseDefaultModel =
    !!assistantId &&
    !!recoveryProfile &&
    (!!conversationId || shouldSwitchWorkspaceDefault);

  const useDefaultModel = useCallback(async () => {
    if (!assistantId || !recoveryProfile) {
      return;
    }

    setPending(true);
    try {
      if (conversationId && isDraft) {
        useConversationStore
          .getState()
          .setPendingDraftProfile(conversationId, recoveryProfile);
      } else if (conversationId) {
        await conversationsByIdInferenceprofilePut({
          path: { assistant_id: assistantId, id: conversationId },
          body: { profile: recoveryProfile },
          throwOnError: true,
        });
        void queryClient.invalidateQueries({
          queryKey: conversationsByIdGetQueryKey({
            path: { assistant_id: assistantId, id: conversationId },
          }),
        });
      }

      if (shouldSwitchWorkspaceDefault && supportsActiveProfileRoute) {
        try {
          await inferenceActiveprofilePut({
            path: { assistant_id: assistantId },
            body: { name: recoveryProfile },
            throwOnError: true,
          });
        } catch (error) {
          // Conversation pin is enough to unblock this chat. A workspace
          // default that cannot be rewritten is not a failed recovery.
          captureError(error, {
            context: "invalid-api-key-recovery-active-profile",
          });
        }
      }

      void queryClient.invalidateQueries({
        queryKey: configGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
      void queryClient.invalidateQueries({
        queryKey: inferenceProfilesGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });

      useChatSessionStore.getState().setError(null);
      const label =
        entries.find((entry) => entry.name === recoveryProfile)?.label ??
        recoveryProfile;
      toast.success(
        t("chat:invalidApiKeyBanner.switchedToDefault", { profile: label }),
      );
    } catch (error) {
      toast.error(
        badRequestMessage(error) ?? t("chat:invalidApiKeyBanner.switchFailed"),
      );
      if (!badRequestMessage(error)) {
        captureError(error, { context: "invalid-api-key-recovery" });
      }
    } finally {
      setPending(false);
    }
  }, [
    assistantId,
    conversationId,
    entries,
    isDraft,
    queryClient,
    recoveryProfile,
    shouldSwitchWorkspaceDefault,
    supportsActiveProfileRoute,
  ]);

  return { canUseDefaultModel, useDefaultModel, pending };
}
