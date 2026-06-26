import { type ComponentProps } from "react";

import { cn } from "../utils/cn";

export interface StepperStep {
  id: string;
  label: string;
  /** Mark the step as not navigable (e.g. a future step in a gated wizard). */
  disabled?: boolean;
}

export type StepperProps = ComponentProps<"nav"> & {
  steps: StepperStep[];
  /** Index of the active step. */
  current: number;
  /**
   * Called with the step index when a navigable step (not active, not
   * disabled) is selected. Omit to render the steps as non-interactive.
   */
  onStepSelect?: (index: number) => void;
};

/**
 * Labeled step navigation for a sequential, gated flow such as a multi-page
 * form wizard. The active step is marked with `aria-current="step"`, navigable
 * steps are buttons that call `onStepSelect`, and disabled steps are inert.
 * This is the step pattern — distinct from `Tabs`, which models parallel,
 * independently selectable panels.
 */
export function Stepper({
  steps,
  current,
  onStepSelect,
  className,
  ...rest
}: StepperProps) {
  return (
    <nav
      data-slot="stepper"
      className={cn(
        "flex items-center gap-4 overflow-x-auto border-b border-[var(--border-base)]",
        className,
      )}
      {...rest}
    >
      {steps.map((step, index) => {
        const isActive = index === current;
        const navigable = !isActive && !step.disabled && !!onStepSelect;
        return (
          <button
            key={step.id}
            type="button"
            data-slot="stepper-step"
            disabled={!navigable}
            aria-current={isActive ? "step" : undefined}
            onClick={navigable ? () => onStepSelect?.(index) : undefined}
            className={cn(
              "-mb-px inline-flex items-center whitespace-nowrap border-b-2 border-transparent pb-2 text-body-medium-default outline-none transition-colors",
              "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
              isActive &&
                "border-[var(--primary-base)] text-[var(--content-strong)]",
              navigable &&
                "cursor-pointer text-[var(--content-default)] hover:text-[var(--content-strong)]",
              !isActive &&
                !navigable &&
                "cursor-default text-[var(--content-disabled)]",
            )}
          >
            {step.label}
          </button>
        );
      })}
    </nav>
  );
}
