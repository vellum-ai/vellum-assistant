import { AssistantInboxShell } from "./assistant-inbox-shell";
import {
  AssistantInboxUpgradeCard,
  type AssistantInboxUpgradeCardProps,
} from "./assistant-inbox-upgrade-card";

export type AssistantInboxUpgradeStateProps = AssistantInboxUpgradeCardProps;

/**
 * The inbox on a plan without managed email: the upgrade card, centred in
 * the inbox's frame, and nothing else. The handle was fixed at onboarding
 * and the prefix is asked for after the upgrade, so no field belongs here.
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
