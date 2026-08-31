import { useEffect, useState } from "react";

import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { useTranslation } from "@/i18n";
import { DetailCard } from "@/components/detail-card";
import { SideListDrawer, SideListTrigger } from "@/components/side-list-drawer";
import { useSideListRoom } from "@/hooks/use-side-list-room";
import type { MutationStatus } from "@/components/channel-setup-wizard";
import { useChannelRouteSelection } from "@/domains/channels/hooks/use-channel-route-selection";
import { CHANNEL_META } from "@/domains/channels/channel-meta";
import { ChannelAdapterList } from "@/domains/channels/components/channel-adapter-list";
import { ChannelPanel } from "@/domains/channels/components/channel-panel";
import { PluginChannelPanel } from "@/domains/channels/components/plugin-channel-panel";
import type { SlackThreadMode } from "@/domains/channels/components/slack-thread-behavior";
import type { AdmissionPolicy } from "@/lib/channel-admission-policy/types";
import type {
  AssistantChannelState,
  PluginChannelSummary,
  SetupChannelId,
} from "@/types/channel-types";
import { assistantDisplayName as toAssistantDisplayName } from "@/utils/assistant-display-name";

type ChannelKey = SetupChannelId;

export interface AssistantChannelsListProps {
  /** Needed by the Slack sub-tab's channel list, which owns its own data. */
  assistantId: string;
  assistantName: string;
  channels: AssistantChannelState[];
  /**
   * Channels declared by installed plugins. Listed alongside the adapters and
   * selectable, but managed by the plugin that brought them: no credential
   * form and no disconnect, neither of which this client can supply for a
   * channel it knows nothing about. Their shared trust floor is the panel's
   * own concern (`usePluginChannelTrustFloor`), not routed through these
   * props.
   */
  pluginChannels?: PluginChannelSummary[];
  pendingChannelKey?: ChannelKey | null;
  slackThreadMode?: SlackThreadMode;
  slackThreadModePending?: boolean;
  /**
   * Per-channel admission floor, keyed by channel. Omit (or pass no
   * `onChannelPolicyChange`) to hide the trust-floor control entirely —
   * `useChannelTrustFloors` does so when the connected assistant can't serve
   * it.
   */
  channelPolicies?: Partial<Record<ChannelKey, AdmissionPolicy>>;
  policySavingKey?: ChannelKey | null;
  policiesLoading?: boolean;
  policiesError?: boolean;
  onChannelPolicyChange?: (
    channelKey: ChannelKey,
    policy: AdmissionPolicy,
  ) => void;
  onSetup?: (channelKey: ChannelKey, incomplete?: boolean) => void;
  onDisconnect?: (channelKey: ChannelKey) => void;
  onSaveTelegramToken?: (botToken: string) => void;
  onSaveDiscordToken?: (botToken: string) => void;
  discordSaveStatus?: MutationStatus;
  discordSaveError?: string | null;
  discordInviteUrl?: string;
  telegramSaveStatus?: MutationStatus;
  telegramSaveError?: string | null;
  onSaveSlackConfig?: (botToken: string, appToken: string) => void;
  slackSaveStatus?: MutationStatus;
  slackSaveError?: string | null;
  onSlackThreadModeChange?: (mode: SlackThreadMode) => void;
  onSaveTwilioCredentials?: (
    accountSid: string,
    authToken: string,
  ) => Promise<void>;
  /**
   * Pre-select a channel's sub-tab on mount (e.g. from a `?setup=slack`
   * deep-link) and open its manual credential form.
   */
  initialChannel?: ChannelKey | null;
}

/**
 * The Channels tab's master-detail surface: a left rail listing the
 * Slack/Telegram/Phone adapters (`ChannelAdapterList`) beside the selected
 * adapter's detail panel (`ChannelPanel`), plus the disconnect confirmation
 * dialog. (The trust-floor confirmation lives inside
 * `ChannelTrustFloorSection`, so plugin channel panels get it too.) Rendered
 * by the Channels tab (`ChannelsPage`). The active adapter is the one named
 * in the URL (`use-channel-route-selection`); the queries and mutations
 * behind the props live in `useAssistantChannels`.
 */
export function AssistantChannelsList({
  assistantId,
  assistantName,
  channels,
  pluginChannels = [],
  pendingChannelKey = null,
  slackThreadMode,
  slackThreadModePending = false,
  channelPolicies,
  policySavingKey = null,
  policiesLoading = false,
  policiesError = false,
  onChannelPolicyChange,
  onSetup,
  onDisconnect,
  onSaveTelegramToken,
  telegramSaveStatus,
  onSaveDiscordToken,
  discordSaveStatus,
  discordSaveError = null,
  discordInviteUrl,
  telegramSaveError,
  onSaveSlackConfig,
  slackSaveStatus,
  slackSaveError,
  onSlackThreadModeChange,
  onSaveTwilioCredentials,
  initialChannel = null,
}: AssistantChannelsListProps) {
  const { t } = useTranslation("channels");
  const { selected: selectedAdapter, select: selectAdapter } =
    useChannelRouteSelection();

  const [pendingDisconnect, setPendingDisconnect] = useState<ChannelKey | null>(
    null,
  );
  const { paneRef, hasRoomForList, drawerOpen, openDrawer, closeDrawer } =
    useSideListRoom();
  // Capture the `?setup=<channel>` deep link once at mount. `useSetupChannelParam`
  // consumes (clears) the param right after the first render, so reading the
  // prop later races against this component's own store update; the frozen
  // value reliably drives both the initial selection and the manual-entry seed.
  const [setupChannel] = useState(initialChannel);

  // Select the deep-linked adapter on arrival; its panel then opens the manual
  // credential form (see `initialManualEntry`).
  useEffect(() => {
    if (setupChannel) {
      selectAdapter(setupChannel);
    }
  }, [setupChannel, selectAdapter]);

  const displayName = toAssistantDisplayName(assistantName);
  const disconnectMeta = pendingDisconnect
    ? CHANNEL_META[pendingDisconnect]
    : null;

  const handleSelect = (channelKey: string) => {
    selectAdapter(channelKey);
    closeDrawer();
  };

  // A plugin channel can be selected, and can also vanish under the selection
  // when its plugin is uninstalled or disabled, so the lookup falls through to
  // the adapters rather than leaving the panel empty.
  const selectedPlugin = pluginChannels.find(
    (channel) => channel.key === selectedAdapter,
  );
  const selected = selectedPlugin
    ? undefined
    : (channels.find((channel) => channel.key === selectedAdapter) ??
      channels[0]);

  if (!selected && !selectedPlugin) {
    return null;
  }

  const selectedKey = selectedPlugin ? selectedPlugin.key : selected!.key;

  // Keyed on the adapter so switching selection remounts the panel: its
  // credential-form state (`initialManualEntry`) is seeded once at mount,
  // and each adapter should start fresh.
  const detail = selectedPlugin ? (
    <PluginChannelPanel
      key={selectedPlugin.key}
      channel={selectedPlugin}
      assistantId={assistantId}
      assistantDisplayName={displayName}
    />
  ) : (
    <ChannelPanel
      key={selected!.key}
      channel={selected!}
      assistantId={assistantId}
      assistantName={assistantName}
      assistantDisplayName={displayName}
      pending={pendingChannelKey === selected!.key}
      initialManualEntry={setupChannel === selected!.key}
      onSetup={
        onSetup
          ? () => onSetup(selected!.key, selected!.status === "incomplete")
          : undefined
      }
      onDisconnect={
        // Offered only where a delete route exists (`canDisconnect` derives
        // from the route record), so the confirm can never resolve without
        // clearing anything.
        onDisconnect && selected!.canDisconnect
          ? () => setPendingDisconnect(selected!.key)
          : undefined
      }
      onSaveTelegramToken={onSaveTelegramToken}
      telegramSaveStatus={telegramSaveStatus}
      onSaveDiscordToken={onSaveDiscordToken}
      discordSaveStatus={discordSaveStatus}
      discordSaveError={discordSaveError}
      {...(discordInviteUrl ? { discordInviteUrl } : {})}
      telegramSaveError={telegramSaveError}
      onSaveSlackConfig={onSaveSlackConfig}
      slackSaveStatus={slackSaveStatus}
      slackSaveError={slackSaveError}
      slackThreadMode={slackThreadMode}
      slackThreadModePending={slackThreadModePending}
      onSlackThreadModeChange={onSlackThreadModeChange}
      onSaveTwilioCredentials={onSaveTwilioCredentials}
      policy={channelPolicies?.[selected!.key]}
      policySaving={policySavingKey === selected!.key}
      policyLoading={policiesLoading}
      policyError={policiesError}
      onPolicyChange={
        onChannelPolicyChange
          ? (next) => onChannelPolicyChange(selected!.key, next)
          : undefined
      }
    />
  );

  return (
    <>
      <div
        ref={paneRef}
        className={`flex min-h-0 flex-1 overflow-hidden ${
          hasRoomForList ? "flex-row gap-6" : "flex-col gap-4"
        }`}
      >
        {hasRoomForList ? (
          <aside className="min-h-0 w-[320px] shrink-0 overflow-y-auto self-stretch">
            <ChannelAdapterList
              channels={channels}
              pluginChannels={pluginChannels}
              selectedKey={selectedKey}
              onSelect={handleSelect}
            />
          </aside>
        ) : (
          <>
            <div className="flex items-center">
              <SideListTrigger onClick={openDrawer} />
            </div>

            <SideListDrawer
              open={drawerOpen}
              onClose={closeDrawer}
              title={t("assistantChannelsList.drawerTitle")}
            >
              <ChannelAdapterList
                channels={channels}
                pluginChannels={pluginChannels}
                selectedKey={selectedKey}
                onSelect={handleSelect}
              />
            </SideListDrawer>
          </>
        )}

        {/* Slack and Email bring their own cards so they render bare; the
            other adapters get a DetailCard wrapper. Both scroll as a whole
            when the stacked content overflows; the per-channel list
            self-bounds its own rows within that. */}
        <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {selectedKey === "slack" || selectedKey === "email" ? (
            detail
          ) : (
            <DetailCard>{detail}</DetailCard>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={pendingDisconnect !== null}
        title={t("assistantChannelsList.disconnectTitle", {
          channel: disconnectMeta ? t(disconnectMeta.labelKey) : "",
        })}
        message={
          disconnectMeta?.disconnectMessageKey
            ? t(disconnectMeta.disconnectMessageKey)
            : ""
        }
        confirmLabel={t("assistantChannelsList.disconnectConfirm")}
        destructive
        onConfirm={() => {
          if (pendingDisconnect && onDisconnect) {
            onDisconnect(pendingDisconnect);
          }
          setPendingDisconnect(null);
        }}
        onCancel={() => setPendingDisconnect(null)}
      />
    </>
  );
}
