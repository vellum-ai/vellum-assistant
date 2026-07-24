import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";

import { EmptyState } from "@/components/empty-state";
import {
  SlackSetupWizard,
  type MutationStatus,
} from "@/components/slack-setup-wizard";
import { CHANNEL_META } from "@/domains/channels/channel-meta";
import { ChannelTrustFloorSection } from "@/domains/channels/components/channel-trust-floor-section";
import { ConnectedChannelHeader } from "@/domains/channels/components/connected-channel-header";
import { SlackChannelCard } from "@/domains/channels/components/slack-channel-card";
import { SlackChannelSection } from "@/domains/channels/components/slack-channel-section";
import { SlackConnectionCard } from "@/domains/channels/components/slack-connection-card";
import {
  SlackThreadBehavior,
  type SlackThreadMode,
} from "@/domains/channels/components/slack-thread-behavior";
import { TelegramCredentialEntry } from "@/domains/channels/components/telegram-credential-entry";
import { TwilioCredentialEntry } from "@/domains/channels/components/twilio-credential-entry";
import type { AdmissionPolicy } from "@/lib/channel-admission-policy/types";
import type { AssistantChannelState } from "@/types/channel-types";
import { ChannelIcon, getChannelLabel } from "@/utils/channel-presentation";

interface ChannelPanelProps {
  channel: AssistantChannelState;
  assistantId: string;
  assistantName: string;
  /** Trimmed assistant name with a "your assistant" fallback, for copy. */
  assistantDisplayName: string;
  pending: boolean;
  /**
   * Open the manual credential form immediately instead of the empty state —
   * set for `?setup=<channel>` deep links (e.g. the mobile chat-drawer
   * handoff continues credential entry here).
   */
  initialManualEntry?: boolean;
  onSetup?: () => void;
  onDisconnect?: () => void;
  onSaveTelegramToken?: (botToken: string) => Promise<void>;
  onSaveSlackConfig?: (botToken: string, appToken: string) => void;
  slackSaveStatus?: MutationStatus;
  slackSaveError?: string | null;
  slackThreadMode?: SlackThreadMode;
  slackThreadModePending?: boolean;
  onSlackThreadModeChange?: (mode: SlackThreadMode) => void;
  onSaveTwilioCredentials?: (
    accountSid: string,
    authToken: string,
  ) => Promise<void>;
  policy?: AdmissionPolicy;
  policySaving?: boolean;
  policyLoading?: boolean;
  policyError?: boolean;
  onPolicyChange?: (policy: AdmissionPolicy) => void;
}

/**
 * The selected adapter's detail panel in the Channels tab's master-detail
 * surface. Slack renders its own connected/disconnected cards (connection card
 * vs. setup wizard); Telegram and Phone share a single-credential shape —
 * connected shows the connection header plus the trust-floor control,
 * disconnected pitches guided setup with a manual credential-entry escape
 * hatch.
 */
export function ChannelPanel({
  channel,
  assistantId,
  assistantName,
  assistantDisplayName,
  pending,
  initialManualEntry = false,
  onSetup,
  onDisconnect,
  onSaveTelegramToken,
  onSaveSlackConfig,
  slackSaveStatus,
  slackSaveError,
  slackThreadMode,
  slackThreadModePending = false,
  onSlackThreadModeChange,
  onSaveTwilioCredentials,
  policy,
  policySaving = false,
  policyLoading = false,
  policyError = false,
  onPolicyChange,
}: ChannelPanelProps) {
  const connected = channel.status === "ready";
  // Manual credential entry is a connect-time affordance, so it only applies
  // while disconnected — seeded from a `?setup=<channel>` deep link. Declared
  // before the Slack branch to keep hook order stable across renders.
  const [manualEntry, setManualEntry] = useState(initialManualEntry);

  // Slack is its own adapter shape — a token-pair channel with dedicated
  // connected/disconnected cards (connection card vs. setup wizard) that own
  // their card chrome, so it returns bare (the parent skips the DetailCard).
  if (channel.key === "slack") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {connected ? (
          <SlackConnectionCard
            slackHandle={channel.address}
            disconnectPending={pending}
            onDisconnect={onDisconnect}
          >
            <SlackThreadBehavior
              threadMode={slackThreadMode}
              threadModePending={slackThreadModePending}
              onThreadModeChange={onSlackThreadModeChange}
            />
          </SlackConnectionCard>
        ) : (
          <SlackChannelCard>
            <SlackSetupWizard
              assistantName={assistantName}
              onSave={onSaveSlackConfig}
              saveStatus={slackSaveStatus}
              saveError={slackSaveError}
            />
          </SlackChannelCard>
        )}

        {connected ? (
          <SlackChannelSection
            assistantId={assistantId}
            assistantDisplayName={assistantDisplayName}
            slackHandle={channel.address}
          />
        ) : null}
      </div>
    );
  }

  // Telegram and Phone are single-credential adapters that share one shape.
  // Connected: the connection header plus the trust-floor control. Disconnected:
  // a pitch with guided setup and a manual credential-entry escape hatch. The
  // credential form is a connect-time affordance and never shows while
  // connected — mirroring Slack's setup wizard, so "Connected" never sits next
  // to an empty token field.
  const meta = CHANNEL_META[channel.key];
  return (
    <div className="flex flex-col gap-4">
      {connected ? (
        <>
          <ConnectedChannelHeader
            address={channel.address}
            pending={pending}
            onDisconnect={onDisconnect}
          />
          {meta.hasTrustFloorControl && onPolicyChange ? (
            <ChannelTrustFloorSection
              assistantDisplayName={assistantDisplayName}
              policy={policy}
              saving={policySaving}
              loading={policyLoading}
              error={policyError}
              onChange={onPolicyChange}
            />
          ) : null}
        </>
      ) : manualEntry ? (
        channel.key === "telegram" ? (
          <TelegramCredentialEntry onSave={onSaveTelegramToken} />
        ) : (
          <TwilioCredentialEntry onSave={onSaveTwilioCredentials} />
        )
      ) : (
        // Pitch the channel and point at guided setup, with a
        // manual-credentials escape hatch.
        <EmptyState
          icon={<ChannelIcon channelId={channel.key} className="h-6 w-6" />}
          title={`${getChannelLabel(channel.key)} isn't connected`}
          description={meta.disconnectedPitch?.(assistantDisplayName)}
          action={
            <div className="flex flex-col items-center gap-1">
              <Button
                type="button"
                variant="outlined"
                onClick={onSetup}
                disabled={!onSetup || pending}
              >
                {pending ? "Opening…" : "Set up"}
              </Button>
              <Button
                type="button"
                variant="link"
                onClick={() => setManualEntry(true)}
              >
                or connect manually
              </Button>
            </div>
          }
        />
      )}
    </div>
  );
}
