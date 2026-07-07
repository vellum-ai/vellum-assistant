import { DetailCard } from "@/components/detail-card";
import { assistantDisplayName } from "@/domains/contacts/assistant-display-name";
import {
    AssistantContactChannels,
    type AssistantContactChannelsProps,
} from "@/domains/contacts/components/assistant-contact-channels";
import { ContactTypeBadge } from "@/domains/contacts/components/contact-type-badge";

interface AssistantChannelsDetailProps extends AssistantContactChannelsProps {
  assistantName: string;
}

/**
 * The assistant's entry in the Contacts detail pane: the contact-style
 * identity header card followed by a per-adapter connected/disconnected
 * summary in a "Channels" card. Channel management — credential forms,
 * trust floors, Slack settings — lives in the standalone Channels tab
 * (`AssistantChannelsList`), not here.
 */
export function AssistantChannelsDetail({
  assistantName,
  ...channelsProps
}: AssistantChannelsDetailProps) {
  const displayName = assistantDisplayName(assistantName);

  return (
    <div className="flex flex-col gap-6">
      <DetailCard
        title={`${displayName} (Your Assistant)`}
        accessory={<ContactTypeBadge role="assistant" />}
        compactAccessory
      />

      <DetailCard
        title="Channels"
        subtitle={`Where ${displayName} can be reached.`}
      >
        <AssistantContactChannels {...channelsProps} />
      </DetailCard>
    </div>
  );
}
