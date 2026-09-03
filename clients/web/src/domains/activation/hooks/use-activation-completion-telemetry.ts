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
 * The baseline belongs to one assistant. The controller stays mounted across a
 * switch and every assistant works the same catalog, so a baseline carried over
 * would report the tasks the next assistant had already finished as fresh
 * completions and swallow the ones whose ids the last assistant had already
 * reported. Each assistant's first snapshot is therefore its own baseline.
 *
 * Every task is watched, starters and the rest of the catalog alike, because
 * the Inspiration List can launch any of them.
 */

import { useEffect, useRef } from "react";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { emitActivationEvent } from "@/utils/activation-telemetry";

import {
  activationRowStatus,
  useActivationProgress,
} from "./use-activation-progress";

/** No assistant has been baselined yet, which `null` is a real value for. */
const NO_BASELINE = Symbol("no-activation-baseline");

export function useActivationCompletionTelemetry(): void {
  const { data: progress } = useActivationProgress();
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  /** The assistant `reported` was built for. */
  const baselineFor = useRef<string | null | typeof NO_BASELINE>(NO_BASELINE);
  /** Task ids already reported, plus the ones this assistant opened on. */
  const reported = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!progress) {
      return;
    }
    const done = new Set(
      Object.keys(progress.tasks).filter(
        (taskId) => activationRowStatus(progress.tasks[taskId]) === "done",
      ),
    );
    if (baselineFor.current !== activeAssistantId) {
      baselineFor.current = activeAssistantId;
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
  }, [progress, activeAssistantId]);
}
