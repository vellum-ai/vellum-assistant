import { useEffect, useState } from "react";

import { cn } from "@vellumai/design-library";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { DetailCard } from "@/components/detail-card";
import {
  MobileSidebarDrawer,
  MobileSidebarTrigger,
} from "@/components/mobile-sidebar-drawer";
import type { MutationStatus } from "@/components/slack-setup-wizard";
import { useChannelAdapterSelectionStore } from "@/domains/channels/adapter-selection-store";
import { CHANNEL_META } from "@/domains/channels/channel-meta";
import { ChannelAdapterList } from "@/domains/channels/components/channel-adapter-list";
import { ChannelPanel } from "@/domains/channels/components/channel-panel";
import type { SlackThreadMode } from "@/domains/channels/components/slack-thread-behavior";
import type { AdmissionPolicy } from "@/lib/channel-admission-policy/types";
import type {
  AssistantChannelState,
  SetupChannelId,
} from "@/types/channel-types";
import { assistantDisplayName as toAssistantDisplayName } from "@/utils/assistant-display-name";

type ChannelKey = SetupChannelId;

/**
 * Floors that loosen or hard-deny who can reach the assistant and warrant an
 * explicit confirmation before persisting. Floors not listed here apply
 * immediately. Web-only UI concern — the cross-surface contract lives in
 * `@/lib/channel-admission-policy/types`.
 */
const POLICY_CONFIRMATIONS: Partial<
  Record<
    AdmissionPolicy,
    {
      title: string;
      message: string;
      confirmLabel: string;
      destructive?: boolean;
    }
  >
> = {
  no_one: {
    title: "Block all messages?",
    message:
      "Setting this channel to “No one” hard-denies every inbound message — including messages from you.\n\nYou can reverse this at any time.",
    confirmLabel: "Block all",
    destructive: true,
  },
  any_contact: {
    title: "Allow any contact?",
    message:
      "“Any contact” admits every matched contact in this channel — including pending, unverified ones — not just your verified contacts.\n\nBest for channels consisting of only people you already trust.",
    confirmLabel: "Allow any contact",
  },
  strangers: {
    title: "Allow strangers?",
    message:
      "Are you sure you want to allow strangers to contact your assistant through this channel?\n\nDoing so could cost you money and open you up to security and privacy vulnerabilities.\n\nEnable with extreme caution.",
    confirmLabel: "Allow strangers",
    destructive: true,
  },
};

export interface AssistantChannelsListProps {
  /** Needed by the Slack sub-tab's channel list, which owns its own data. */
  assistantId: string;
  assistantName: string;
  channels: AssistantChannelState[];
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
  onSetup?: (channelKey: ChannelKey) => void;
  onDisconnect?: (channelKey: ChannelKey) => void;
  onSaveTelegramToken?: (botToken: string) => Promise<void>;
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
 * adapter's detail panel (`ChannelPanel`), plus the disconnect and trust-floor
 * confirmation dialogs. Rendered by the Channels tab (`ChannelsPage`). The
 * active adapter persists in `adapter-selection-store`; the queries and
 * mutations behind the props live in `useAssistantChannels`.
 */
export function AssistantChannelsList({
  assistantId,
  assistantName,
  channels,
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
  onSaveSlackConfig,
  slackSaveStatus,
  slackSaveError,
  onSlackThreadModeChange,
  onSaveTwilioCredentials,
  initialChannel = null,
}: AssistantChannelsListProps) {
  const selectedAdapter = useChannelAdapterSelectionStore.use.selectedAdapter();
  const selectAdapter = useChannelAdapterSelectionStore.use.selectAdapter();

  const [pendingDisconnect, setPendingDisconnect] = useState<ChannelKey | null>(
    null,
  );
  // Floor confirmation: non-null while a floor in POLICY_CONFIRMATIONS awaits
  // the user's go-ahead before persisting.
  const [pendingPolicy, setPendingPolicy] = useState<{
    channelKey: ChannelKey;
    policy: AdmissionPolicy;
  } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
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
  const pendingConfirmation = pendingPolicy
    ? POLICY_CONFIRMATIONS[pendingPolicy.policy]
    : null;

  // Floors that loosen or hard-deny access prompt a confirmation before
  // persisting; every other floor applies immediately.
  const handlePolicyChange = (
    channelKey: ChannelKey,
    next: AdmissionPolicy,
  ) => {
    if (POLICY_CONFIRMATIONS[next]) {
      setPendingPolicy({ channelKey, policy: next });
      return;
    }
    onChannelPolicyChange?.(channelKey, next);
  };

  const handleSelect = (channelKey: ChannelKey) => {
    selectAdapter(channelKey);
    setDrawerOpen(false);
  };

  // The persisted selection falls back to the first adapter if it names one
  // that isn't present (the adapter set is fixed, so this is defensive).
  const selected =
    channels.find((channel) => channel.key === selectedAdapter) ?? channels[0];

  if (!selected) {
    return null;
  }

  // Keyed on the adapter so switching selection remounts the panel: its
  // credential-form state (`initialManualEntry`) is seeded once at mount,
  // and each adapter should start fresh.
  const detail = (
    <ChannelPanel
      key={selected.key}
      channel={selected}
      assistantId={assistantId}
      assistantName={assistantName}
      assistantDisplayName={displayName}
      pending={pendingChannelKey === selected.key}
      initialManualEntry={setupChannel === selected.key}
      onSetup={onSetup ? () => onSetup(selected.key) : undefined}
      onDisconnect={
        onDisconnect ? () => setPendingDisconnect(selected.key) : undefined
      }
      onSaveTelegramToken={onSaveTelegramToken}
      onSaveSlackConfig={onSaveSlackConfig}
      slackSaveStatus={slackSaveStatus}
      slackSaveError={slackSaveError}
      slackThreadMode={slackThreadMode}
      slackThreadModePending={slackThreadModePending}
      onSlackThreadModeChange={onSlackThreadModeChange}
      onSaveTwilioCredentials={onSaveTwilioCredentials}
      policy={channelPolicies?.[selected.key]}
      policySaving={policySavingKey === selected.key}
      policyLoading={policiesLoading}
      policyError={policiesError}
      onPolicyChange={
        onChannelPolicyChange
          ? (next) => handlePolicyChange(selected.key, next)
          : undefined
      }
    />
  );

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden sm:flex-row sm:gap-6">
        <div className="flex items-center sm:hidden">
          <MobileSidebarTrigger onClick={() => setDrawerOpen(true)} />
        </div>

        <MobileSidebarDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title="Channels"
        >
          <ChannelAdapterList
            channels={channels}
            selectedKey={selected.key}
            onSelect={handleSelect}
          />
        </MobileSidebarDrawer>

        <aside className="hidden min-h-0 w-[320px] shrink-0 overflow-y-auto self-stretch sm:block">
          <ChannelAdapterList
            channels={channels}
            selectedKey={selected.key}
            onSelect={handleSelect}
          />
        </aside>

        {/* Slack brings its own cards (connection card + channel list) and owns
            its internal table scroll, so it fills the panel; the other adapters
            render bare content in a scrollable card to match. */}
        <section
          className={cn(
            "min-h-0 min-w-0 flex-1",
            selected.key === "slack"
              ? "flex flex-col overflow-hidden"
              : "overflow-y-auto",
          )}
        >
          {selected.key === "slack" ? detail : <DetailCard>{detail}</DetailCard>}
        </section>
      </div>

      <ConfirmDialog
        open={pendingDisconnect !== null}
        title={`Disconnect ${disconnectMeta?.label ?? ""}?`}
        message={disconnectMeta?.disconnectMessage ?? ""}
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => {
          if (pendingDisconnect && onDisconnect) {
            onDisconnect(pendingDisconnect);
          }
          setPendingDisconnect(null);
        }}
        onCancel={() => setPendingDisconnect(null)}
      />

      {/* Floor confirmation — loosening or hard-denying access needs a nod. */}
      <ConfirmDialog
        open={pendingPolicy !== null}
        title={pendingConfirmation?.title ?? ""}
        message={pendingConfirmation?.message ?? ""}
        confirmLabel={pendingConfirmation?.confirmLabel ?? "Confirm"}
        destructive={pendingConfirmation?.destructive ?? false}
        onConfirm={() => {
          if (pendingPolicy) {
            onChannelPolicyChange?.(
              pendingPolicy.channelKey,
              pendingPolicy.policy,
            );
          }
          setPendingPolicy(null);
        }}
        onCancel={() => setPendingPolicy(null)}
      />
    </>
  );
}
