import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { AssistantChannelsDetail } from "@/domains/contacts/components/assistant-channels-detail";
import { GenerateInviteLinkDialog } from "@/domains/contacts/components/generate-invite-link-dialog";
import { useAssistantChannels } from "@/domains/contacts/hooks/use-assistant-channels";
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
 * in the About Assistant nav (`/assistant/channels`). The same surface also
 * renders inside the Contacts page's assistant detail view; both compose
 * `useAssistantChannels` + `AssistantChannelsDetail`.
 */
export function ChannelsPage({
  assistantId,
  onStartSetupConversation,
}: ChannelsPageProps) {
  const a2aChannel = useAssistantFeatureFlagStore.use.a2aChannel();
  const identityName = useAssistantIdentityStore.use.name();
  const queryClient = useQueryClient();

  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

  const assistantName = identityName ?? "your assistant";

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
    <div className="mx-auto w-full max-w-3xl">
      <AssistantChannelsDetail
        assistantName={assistantName}
        showIdentityCard={false}
        onGenerateInviteLink={a2aChannel ? handleOpenInviteLink : undefined}
        {...channelsController}
      />

      <GenerateInviteLinkDialog
        open={inviteDialogOpen}
        assistantId={assistantId}
        onClose={handleInviteClose}
      />
    </div>
  );
}
