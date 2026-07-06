import { DetailCard } from "@/components/detail-card";
import { AssistantChannelsList, type AssistantChannelsListProps } from "@/domains/contacts/components/assistant-channels-list";
import { ContactTypeBadge } from "@/domains/contacts/components/contact-type-badge";
import { ShareConnectionLinkButton } from "@/domains/contacts/components/share-connection-link-button";

export type { SlackThreadMode } from "@/components/slack-setup-wizard";

interface AssistantChannelsDetailProps extends AssistantChannelsListProps {
  onGenerateInviteLink?: () => void;
}

/**
 * The assistant's entry in the Contacts detail pane: the contact-style
 * identity header card followed by the channel list in a "Channels" card.
 * The standalone Channels tab renders the same `AssistantChannelsList`
 * under its own page heading instead.
 */
export function AssistantChannelsDetail({
  onGenerateInviteLink,
  ...listProps
}: AssistantChannelsDetailProps) {
  const displayName = listProps.assistantName.trim() || "your assistant";

  return (
    <div className="flex flex-col gap-6">
      <DetailCard
        title={`${displayName} (Your Assistant)`}
        accessory={<ContactTypeBadge role="assistant" />}
        compactAccessory
      />

      <DetailCard
        title="Channels"
        subtitle={`Manage where ${displayName} can be reached.`}
      >
        <AssistantChannelsList {...listProps} />
      </DetailCard>

      {onGenerateInviteLink ? <ShareConnectionLinkButton onClick={onGenerateInviteLink} /> : null}
    </div>
  );
}
