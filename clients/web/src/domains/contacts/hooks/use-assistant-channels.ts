import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import type { SlackThreadMode } from "@/components/slack-setup-wizard";
import type { AssistantChannelsListProps } from "@/domains/contacts/components/assistant-channels-list";
import { useChannelTrustFloors } from "@/domains/contacts/hooks/use-channel-trust-floors";
import {
  SETUP_CHANNEL_IDS,
  type AssistantChannelState,
  type ChannelReadinessSnapshot,
  type SetupChannelId,
} from "@/domains/contacts/types";
import {
  channelsReadinessGetOptions,
  channelsReadinessGetQueryKey,
  integrationsSlackChannelConfigGetOptions,
  integrationsSlackChannelConfigGetQueryKey,
  integrationsSlackChannelConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  integrationsSlackChannelConfigDelete,
  integrationsTelegramConfigDelete,
  integrationsTwilioCredentialsDelete,
} from "@/generated/daemon/sdk.gen";
import type { IntegrationsSlackChannelConfigGetResponse } from "@/generated/daemon/types.gen";
import { useSaveSlackConfig } from "@/hooks/use-save-slack-config";
import { useSaveTelegramConfig } from "@/hooks/use-save-telegram-config";
import { useSaveTwilioCredentials } from "@/hooks/use-save-twilio-credentials";

const ASSISTANT_SETUP_PROMPTS: Record<SetupChannelId, string> = {
  slack: "I want to reach you on Slack. Let's set it up.",
  telegram: "I want to reach you on Telegram. Let's set it up.",
  phone: "I want to be able to call you. Let's set you up with a phone number.",
};

const READINESS_REFETCH_MS = 15000;

export interface UseAssistantChannelsOptions {
  assistantId: string;
  /** Starts a chat conversation that walks the guardian through channel setup. */
  onStartSetupConversation?: (prompt: string) => void;
}

/**
 * Everything `AssistantChannelsList` needs except the page-specific bits —
 * spread the controller straight into the component. Derived from the list's
 * own props so the two can't drift.
 */
export type AssistantChannelsController = Omit<
  AssistantChannelsListProps,
  "assistantName" | "initialExpandedChannel"
>;

/**
 * Queries, mutations, and handlers for the assistant's own channel
 * connections (Slack / Telegram / Phone): readiness polling, credential
 * saves, disconnects, Slack thread mode, and per-channel trust floors.
 */
export function useAssistantChannels({
  assistantId,
  onStartSetupConversation,
}: UseAssistantChannelsOptions): AssistantChannelsController {
  const queryClient = useQueryClient();

  const pathOpts = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );
  const readinessQueryKey = useMemo(
    () => channelsReadinessGetQueryKey(pathOpts),
    [pathOpts],
  );

  const readinessQuery = useQuery({
    ...channelsReadinessGetOptions(pathOpts),
    enabled: Boolean(assistantId),
    refetchInterval: READINESS_REFETCH_MS,
    select: (data) => data.snapshots,
  });

  const channels = useMemo(
    () => deriveChannelStates(readinessQuery.data ?? []),
    [readinessQuery.data],
  );

  const slackConnected = channels.some(
    (ch) => ch.key === "slack" && ch.status === "ready",
  );

  const slackConfigQuery = useQuery({
    ...integrationsSlackChannelConfigGetOptions(pathOpts),
    enabled: slackConnected,
    select: (data: IntegrationsSlackChannelConfigGetResponse) => data.threadMode,
  });

  // Per-channel trust floors (admission policy), shown inline on each connected
  // channel when the `channelTrustFloors` flag is on.
  const channelTrustFloors = useChannelTrustFloors(assistantId);

  const invalidateReadiness = useCallback(
    () => queryClient.invalidateQueries({ queryKey: readinessQueryKey }),
    [queryClient, readinessQueryKey],
  );

  const disconnectMutation = useMutation({
    mutationFn: async (channelKey: SetupChannelId) => {
      const opts = { path: { assistant_id: assistantId }, throwOnError: true as const };
      if (channelKey === "slack") {
        await integrationsSlackChannelConfigDelete(opts);
      } else if (channelKey === "telegram") {
        await integrationsTelegramConfigDelete(opts);
      } else if (channelKey === "phone") {
        await integrationsTwilioCredentialsDelete(opts);
      }
    },
    onSettled: () => invalidateReadiness(),
  });

  // Credential saves reuse the app-wide hooks (also used by the chat-side
  // channel-setup panel); they validate, trim, and invalidate readiness.
  const saveTelegramMutation = useSaveTelegramConfig({ assistantId });
  const saveSlackMutation = useSaveSlackConfig({ assistantId });
  const saveTwilioMutation = useSaveTwilioCredentials({ assistantId });

  const slackThreadModeMutation = useMutation({
    ...integrationsSlackChannelConfigPatchMutation(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: integrationsSlackChannelConfigGetQueryKey(pathOpts),
      });
    },
  });

  const saveTelegramMutateAsync = saveTelegramMutation.mutateAsync;
  const onSaveTelegramToken = useCallback(
    async (botToken: string): Promise<void> => {
      await saveTelegramMutateAsync(botToken);
    },
    [saveTelegramMutateAsync],
  );

  const saveSlackMutate = saveSlackMutation.mutate;
  const onSaveSlackConfig = useCallback(
    (botToken: string, appToken: string) => {
      saveSlackMutate({ botToken, appToken });
    },
    [saveSlackMutate],
  );

  const slackThreadModeMutate = slackThreadModeMutation.mutate;
  const onSlackThreadModeChange = useCallback(
    (mode: SlackThreadMode) => {
      slackThreadModeMutate({
        path: { assistant_id: assistantId },
        body: { threadMode: mode },
      });
    },
    [slackThreadModeMutate, assistantId],
  );

  const saveTwilioMutateAsync = saveTwilioMutation.mutateAsync;
  const onSaveTwilioCredentials = useCallback(
    async (accountSid: string, authToken: string): Promise<void> => {
      await saveTwilioMutateAsync({ accountSid, authToken });
    },
    [saveTwilioMutateAsync],
  );

  const handleSetup = useCallback(
    (channelKey: SetupChannelId) => {
      if (!onStartSetupConversation) {
        return;
      }
      onStartSetupConversation(ASSISTANT_SETUP_PROMPTS[channelKey]);
    },
    [onStartSetupConversation],
  );

  const disconnectMutate = disconnectMutation.mutate;
  const onDisconnect = useCallback(
    (channelKey: SetupChannelId) => {
      disconnectMutate(channelKey);
    },
    [disconnectMutate],
  );

  return {
    channels,
    pendingChannelKey: disconnectMutation.isPending
      ? disconnectMutation.variables ?? null
      : null,
    slackThreadMode: slackConfigQuery.data,
    slackThreadModePending: slackThreadModeMutation.isPending,
    channelPolicies: channelTrustFloors.policies,
    policySavingKey: channelTrustFloors.savingKey,
    policiesLoading: channelTrustFloors.isLoading,
    policiesError: channelTrustFloors.isError,
    onChannelPolicyChange: channelTrustFloors.onChange,
    onSetup: onStartSetupConversation ? handleSetup : undefined,
    onDisconnect,
    onSaveTelegramToken,
    onSaveSlackConfig,
    slackSaveStatus: saveSlackMutation.status,
    slackSaveError: saveSlackMutation.error?.message ?? null,
    onSlackThreadModeChange,
    onSaveTwilioCredentials,
  };
}

function deriveChannelStates(
  snapshots: ChannelReadinessSnapshot[],
): AssistantChannelState[] {
  const byChannel = new Map<ChannelReadinessSnapshot["channel"], ChannelReadinessSnapshot>();
  for (const snap of snapshots) {
    byChannel.set(snap.channel, snap);
  }

  return SETUP_CHANNEL_IDS.map((key) => {
    const snap = byChannel.get(key);
    const status = toChannelStatus(snap);
    return {
      key,
      status,
      address: snap?.channelHandle ?? undefined,
    };
  });
}

function toChannelStatus(
  snap: ChannelReadinessSnapshot | undefined,
): AssistantChannelState["status"] {
  if (!snap) {
    return "not_configured";
  }
  if (snap.ready || snap.setupStatus === "ready") {
    return "ready";
  }
  if (snap.setupStatus === "incomplete") {
    return "incomplete";
  }
  return "not_configured";
}
