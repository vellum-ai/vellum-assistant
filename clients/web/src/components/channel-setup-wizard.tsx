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
 * A step swaps the panel's entire contents, taking the focused control out of
 * the document with it and dropping focus to `<body>`, which leaves a keyboard
 * user tabbing from the top of the page and tells a screen reader nothing. So
 * a step change moves focus to the panel, labelled with the step it holds, so
 * the move announces something. Mounting does not: the wizard appears in a
 * drawer the user opened deliberately, and taking focus on arrival fights
 * whatever they were doing.
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
  // Holds the step this last focused, so a rerun that did not move the step is
  // a no-op. StrictMode runs effects twice on mount, and any guard that only
  // asks "have I run before" answers yes on the second pass and pulls focus
  // into a drawer the user just opened.
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
        // change move focus here; the group label is what gets announced. No
        // focus ring: this is only ever focused programmatically, and the
        // panel's entire contents changing in the same frame is the visible
        // signal a ring would otherwise duplicate around the whole box.
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
