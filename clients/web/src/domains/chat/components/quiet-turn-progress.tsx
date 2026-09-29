import { useMemo } from "react";

import {
  activityRunSummaryLabel,
  deriveSummaryState,
} from "@/domains/chat/components/multi-activity-group/multi-activity-group";
import { ActivityLinkButton } from "@/domains/chat/components/single-activity/activity-link-button";
import { useToolCallCardDataFromItems } from "@/domains/chat/hooks/use-tool-call-card-data";
import { mergeTurnActivity } from "@/domains/chat/hooks/use-live-activity-group";
import type { ContentBlockGroup } from "@/domains/chat/transcript/message-content";
import type { QuietStep } from "@/domains/chat/transcript/quiet-turn";
import { type TFunction, useTranslation } from "@/i18n";
import { useViewerStore } from "@/stores/viewer-store";

/** The progress line's text: what the assistant is doing, and where. */
export function quietStepLabel(
  t: TFunction<"chat">,
  step: QuietStep | null,
): string {
  if (!step) {
    return t("quietTurnProgress.working");
  }
  let place: string;
  switch (step.place.kind) {
    case "named":
      place = step.place.name;
      break;
    case "files":
      place = t("quietTurnProgress.place.files");
      break;
    case "terminal":
      place = t("quietTurnProgress.place.terminal");
      break;
    case "memory":
      place = t("quietTurnProgress.place.memory");
      break;
    case "web":
      place = t("quietTurnProgress.place.web");
      break;
    case "mac":
      place = t("quietTurnProgress.place.mac");
      break;
  }
  switch (step.verb) {
    case "checking":
      return t("quietTurnProgress.checking", { place });
    case "updating":
      return t("quietTurnProgress.updating", { place });
    case "using":
      return t("quietTurnProgress.using", { place });
  }
}

/**
 * Opens (or closes) the whole-turn steps panel for one row, and reports
 * whether it is the panel currently showing.
 */
function useTurnSteps(
  messageId: string | undefined,
  groups: readonly ContentBlockGroup[],
  live: boolean,
) {
  const toggleActivitySteps = useViewerStore.use.toggleActivitySteps();
  const mainView = useViewerStore.use.mainView();
  const activeActivitySteps = useViewerStore.use.activeActivitySteps();
  const merged = useMemo(() => mergeTurnActivity(groups), [groups]);
  const open = () =>
    toggleActivitySteps({
      messageId,
      wholeTurn: true,
      items: merged.cardItems,
      toolCalls: merged.toolCalls,
      active: live,
    });
  const isOpen =
    mainView === "activity-steps" &&
    activeActivitySteps?.wholeTurn === true &&
    activeActivitySteps.messageId === messageId;
  return { merged, open, isOpen };
}

export interface QuietTurnProgressProps {
  messageId: string | undefined;
  groups: readonly ContentBlockGroup[];
  /** The line's step; `null` while no call names a place. */
  step: QuietStep | null;
}

/**
 * The live quiet turn's one progress line: where the assistant is working
 * now, shimmering, and a way into the steps so far.
 */
export function QuietTurnProgress({
  messageId,
  groups,
  step,
}: QuietTurnProgressProps) {
  const { t } = useTranslation("chat");
  const { open, isOpen } = useTurnSteps(messageId, groups, true);
  const label = quietStepLabel(t, step);
  return (
    <ActivityLinkButton
      dataTestId="quiet-turn-progress"
      ariaLabel={t("quietTurnProgress.showWorkAria", { label })}
      label={label}
      shimmerLabel
      tone="default"
      active={isOpen}
      onClick={open}
    />
  );
}

export interface QuietTurnWorkSummaryProps {
  messageId: string | undefined;
  groups: readonly ContentBlockGroup[];
}

/**
 * A settled quiet turn's "Worked for 2m" control in the message footer. It
 * reads the same run summary as the steps panel's header, so the two agree.
 */
export function QuietTurnWorkSummary({
  messageId,
  groups,
}: QuietTurnWorkSummaryProps) {
  const { t } = useTranslation("chat");
  const { merged, open, isOpen } = useTurnSteps(messageId, groups, false);
  const cardData = useToolCallCardDataFromItems(merged.cardItems);
  const summary = activityRunSummaryLabel(
    t,
    deriveSummaryState(cardData.state, cardData.steps),
    cardData,
  );
  return (
    <ActivityLinkButton
      dataTestId="quiet-turn-work-summary"
      ariaLabel={t("quietTurnProgress.showStepsAria", { summary })}
      label={summary}
      tone="default"
      active={isOpen}
      onClick={open}
      density="compact"
    />
  );
}
