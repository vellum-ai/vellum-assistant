/**
 * The progress control: a bare glyph that opens the assistant's current plan.
 *
 * The plan itself is a `task_progress` card surface, which the assistant emits
 * when it breaks a complicated request into steps. It used to render inline in
 * the transcript, where it scrolled out of view exactly when it was most
 * useful. `TranscriptMessageBody` now suppresses it and this control is its
 * only host.
 *
 * **It is not standing chrome.** It appears when a plan starts and leaves once
 * the user has seen how that plan ended, so its presence alone means "there is
 * something to read here" and its arrival is the notification. That is what
 * earns it the entrance animation (see {@link ProgressEntrance}); a control
 * that was always there could not say anything by showing up.
 *
 * The leaving half is the subtle one. A finished plan does NOT disappear on
 * completion, because that is the moment the outcome is worth reading and it
 * would vanish exactly as you looked at it. It stays until acknowledged, and
 * acknowledgement means the user opened it while it was finished — see
 * {@link useProgressAckStore}. It then goes on close, not on open, so the panel
 * doesn't collapse out from under the click that dismissed it.
 *
 * It carries its label, unlike the Agents control beside it. Agents identifies
 * itself with the agents' own marks, which say who is working better than a
 * word would; a bare check glyph says nothing on its own, so this one is named.
 *
 * While the plan runs, the WHOLE button shimmers rather than a label, because
 * there is no label to sweep. See {@link ShimmerSurface}.
 */

import { CircleCheck } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect, useState } from "react";

import { AdaptivePopover } from "@/domains/chat/components/adaptive-popover";
import { SideControlPresence } from "@/domains/chat/components/side-control-presence";
import { SideControlButton } from "@/domains/chat/components/side-control-button";
import {
  parseTaskProgress,
  TaskProgressBody,
} from "@/domains/chat/components/surfaces/card-surface";
import { useLatestTaskProgress } from "@/domains/chat/hooks/use-latest-task-progress";
import { useProgressAckStore } from "@/domains/chat/progress-ack-store";
import { useTranslation } from "@/i18n";

export function ProgressCard() {
  const { t } = useTranslation("chat");
  const surface = useLatestTaskProgress();
  const progress = surface ? parseTaskProgress(surface) : null;

  // Either signal counts. `status` is the model's own assertion about the card
  // and it is not always set mid-run, while the steps always say what is
  // happening — so a plan with a step in flight counts as running even if the
  // card header hasn't caught up.
  const isRunning =
    progress?.status === "in_progress" ||
    (progress?.steps.some((step) => step.status === "in_progress") ?? false);

  const surfaceId = surface?.surfaceId ?? null;
  const acknowledged = useProgressAckStore((s) =>
    surfaceId ? s.acknowledged.has(surfaceId) : false,
  );
  const acknowledge = useProgressAckStore.use.acknowledge();
  const [open, setOpen] = useState(false);

  // Opening a finished plan IS the acknowledgement. Done in an effect rather
  // than in the open handler so a plan that finishes while the panel is
  // already open also counts as seen.
  useEffect(() => {
    if (open && surfaceId && !isRunning) {
      acknowledge(surfaceId);
    }
  }, [open, surfaceId, isRunning, acknowledge]);

  // Present while there is a live plan, or a finished one the user hasn't read.
  // `open` holds it through the dismissing click: acknowledging on open would
  // otherwise unmount the panel mid-interaction.
  const visible = progress != null && (isRunning || !acknowledged || open);

  const trigger = (
    // `leftIcon` rather than `iconOnly`, so the glyph and the label share the
    // pill. No `tooltip`: it would only repeat the label now beside it.
    <SideControlButton
      loading={isRunning}
      aria-label={t("progressRail.toggleAria")}
      data-testid="progress-card-toggle"
      leftIcon={<CircleCheck />}
      className="px-3"
    >
      {t("progressRail.title")}
    </SideControlButton>
  );

  return (
    // The presence wrapper is INSIDE this component's own `AnimatePresence`,
    // so toggling `visible` plays the exit. Keyed on the plan, so each new plan
    // plays its own arrival and a re-render of the same one does not.
    <AnimatePresence>
      {visible && progress ? (
        <SideControlPresence key={surfaceId ?? "plan"}>
          <AdaptivePopover
            trigger={trigger}
            title={t("progressRail.title")}
        // The body leads with the plan's own title; a second heading above it
        // just said "Progress" over something already named.
        hideTitle
            className="w-[min(600px,calc(100vw-2rem))] p-0"
            contentMaxHeightClassName="max-h-[420px]"
            open={open}
            onOpenChange={setOpen}
          >
            <div className="px-4 py-3">
              <TaskProgressBody progress={progress} />
            </div>
          </AdaptivePopover>
        </SideControlPresence>
      ) : null}
    </AnimatePresence>
  );
}
