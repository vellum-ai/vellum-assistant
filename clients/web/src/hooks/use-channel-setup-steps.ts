import { useCallback, useMemo, useState } from "react";

export interface ChannelSetupSteps<Id extends string> {
  stepId: Id;
  stepIndex: number;
  /** Advance to a named step. Steps move forward only through their own controls. */
  goTo: (id: Id) => void;
  /**
   * Handler for `ChannelSetupWizard`'s stepper. Accepts an index and ignores
   * anything at or ahead of the current step, so the stepper can return to
   * finished work without skipping ahead of it.
   */
  onStepSelect: (index: number) => void;
}

/**
 * Step state for a channel setup wizard.
 *
 * Setup always starts at the first step: every mount is a fresh attempt, and
 * a prop to start elsewhere would exist only for stories, which is a test
 * harness in a component's public API.
 */
export function useChannelSetupSteps<Id extends string>(
  ids: readonly Id[],
): ChannelSetupSteps<Id> {
  const [stepId, setStepId] = useState<Id>(ids[0]);

  const stepIndex = useMemo(() => ids.indexOf(stepId), [ids, stepId]);

  const goTo = useCallback((id: Id) => setStepId(id), []);

  const onStepSelect = useCallback(
    (index: number) => {
      if (index < stepIndex) {
        setStepId(ids[index]);
      }
    },
    [ids, stepIndex],
  );

  return { stepId, stepIndex, goTo, onStepSelect };
}
