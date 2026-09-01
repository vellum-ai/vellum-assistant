/**
 * The progress control: a bare glyph that opens the assistant's current plan.
 *
 * The plan itself is a `task_progress` card surface, which the assistant emits
 * when it breaks a complicated request into steps. `TranscriptMessageBody`
 * suppresses that surface inline, so this control is its only host and holds a
 * fixed position while the thread scrolls.
 *
 * **It is not standing chrome.** It is on screen only while it has something to
 * say, so its presence means "there is something to read here" and its arrival
 * is the notification (see {@link SideControlPresence}).
 *
 * It shows while a plan runs, and keeps showing after one finishes until the
 * user has seen the outcome: leaving on completion would take the result away
 * at the moment it is worth reading. Acknowledgement is opening the panel while
 * the plan is finished (see {@link useProgressAckStore}), and the control
 * leaves on close rather than on open, so the panel does not collapse out from
 * under the click that dismissed it.
 *
 * Only plans this client watched run can announce themselves. The transcript
 * scan reaches into server history, so a thread opened fresh holds plans that
 * finished long ago; those start acknowledged and stay silent.
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
import { useEffect, useRef, useState } from "react";

import { AdaptivePopover } from "@/domains/chat/components/adaptive-popover";
import { SideControlPresence } from "@/domains/chat/components/side-control-presence";
import { SideControlButton } from "@/domains/chat/components/side-control-button";
import { StepProgressRing } from "@/domains/chat/components/step-progress-ring";
import { StreamingShimmerText } from "@/domains/chat/components/streaming-shimmer-text";
import {
  parseTaskProgress,
  TaskProgressBody,
  taskProgressCounter,
} from "@/domains/chat/components/surfaces/card-surface";
import { useLatestTaskProgress } from "@/domains/chat/hooks/use-latest-task-progress";
import { useProgressAckStore } from "@/domains/chat/progress-ack-store";
import { useTranslation } from "@/i18n";

export function ProgressCard() {
  const { t } = useTranslation("chat");
  const surface = useLatestTaskProgress();
  const progress = surface ? parseTaskProgress(surface) : null;

  // A terminal card is settled whatever its steps say. The model can mark a
  // plan done and leave a step reading `in_progress` behind it, which is the
  // same mismatch `effectiveStepStatus` resolves inside the body: without this
  // the pill would shimmer and read "Progress" under a finished plan forever.
  //
  // Short of that, either signal counts. `status` is the model's assertion and
  // is not always set mid-run, while the steps always say what is happening, so
  // a plan with a step in flight is running even if the header has not caught
  // up.
  const isTerminal =
    progress?.status === "completed" || progress?.status === "failed";
  const isRunning =
    !isTerminal &&
    (progress?.status === "in_progress" ||
      (progress?.steps.some((step) => step.status === "in_progress") ?? false));

  const surfaceId = surface?.surfaceId ?? null;
  const acknowledged = useProgressAckStore((s) =>
    surfaceId ? s.acknowledged.has(surfaceId) : false,
  );
  const acknowledge = useProgressAckStore.use.acknowledge();
  const [open, setOpen] = useState(false);

  // Plans this client has watched run. A plan is only worth announcing if its
  // work happened while the user was here: the transcript scan reaches into
  // server history, so opening a thread surfaces plans that finished long ago,
  // and an empty acknowledgement set would present each of them as news.
  const watchedRunning = useRef(new Set<string>());

  useEffect(() => {
    if (!surfaceId) {
      return;
    }
    if (isRunning) {
      watchedRunning.current.add(surfaceId);
      return;
    }
    // Terminal and never seen running: history, so it starts acknowledged and
    // never appears. Terminal after being watched: the outcome is news, and
    // opening the panel is what acknowledges it. The effect covers a plan that
    // finishes while the panel is already open, which an open handler misses.
    if (!watchedRunning.current.has(surfaceId) || open) {
      acknowledge(surfaceId);
    }
  }, [open, surfaceId, isRunning, acknowledge]);

  // Present while there is a live plan, or a finished one the user hasn't read.
  // `open` holds it through the dismissing click: acknowledging on open would
  // otherwise unmount the panel mid-interaction.
  const visible = progress != null && (isRunning || !acknowledged || open);

  // The control names its own state: a running plan reads "Progress", a settled
  // one "Finished". The glyph carries the same distinction, and while running
  // it carries the plan's position too.
  const label = isRunning
    ? t("progressRail.title")
    : t("progressRail.titleFinished");
  const counter = progress
    ? taskProgressCounter(progress.steps)
    : { current: 0, total: 0 };

  const trigger = (
    // `leftIcon` rather than `iconOnly`, so the glyph and the label share the
    // pill. No `tooltip`: it would only repeat the label beside it. The
    // accessible name is that same label, since an `aria-label` that disagreed
    // with the visible text would leave the two audiences reading different
    // states.
    //
    // `loading` is left off: the sweep belongs to the label alone here, not to
    // the whole pill, so the ring stays readable while it runs.
    <SideControlButton
      aria-label={label}
      data-testid="progress-card-toggle"
      leftIcon={
        isRunning ? (
          <StepProgressRing current={counter.current} total={counter.total} />
        ) : (
          <CircleCheck />
        )
      }
      className="px-3"
    >
      {isRunning ? (
        <StreamingShimmerText data-testid="progress-label-shimmer">
          {label}
        </StreamingShimmerText>
      ) : (
        label
      )}
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
