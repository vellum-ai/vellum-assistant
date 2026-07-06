import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { DetailCard } from "@/components/detail-card";
import { AssistantChannelsList } from "@/domains/contacts/components/assistant-channels-list";
import { GenerateInviteLinkDialog } from "@/domains/contacts/components/generate-invite-link-dialog";
import { ShareConnectionLinkButton } from "@/domains/contacts/components/share-connection-link-button";
import { useAssistantChannels } from "@/domains/contacts/hooks/use-assistant-channels";
import { useSetupChannelParam } from "@/domains/contacts/hooks/use-setup-channel-param";
import { contactsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

export interface ChannelsPageProps {
  assistantId: string;
  onStartSetupConversation?: (prompt: string) => void;
}

/**
 * Channels settings — the Slack/Telegram/Phone accordion where the guardian
 * manages how and where the assistant can be reached. Rendered as its own tab
 * in the About Assistant nav (`/assistant/channels`): a page-level heading
 * above the channel list, like the sibling tabs. The Contacts page's
 * assistant detail renders the same list boxed as a card
 * (`AssistantChannelsDetail`); both compose `useAssistantChannels`.
 */
export function ChannelsPage({
  assistantId,
  onStartSetupConversation,
}: ChannelsPageProps) {
  const a2aChannel = useAssistantFeatureFlagStore.use.a2aChannel();
  const identityName = useAssistantIdentityStore.use.name();
  const queryClient = useQueryClient();
  const setupChannel = useSetupChannelParam();

  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

  const displayName = identityName?.trim() || "your assistant";

  const channelsController = useAssistantChannels({
    assistantId,
    onStartSetupConversation,
  });

  const handleOpenInviteLink = useCallback(() => {
    setInviteDialogOpen(true);
  }, []);

  // An invite generated here may already have been redeemed by the time the
  // dialog closes — refresh the Contacts page's cache so the new contact shows.
  const handleInviteClose = useCallback(() => {
    setInviteDialogOpen(false);
    void queryClient.invalidateQueries({
      queryKey: contactsGetQueryKey({ path: { assistant_id: assistantId } }),
    });
  }, [queryClient, assistantId]);

  return (
    <div className="flex flex-col gap-6">
      <DetailCard
        showBorder={false}
        title="Channels"
        subtitle={`Manage where ${displayName} can be reached.`}
      />

      <DetailCard>
        <AssistantChannelsList
          assistantName={displayName}
          initialExpandedChannel={setupChannel}
          {...channelsController}
        />
      </DetailCard>

      {a2aChannel ? <ShareConnectionLinkButton onClick={handleOpenInviteLink} /> : null}

      <GenerateInviteLinkDialog
        open={inviteDialogOpen}
        assistantId={assistantId}
        onClose={handleInviteClose}
      />
    </div>
  );
}
