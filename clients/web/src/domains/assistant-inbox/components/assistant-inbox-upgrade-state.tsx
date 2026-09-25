import { useInboxPitchCopy } from "../hooks/use-inbox-pitch-copy";
import { AssistantInboxPageFrame } from "./assistant-inbox-page-frame";
import {
  AssistantInboxUpgradeBody,
  type AssistantInboxUpgradeBodyProps,
} from "./assistant-inbox-upgrade-body";

export interface AssistantInboxUpgradeStateProps extends Omit<
  AssistantInboxUpgradeBodyProps,
  "align" | "footnote"
> {
  /** Leaves the page. */
  onBack?: () => void;
}

/**
 * The inbox on a plan without managed email: the page's frame with the
 * pitch centred in it, as the design draws it. The serif title and its line
 * over the shared body; the handle was fixed at onboarding and the prefix
 * is asked for after the upgrade, so no field belongs here.
 */
export function AssistantInboxUpgradeState({
  onBack,
  ...body
}: AssistantInboxUpgradeStateProps) {
  const { title, subtitle } = useInboxPitchCopy(body.assistantName);
  return (
    <AssistantInboxPageFrame onBack={onBack} centered>
      <div
        data-testid="assistant-inbox-upgrade"
        className="flex w-full max-w-[360px] flex-col items-center gap-6 px-4 text-center"
      >
        <div className="flex flex-col items-center gap-2">
          <h2
            className="text-[var(--content-emphasised)]"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "22px",
              lineHeight: 1.25,
              letterSpacing: "0.2px",
            }}
          >
            {title}
          </h2>
          <p className="text-body-small-default text-[var(--content-default)]">
            {subtitle}
          </p>
        </div>
        <AssistantInboxUpgradeBody {...body} align="center" />
      </div>
    </AssistantInboxPageFrame>
  );
}
