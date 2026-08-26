import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import type { AssistantChannelsListProps } from "@/domains/channels/components/assistant-channels-list";
import type { SlackThreadMode } from "@/domains/channels/components/slack-thread-behavior";
import { useChannelTrustFloors } from "@/domains/channels/hooks/use-channel-trust-floors";
import { useTranslation } from "@/i18n";
import { CHANNEL_META } from "@/domains/channels/channel-meta";
import { useSupportsDiscordChannel } from "@/lib/backwards-compat/use-supports-discord-channel";
import { useSupportsDiscordConfig } from "@/lib/backwards-compat/use-supports-discord-config";
import {
  SETUP_CHANNEL_IDS,
  type AssistantChannelState,
  type ChannelReadinessSnapshot,
  type SetupChannelId,
} from "@/types/channel-types";
import { removeSlackWorkspaceQueries } from "@/utils/slack-workspace-cache";
import {
  channelsReadinessGetOptions,
  channelsReadinessGetQueryKey,
  integrationsDiscordConfigGetOptions,
  integrationsSlackChannelConfigGetOptions,
  integrationsSlackChannelConfigGetQueryKey,
  integrationsSlackChannelConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  integrationsDiscordConfigDelete,
  integrationsSlackChannelConfigDelete,
  integrationsTelegramConfigDelete,
  integrationsTwilioCredentialsDelete,
} from "@/generated/daemon/sdk.gen";
import type { IntegrationsSlackChannelConfigGetResponse } from "@/generated/daemon/types.gen";
import { useSaveSlackConfig } from "@/hooks/use-save-slack-config";
import { useSaveDiscordConfig } from "@/hooks/use-save-discord-config";
import { useSaveTelegramConfig } from "@/hooks/use-save-telegram-config";
import { useSaveTwilioCredentials } from "@/hooks/use-save-twilio-credentials";

/**
 * The delete route that clears each channel's stored credentials, undefined
 * where none exists yet. This record is the disconnect capability in one
 * place: the state rows derive `canDisconnect` from it, both disconnect
 * surfaces gate their button on that, and the disconnect copy in
 * `CHANNEL_META` is pinned to it by test, so a channel cannot gain a button
 * without a route or a route without its confirm copy.
 */
export const DISCONNECT_ROUTES: Record<
  SetupChannelId,
  | ((opts: {
      path: { assistant_id: string };
      throwOnError: true;
    }) => Promise<unknown>)
  | undefined
> = {
  slack: integrationsSlackChannelConfigDelete,
  telegram: integrationsTelegramConfigDelete,
  discord: integrationsDiscordConfigDelete,
  email: undefined,
  phone: integrationsTwilioCredentialsDelete,
};

const ASSISTANT_SETUP_PROMPT_KEYS = {
  slack: "useAssistantChannels.setupPrompt.slack",
  telegram: "useAssistantChannels.setupPrompt.telegram",
  discord: "useAssistantChannels.setupPrompt.discord",
  email: "useAssistantChannels.setupPrompt.email",
  phone: "useAssistantChannels.setupPrompt.phone",
} as const satisfies Record<SetupChannelId, string>;

/**
 * Sent instead when a channel holds credentials but is not working. Setup got
 * part way, so asking to start over describes the wrong problem and tells the
 * assistant to do the wrong thing.
 */
const ASSISTANT_FINISH_PROMPT_KEYS = {
  slack: "useAssistantChannels.finishPrompt.slack",
  telegram: "useAssistantChannels.finishPrompt.telegram",
  discord: "useAssistantChannels.finishPrompt.discord",
  email: "useAssistantChannels.finishPrompt.email",
  phone: "useAssistantChannels.finishPrompt.phone",
} as const satisfies Record<SetupChannelId, string>;

const READINESS_REFETCH_MS = 15000;

export interface UseAssistantChannelsOptions {
  assistantId: string;
  /** Starts a chat conversation that walks the guardian through channel setup. */
  onStartSetupConversation?: (prompt: string) => void;
}

/**
 * Everything `AssistantChannelsList` needs except the page-specific bits —
 * spread the controller straight into the component. Derived from the list's
 * own props so the two can't drift. The Slack sub-tab's channel list owns
 * its own data (`SlackChannelSection`), so nothing list-related lives here.
 */
export type AssistantChannelsController = Omit<
  AssistantChannelsListProps,
  "assistantId" | "assistantName" | "initialChannel"
>;

/**
 * Queries, mutations, and handlers for the assistant's own channel
 * connections (Slack / Telegram / Discord / Phone): readiness polling,
 * credential saves, disconnects, Slack thread mode, and per-channel trust
 * floors.
 */
export function useAssistantChannels({
  assistantId,
  onStartSetupConversation,
}: UseAssistantChannelsOptions): AssistantChannelsController {
  const { t } = useTranslation("common");
  const queryClient = useQueryClient();

  const pathOpts = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );
  const readinessQueryKey = useMemo(
    () => channelsReadinessGetQueryKey(pathOpts),
    [pathOpts],
  );

  const supportsDiscord = useSupportsDiscordChannel();
  const supportsDiscordConfig = useSupportsDiscordConfig();
  const setupChannels = useMemo(
    () => setupChannelsFor(supportsDiscord),
    [supportsDiscord],
  );

  const readinessQuery = useQuery({
    ...channelsReadinessGetOptions(pathOpts),
    enabled: Boolean(assistantId),
    refetchInterval: READINESS_REFETCH_MS,
    select: (data) => data.snapshots,
  });

  const channels = useMemo(
    () =>
      deriveChannelStates(
        readinessQuery.data ?? [],
        setupChannels,
        supportsDiscordConfig,
      ),
    [readinessQuery.data, setupChannels, supportsDiscordConfig],
  );

  // Setup, not health: the connection card stays mounted through a socket
  // outage, and its thread-mode control renders a default when this has no
  // data, so a query gated on delivery would show a setting the assistant is
  // not using and let the user save over the stored one.
  const slackConfigured = channels.some(
    (ch) => ch.key === "slack" && ch.configured,
  );

  const slackConfigQuery = useQuery({
    ...integrationsSlackChannelConfigGetOptions(pathOpts),
    enabled: slackConfigured,
    select: (data: IntegrationsSlackChannelConfigGetResponse) =>
      data.threadMode,
  });

  // Per-channel trust floors (admission policy), shown inline on each connected
  // channel where the connected assistant supports them.
  const channelTrustFloors = useChannelTrustFloors(assistantId);

  const invalidateReadiness = useCallback(
    () => queryClient.invalidateQueries({ queryKey: readinessQueryKey }),
    [queryClient, readinessQueryKey],
  );

  const disconnectMutation = useMutation({
    mutationFn: async (channelKey: SetupChannelId) => {
      const route = DISCONNECT_ROUTES[channelKey];
      if (!route) {
        // Unreachable from the UI: both disconnect surfaces gate their
        // button on this same record. Loud rather than a resolved promise,
        // which would read as a successful disconnect that cleared nothing.
        throw new Error(`No route clears ${channelKey} credentials.`);
      }
      await route({
        path: { assistant_id: assistantId },
        throwOnError: true,
      });
    },
    onSettled: (_data, _error, channelKey) => {
      invalidateReadiness();
      if (channelKey === "slack") {
        removeSlackWorkspaceQueries(queryClient, assistantId);
      }
    },
  });

  // Credential saves reuse the app-wide hooks (also used by the chat-side
  // channel-setup panel); they validate, trim, and invalidate readiness.
  const saveTelegramMutation = useSaveTelegramConfig({ assistantId });
  const saveDiscordMutation = useSaveDiscordConfig({ assistantId });
  // The stored config, so the invite step still has its install link after a
  // reload. A connect result only exists for the life of the mutation, and
  // setup is routinely finished in a later sitting.
  const discordConfigQuery = useQuery({
    ...integrationsDiscordConfigGetOptions(pathOpts),
    // Gated on the config routes, not the row: a daemon can show the row
    // (readiness probe present) while these routes do not exist yet.
    enabled: Boolean(assistantId) && supportsDiscordConfig,
  });
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

  // Mirrors the Slack shape: `mutate` rather than `mutateAsync`, with status
  // and error published alongside, so the setup wizard reads outcome from the
  // mutation instead of owning save state of its own.
  const saveDiscordMutate = saveDiscordMutation.mutate;
  const onSaveDiscordToken = useCallback(
    (botToken: string) => {
      saveDiscordMutate(botToken);
    },
    [saveDiscordMutate],
  );

  const saveTelegramMutate = saveTelegramMutation.mutate;
  const onSaveTelegramToken = useCallback(
    (botToken: string) => {
      saveTelegramMutate(botToken);
    },
    [saveTelegramMutate],
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
    (channelKey: SetupChannelId, incomplete = false) => {
      if (!onStartSetupConversation) {
        return;
      }
      onStartSetupConversation(
        t(
          incomplete
            ? ASSISTANT_FINISH_PROMPT_KEYS[channelKey]
            : ASSISTANT_SETUP_PROMPT_KEYS[channelKey],
        ),
      );
    },
    [onStartSetupConversation, t],
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
      ? (disconnectMutation.variables ?? null)
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
    telegramSaveStatus: saveTelegramMutation.status,
    telegramSaveError: saveTelegramMutation.error?.message ?? null,
    onSaveDiscordToken,
    discordSaveStatus: saveDiscordMutation.status,
    discordSaveError: saveDiscordMutation.error?.message ?? null,
    // The application the validated token belongs to, which the invite step
    // builds its link from. Present only after a successful connect.
    discordInviteUrl:
      saveDiscordMutation.data?.data?.inviteUrl ??
      discordConfigQuery.data?.inviteUrl,
    onSaveSlackConfig,
    slackSaveStatus: saveSlackMutation.status,
    slackSaveError: saveSlackMutation.error?.message ?? null,
    onSlackThreadModeChange,
    onSaveTwilioCredentials,
  };
}

/**
 * Channels this assistant version can answer for. A daemon below the Discord
 * gate has no probe for it, so its readiness service reports the channel
 * unsupported rather than not-configured, and a row would read as permanently
 * broken instead of ready to set up.
 */
function setupChannelsFor(supportsDiscord: boolean): readonly SetupChannelId[] {
  return supportsDiscord
    ? SETUP_CHANNEL_IDS
    : SETUP_CHANNEL_IDS.filter((key) => key !== "discord");
}

function deriveChannelStates(
  snapshots: ChannelReadinessSnapshot[],
  setupChannels: readonly SetupChannelId[],
  supportsDiscordConfig: boolean,
): AssistantChannelState[] {
  const byChannel = new Map<
    ChannelReadinessSnapshot["channel"],
    ChannelReadinessSnapshot
  >();
  for (const snap of snapshots) {
    byChannel.set(snap.channel, snap);
  }

  return setupChannels.map((key) => {
    const snap = byChannel.get(key);
    const status = toChannelStatus(snap);
    return {
      key,
      status,
      configured: snap?.setupStatus === "ready",
      // Discord's config routes are newer than its readiness probe, so both
      // per-daemon capabilities carry the same version gate; the other
      // channels' routes predate every daemon this client can meet.
      canDisconnect:
        DISCONNECT_ROUTES[key] !== undefined &&
        (key !== "discord" || supportsDiscordConfig),
      canManualEntry:
        CHANNEL_META[key].credentialForm !== undefined &&
        (key !== "discord" || supportsDiscordConfig),
      health: snap?.health,
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
  // Working, not merely configured: every list renders this as the connection
  // state, and a channel whose delivery is failing is honestly not connected.
  // The wizard-versus-card decision asks `configured` instead.
  if (snap.ready) {
    return "ready";
  }
  if (snap.setupStatus === "not_configured") {
    return "not_configured";
  }
  return "incomplete";
}
