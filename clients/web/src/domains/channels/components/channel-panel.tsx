import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";

import { useTranslation } from "@/i18n";
import type { MutationStatus } from "@/components/channel-setup-wizard";
import { DetailCard } from "@/components/detail-card";
import { EmptyState } from "@/components/empty-state";
import { DiscordSetupWizard } from "@/components/discord-setup-wizard";
import { SlackSetupWizard } from "@/components/slack-setup-wizard";
import { TelegramSetupWizard } from "@/components/telegram-setup-wizard";
import {
  CHANNEL_META,
  type ChannelCredentialForm,
} from "@/domains/channels/channel-meta";
import { ChannelTrustFloorSection } from "@/domains/channels/components/channel-trust-floor-section";
import { EmailChannelSection } from "@/domains/channels/components/email-channel-section";
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
  onSaveDiscordToken?: (botToken: string) => void;
  discordSaveStatus?: MutationStatus;
  discordSaveError?: string | null;
  /** The install link, read back from the daemon when the token validates. */
  discordInviteUrl?: string;
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
  onSaveDiscordToken,
  discordSaveStatus,
  discordSaveError = null,
  discordInviteUrl,
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
  // Setup, not health: a configured channel that is down keeps its card and
  // reports the outage on the badge, rather than being sent back through the
  // wizard to re-enter credentials that are already correct.
  // Manual credential entry is a connect-time affordance, so it only applies
  // while disconnected — seeded from a `?setup=<channel>` deep link. Declared
  // before the Slack branch to keep hook order stable across renders.
  const incomplete = channel.status === "incomplete";
  const [manualEntry, setManualEntry] = useState(initialManualEntry);

  // Discord flips configured the moment its token stores, which would swap
  // this panel to the connected header mid-wizard and hide the invite step.
  // A save performed while the manual form is open keeps the wizard until
  // the user navigates away.
  const discordFlowActive =
    channel.key === "discord" && manualEntry && discordSaveStatus === "success";
  const connected = channel.configured && !discordFlowActive;

  // Slack is its own adapter shape — a token-pair channel with dedicated
  // connected/disconnected cards (connection card vs. setup wizard) that own
  // their card chrome, so it returns bare (the parent skips the DetailCard). The
  // cards stack at natural height and the parent section owns the vertical
  // scroll, so no min-h-0/flex-1 fill here.
  // Email's setup is address and domain management on the platform plus a
  // bring-your-own provider key, not a credential wizard, so its section owns
  // the whole surface across connected and unconfigured states. Like Slack it
  // returns bare (the parent skips the DetailCard) because its cards carry
  // their own chrome; the trust floor, the one generic control it shares with
  // the other channels, gets its own card and shows only once an address can
  // actually receive mail, matching the connected-only gate below.
  if (channel.key === "email") {
    return (
      <div className="flex flex-col gap-4">
        <EmailChannelSection />
        {connected && onPolicyChange ? (
          <DetailCard>
            <ChannelTrustFloorSection
              assistantDisplayName={assistantDisplayName}
              policy={policy}
              saving={policySaving}
              loading={policyLoading}
              error={policyError}
              onChange={onPolicyChange}
            />
          </DetailCard>
        ) : null}
      </div>
    );
  }

  if (channel.key === "slack") {
    return (
      <div className="flex flex-col gap-4">
        {connected ? (
          <SlackConnectionCard
            slackHandle={channel.address}
            health={channel.health}
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

  // The one place a declared form picks its writer. Exhaustive, so a channel
  // declaring a form this switch does not name fails to compile instead of
  // receiving another channel's writer. Slack renders its wizard in the
  // dedicated branch above, so its arm here draws nothing.
  const renderCredentialForm = (form: ChannelCredentialForm) => {
    switch (form) {
      case "slack-wizard":
        return null;
      case "telegram-token":
        return (
          <TelegramSetupWizard
            assistantName={assistantName}
            saveStatus={telegramSaveStatus}
            saveError={telegramSaveError}
            onSave={onSaveTelegramToken}
          />
        );
      case "discord-token":
        return (
          <DiscordSetupWizard
            saveStatus={discordSaveStatus}
            saveError={discordSaveError}
            onSave={onSaveDiscordToken}
            {...(discordInviteUrl ? { inviteUrl: discordInviteUrl } : {})}
          />
        );
      case "twilio-credentials":
        return <TwilioCredentialEntry onSave={onSaveTwilioCredentials} />;
      default:
        return form satisfies never;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {connected ? (
        <>
          <ConnectedChannelHeader
            health={channel.health}
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
      ) : manualEntry && channel.canManualEntry && meta.credentialForm ? (
        renderCredentialForm(meta.credentialForm)
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
              {/* Slack returns above with its wizard rendered inline, so a
                  channel reaching here either has a form to open behind the
                  link or has none at all. */}
              {channel.canManualEntry && meta.credentialForm ? (
                <Button
                  type="button"
                  variant="link"
                  onClick={() => setManualEntry(true)}
                >
                  {t("channelPanel.connectManually")}
                </Button>
              ) : null}
            </div>
          }
        />
      )}
    </div>
  );
}
