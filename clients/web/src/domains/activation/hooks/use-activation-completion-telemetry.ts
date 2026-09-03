/**
 * The funnel's completion step, reported from the client.
 *
 * The daemon owns whether a task is done, and nothing else in the funnel is
 * daemon-side, so the step that says "this task finished" has to be observed
 * where the rest of the funnel is emitted. This watches the progress the
 * surfaces already read and fires once per task the moment its record turns
 * `done`.
 *
 * Only a transition counts. The first snapshot a session sees is taken as the
 * baseline and reported for nothing: a reload after finishing a task would
 * otherwise re-emit its completion on every visit, and the funnel would count
 * one task as many.
 *
 * Every task is watched, starters and the rest of the catalog alike, because
 * the Inspiration List can launch any of them.
 */

import { useEffect, useRef } from "react";

import { emitActivationEvent } from "@/utils/activation-telemetry";

import {
  activationRowStatus,
  useActivationProgress,
} from "./use-activation-progress";

export function useActivationCompletionTelemetry(): void {
  const { data: progress } = useActivationProgress();
  /** Task ids already reported, plus the ones the session opened on. */
  const reported = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!progress) {
      return;
    }
    const done = new Set(
      Object.keys(progress.tasks).filter(
        (taskId) => activationRowStatus(progress.tasks[taskId]) === "done",
      ),
    );
    if (reported.current === null) {
      reported.current = done;
      return;
    }
    for (const taskId of done) {
      if (reported.current.has(taskId)) {
        continue;
      }
      reported.current.add(taskId);
      emitActivationEvent("activation_task_completed", { taskId });
    }
  }, [progress]);
}
