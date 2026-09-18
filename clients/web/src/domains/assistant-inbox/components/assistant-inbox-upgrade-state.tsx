import { AssistantInboxShell } from "./assistant-inbox-shell";
import {
  AssistantInboxUpgradeCard,
  type AssistantInboxUpgradeCardProps,
} from "./assistant-inbox-upgrade-card";

export type AssistantInboxUpgradeStateProps = AssistantInboxUpgradeCardProps;

/**
 * The inbox on a plan without managed email: the upgrade card, centred in
 * the inbox's frame, and nothing else. The prefix is asked for after the
 * upgrade; the one thing open here is the handle, which the card lets the
 * reader claim beside the example address.
 */
export function AssistantInboxUpgradeState(
  props: AssistantInboxUpgradeStateProps,
) {
  return (
    <AssistantInboxShell>
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <AssistantInboxUpgradeCard {...props} />
      </div>
    </AssistantInboxShell>
  );
}
