import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";

import { useTranslation } from "@/i18n";
import type { MutationStatus } from "@/components/channel-setup-wizard";
import { EmptyState } from "@/components/empty-state";
import { SlackSetupWizard } from "@/components/slack-setup-wizard";
import { TelegramSetupWizard } from "@/components/telegram-setup-wizard";
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
  onSaveTelegramToken?: (botToken: string) => void;
  telegramSaveStatus?: MutationStatus;
  telegramSaveError?: string | null;
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
  telegramSaveStatus,
  telegramSaveError,
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
  const { t } = useTranslation("channels");
  const connected = channel.status === "ready";
  // Manual credential entry is a connect-time affordance, so it only applies
  // while disconnected — seeded from a `?setup=<channel>` deep link. Declared
  // before the Slack branch to keep hook order stable across renders.
  const incomplete = channel.status === "incomplete";
  const [manualEntry, setManualEntry] = useState(initialManualEntry);

  // Slack is its own adapter shape — a token-pair channel with dedicated
  // connected/disconnected cards (connection card vs. setup wizard) that own
  // their card chrome, so it returns bare (the parent skips the DetailCard). The
  // cards stack at natural height and the parent section owns the vertical
  // scroll, so no min-h-0/flex-1 fill here.
  if (channel.key === "slack") {
    return (
      <div className="flex flex-col gap-4">
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
          <TelegramSetupWizard
            assistantName={assistantName}
            saveStatus={telegramSaveStatus}
            saveError={telegramSaveError}
            onSave={onSaveTelegramToken}
          />
        ) : (
          <TwilioCredentialEntry onSave={onSaveTwilioCredentials} />
        )
      ) : (
        // Two different states share this branch. `not_configured` has never
        // been set up and gets the pitch. `incomplete` holds credentials that
        // are not delivering, so pitching the channel would hide that setup
        // already happened and something after it failed.
        <EmptyState
          icon={<ChannelIcon channelId={channel.key} className="h-6 w-6" />}
          title={
            incomplete
              ? t("channelPanel.incompleteTitle", {
                  channel: getChannelLabel(channel.key),
                })
              : t("channelPanel.disconnectedTitle", {
                  channel: getChannelLabel(channel.key),
                })
          }
          description={
            incomplete
              ? (channel.warning ??
                t("channelPanel.incompleteDescription", {
                  channel: getChannelLabel(channel.key),
                }))
              : meta.disconnectedPitchKey
                ? t(meta.disconnectedPitchKey, {
                    assistant: assistantDisplayName,
                  })
                : undefined
          }
          action={
            <div className="flex flex-col items-center gap-1">
              <Button
                type="button"
                variant="outlined"
                onClick={onSetup}
                disabled={!onSetup || pending}
              >
                {pending
                  ? t("channelPanel.opening")
                  : incomplete
                    ? t("channelPanel.finishSetup")
                    : t("channelPanel.setUp")}
              </Button>
              <Button
                type="button"
                variant="link"
                onClick={() => setManualEntry(true)}
              >
                {t("channelPanel.connectManually")}
              </Button>
            </div>
          }
        />
      )}
    </div>
  );
}
