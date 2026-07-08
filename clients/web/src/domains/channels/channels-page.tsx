import { DetailCard } from "@/components/detail-card";
import { assistantDisplayName } from "@/utils/assistant-display-name";
import { AssistantChannelsList } from "@/domains/channels/components/assistant-channels-list";
import { GenerateInviteLinkDialog } from "@/components/generate-invite-link-dialog";
import { ShareConnectionLinkButton } from "@/components/share-connection-link-button";
import { useAssistantChannels } from "@/hooks/use-assistant-channels";
import { useInviteLinkDialog } from "@/hooks/use-invite-link-dialog";
import { useSetupChannelParam } from "@/domains/channels/hooks/use-setup-channel-param";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

export interface ChannelsPageProps {
  assistantId: string;
  onStartSetupConversation?: (prompt: string) => void;
}

/**
 * Channels settings — the Slack/Telegram/Phone master-detail surface where
 * the guardian manages how and where the assistant can be reached. Rendered
 * as its own tab in the About Assistant nav (`/assistant/channels`): a
 * page-level subtitle above the adapter list + detail panel (the nav's tab
 * already reads "Channels", so the page repeats no heading). The Contacts
 * page's assistant detail (`AssistantChannelsDetail`) shows only a
 * connect/disconnect summary of the same channels; management stays here.
 */
export function ChannelsPage({
  assistantId,
  onStartSetupConversation,
}: ChannelsPageProps) {
  const a2aChannel = useAssistantFeatureFlagStore.use.a2aChannel();
  const identityName = useAssistantIdentityStore.use.name();
  const setupChannel = useSetupChannelParam();
  const inviteDialog = useInviteLinkDialog(assistantId);

  const displayName = assistantDisplayName(identityName);

  const channelsController = useAssistantChannels({
    assistantId,
    onStartSetupConversation,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden">
      <DetailCard
        showBorder={false}
        subtitle={`Manage where ${displayName} can be reached.`}
      />

      <AssistantChannelsList
        assistantId={assistantId}
        assistantName={displayName}
        initialChannel={setupChannel}
        {...channelsController}
      />

      {a2aChannel ? (
        <ShareConnectionLinkButton onClick={inviteDialog.open} />
      ) : null}

      <GenerateInviteLinkDialog
        open={inviteDialog.isOpen}
        assistantId={assistantId}
        onClose={inviteDialog.close}
      />
    </div>
  );
}
