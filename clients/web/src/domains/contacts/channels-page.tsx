import { DetailCard } from "@/components/detail-card";
import { assistantDisplayName } from "@/domains/contacts/assistant-display-name";
import { AssistantChannelsList } from "@/domains/contacts/components/assistant-channels-list";
import { GenerateInviteLinkDialog } from "@/domains/contacts/components/generate-invite-link-dialog";
import { ShareConnectionLinkButton } from "@/domains/contacts/components/share-connection-link-button";
import { useAssistantChannels } from "@/domains/contacts/hooks/use-assistant-channels";
import { useInviteLinkDialog } from "@/domains/contacts/hooks/use-invite-link-dialog";
import { useSetupChannelParam } from "@/domains/contacts/hooks/use-setup-channel-param";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

export interface ChannelsPageProps {
  assistantId: string;
  onStartSetupConversation?: (prompt: string) => void;
}

/**
 * Channels settings — the Slack/Telegram/Phone sub-tabs where the guardian
 * manages how and where the assistant can be reached. Rendered as its own tab
 * in the About Assistant nav (`/assistant/channels`): a page-level subtitle
 * above the tabbed content (the nav's tab already reads "Channels", so the
 * page repeats no heading). The Contacts page's assistant detail
 * (`AssistantChannelsDetail`) shows only a connect/disconnect summary of the
 * same channels; management stays here.
 */
export function ChannelsPage({
  assistantId,
  onStartSetupConversation,
}: ChannelsPageProps) {
  const a2aChannel = useAssistantFeatureFlagStore.use.a2aChannel();
  // The Channels-tab restructure (sub-tabs + promoted subtitle) ships with
  // the channel-trust-floors arc; off keeps the titled card + accordion.
  const tabbedLayout = useAssistantFeatureFlagStore.use.channelTrustFloors();
  const identityName = useAssistantIdentityStore.use.name();
  const setupChannel = useSetupChannelParam();
  const inviteDialog = useInviteLinkDialog(assistantId);

  const displayName = assistantDisplayName(identityName);

  const channelsController = useAssistantChannels({
    assistantId,
    onStartSetupConversation,
  });

  return (
    <div className="flex flex-col gap-6">
      <DetailCard
        showBorder={false}
        title={tabbedLayout ? undefined : "Channels"}
        subtitle={`Manage where ${displayName} can be reached.`}
      />

      <DetailCard>
        <AssistantChannelsList
          assistantName={displayName}
          initialChannel={setupChannel}
          {...channelsController}
        />
      </DetailCard>

      {a2aChannel ? <ShareConnectionLinkButton onClick={inviteDialog.open} /> : null}

      <GenerateInviteLinkDialog
        open={inviteDialog.isOpen}
        assistantId={assistantId}
        onClose={inviteDialog.close}
      />
    </div>
  );
}
