import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import type { MutationStatus, SlackThreadMode } from "@/components/slack-setup-wizard";
import {
  useChannelTrustFloors,
  type ChannelTrustFloors,
} from "@/domains/contacts/hooks/use-channel-trust-floors";
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
  integrationsTelegramConfigPost,
  integrationsTwilioCredentialsDelete,
  integrationsTwilioCredentialsPost,
} from "@/generated/daemon/sdk.gen";
import type { IntegrationsSlackChannelConfigGetResponse } from "@/generated/daemon/types.gen";
import { useSaveSlackConfig } from "@/hooks/use-save-slack-config";

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
 * Everything `AssistantChannelsDetail` needs, shaped to spread into its
 * props. Assembled here so the Channels page and the Contacts assistant
 * detail render the same surface off one set of queries and mutations.
 */
export interface AssistantChannelsController {
  channels: AssistantChannelState[];
  pendingChannelKey: SetupChannelId | null;
  slackThreadMode: SlackThreadMode | undefined;
  slackThreadModePending: boolean;
  channelPolicies: ChannelTrustFloors["policies"];
  policySavingKey: SetupChannelId | null;
  policiesLoading: boolean;
  policiesError: boolean;
  onChannelPolicyChange: ChannelTrustFloors["onChange"];
  /** Undefined when the caller can't open a setup conversation. */
  onSetup: ((channelKey: SetupChannelId) => void) | undefined;
  onDisconnect: (channelKey: SetupChannelId) => void;
  onSaveTelegramToken: (botToken: string) => Promise<void>;
  onSaveSlackConfig: (botToken: string, appToken: string) => void;
  slackSaveStatus: MutationStatus;
  slackSaveError: string | null;
  onSlackThreadModeChange: (mode: SlackThreadMode) => void;
  onSaveTwilioCredentials: (accountSid: string, authToken: string) => Promise<void>;
}

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

  const readinessPathOpts = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );
  const readinessQueryKey = channelsReadinessGetQueryKey(readinessPathOpts);

  const readinessQuery = useQuery({
    ...channelsReadinessGetOptions(readinessPathOpts),
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

  const slackConfigPathOpts = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );

  const slackConfigQuery = useQuery({
    ...integrationsSlackChannelConfigGetOptions(slackConfigPathOpts),
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

  const saveTelegramMutation = useMutation({
    mutationFn: (botToken: string) =>
      integrationsTelegramConfigPost({
        path: { assistant_id: assistantId },
        body: { botToken },
        throwOnError: true,
      }),
    onSettled: () => invalidateReadiness(),
  });

  const saveSlackMutation = useSaveSlackConfig({ assistantId });

  const slackThreadModeMutation = useMutation({
    ...integrationsSlackChannelConfigPatchMutation(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: integrationsSlackChannelConfigGetQueryKey(slackConfigPathOpts),
      });
    },
  });

  const saveTwilioMutation = useMutation({
    mutationFn: ({ accountSid, authToken }: { accountSid: string; authToken: string }) =>
      integrationsTwilioCredentialsPost({
        path: { assistant_id: assistantId },
        body: { accountSid, authToken },
        throwOnError: true,
      }),
    onSettled: () => invalidateReadiness(),
  });

  const onSaveTelegramToken = useCallback(
    async (botToken: string): Promise<void> => {
      await saveTelegramMutation.mutateAsync(botToken);
    },
    [saveTelegramMutation],
  );

  const onSaveSlackConfig = useCallback(
    (botToken: string, appToken: string) => {
      saveSlackMutation.mutate({ botToken, appToken });
    },
    [saveSlackMutation],
  );

  const onSlackThreadModeChange = useCallback(
    (mode: SlackThreadMode) => {
      slackThreadModeMutation.mutate({
        path: { assistant_id: assistantId },
        body: { threadMode: mode },
      });
    },
    [slackThreadModeMutation, assistantId],
  );

  const onSaveTwilioCredentials = useCallback(
    async (accountSid: string, authToken: string): Promise<void> => {
      await saveTwilioMutation.mutateAsync({ accountSid, authToken });
    },
    [saveTwilioMutation],
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

  const onDisconnect = useCallback(
    (channelKey: SetupChannelId) => {
      disconnectMutation.mutate(channelKey);
    },
    [disconnectMutation],
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
