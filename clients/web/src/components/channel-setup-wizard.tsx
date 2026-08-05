import { type ReactNode, useEffect, useRef } from "react";

import { Stepper, type StepperStep } from "@vellumai/design-library";

/** Status of the credential-save mutation a setup wizard drives. */
export type MutationStatus = "idle" | "pending" | "success" | "error";

export interface ChannelSetupWizardProps {
  /** Channel name, used to label the step region for assistive technology. */
  channelLabel: string;
  steps: StepperStep[];
  stepIndex: number;
  onStepSelect: (index: number) => void;
  /** Freeze step navigation, e.g. while a save is in flight. */
  locked?: boolean;
  /** The active step's content. */
  children: ReactNode;
}

/**
 * Chrome shared by the channel setup wizards: the stepper, the sunken panel
 * the active step renders into, and focus handling across step changes.
 *
 * Steps swap the panel's entire contents, which takes the focused control out
 * of the document with it and drops focus to `<body>`. A keyboard user then
 * tabs from the top of the page on every step, and a screen reader is told
 * nothing about the move. On each change after the first, focus moves to the
 * panel, which is labelled with the step it now holds so the move is
 * announced. The first render is skipped: the wizard mounts inside a drawer
 * that the user opened deliberately, and stealing focus into it on arrival
 * would fight whatever they were doing.
 */
export function ChannelSetupWizard({
  channelLabel,
  steps,
  stepIndex,
  onStepSelect,
  locked = false,
  children,
}: ChannelSetupWizardProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Keyed on the step that was last focused rather than on a "first render"
  // flag. A flag flips on StrictMode's second effect pass and then reads as a
  // real step change, so development builds would pull focus in the moment the
  // drawer opened, which is the one case this is meant to avoid. Comparing the
  // index cannot: an effect that reruns without the step moving finds them
  // equal.
  const focusedStepIndex = useRef(stepIndex);

  useEffect(() => {
    if (focusedStepIndex.current === stepIndex) {
      return;
    }
    focusedStepIndex.current = stepIndex;
    panelRef.current?.focus();
  }, [stepIndex]);

  const activeStep = steps[stepIndex];
  const panelLabel = activeStep
    ? `${channelLabel} setup, step ${stepIndex + 1} of ${steps.length}: ${activeStep.label}`
    : `${channelLabel} setup`;

  return (
    <div data-slot="channel-setup-wizard" className="flex flex-col gap-4">
      <Stepper
        steps={steps}
        current={stepIndex}
        onStepSelect={onStepSelect}
        disabled={locked}
      />

      <div
        ref={panelRef}
        data-slot="channel-setup-step-panel"
        // `-1` keeps the panel out of the tab order while letting the step
        // change move focus here; the group label is what gets announced.
        tabIndex={-1}
        role="group"
        aria-label={panelLabel}
        className="rounded-lg bg-[var(--surface-sunken)] p-4 outline-none"
      >
        {children}
      </div>
    </div>
  );
}
