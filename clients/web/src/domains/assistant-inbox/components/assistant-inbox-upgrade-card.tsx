import { useInboxPitchCopy } from "../hooks/use-inbox-pitch-copy";
import {
  AssistantInboxUpgradeBody,
  type AssistantInboxUpgradeBodyProps,
} from "./assistant-inbox-upgrade-body";
import { InboxCard } from "./inbox-card";

export type AssistantInboxUpgradeCardProps = Omit<
  AssistantInboxUpgradeBodyProps,
  "align" | "footnote"
>;

/**
 * The upgrade pitch as a card of its own: the serif title and its line over
 * the shared body, everything centred. This is the whole of the inbox's
 * upgrade state. The Channels page sets the same body under its Email
 * section's header instead, with no card inside that card.
 */
export function AssistantInboxUpgradeCard(
  props: AssistantInboxUpgradeCardProps,
) {
  const { title, subtitle } = useInboxPitchCopy(props.assistantName);
  return (
    <InboxCard title={title} subtitle={subtitle}>
      <AssistantInboxUpgradeBody {...props} align="center" />
    </InboxCard>
  );
}
