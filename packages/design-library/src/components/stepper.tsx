import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentProps } from "react";

import { cn } from "../utils/cn";

export interface StepperStep {
  id: string;
  label: string;
}

export type StepperProps = ComponentProps<"nav"> & {
  steps: StepperStep[];
  /** Index of the active step; earlier steps are completed, later are upcoming. */
  current: number;
  /**
   * Called with the step index when a completed step is selected. Omit to
   * render a non-interactive display stepper.
   */
  onStepSelect?: (index: number) => void;
  /**
   * Disable all step navigation (e.g. while a form is submitting) without
   * changing the completed / active / upcoming styling.
   */
  disabled?: boolean;
};

// Color is keyed on the step's position (`status`); interactivity is keyed on
// the native `:enabled` / `:disabled` state, so a completed step keeps its
// visited color even when navigation is locked (e.g. while submitting).
export const stepVariants = cva(
  [
    "-mb-px inline-flex items-center whitespace-nowrap border-b-2 border-transparent pb-2",
    "text-body-medium-default outline-none transition-colors",
    "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
    "enabled:cursor-pointer enabled:hover:text-[var(--content-strong)]",
    "disabled:cursor-default",
  ].join(" "),
  {
    variants: {
      status: {
        active: "border-[var(--primary-base)] text-[var(--content-strong)]",
        completed: "text-[var(--content-default)]",
        upcoming: "text-[var(--content-disabled)]",
      },
    },
    defaultVariants: { status: "upcoming" },
  },
);

export type StepStatus = NonNullable<VariantProps<typeof stepVariants>["status"]>;

/**
 * Labeled step navigation for a sequential, gated flow such as a multi-page
 * form wizard. Steps are styled by position relative to `current`: completed
 * steps (before it) read as visited and can navigate back, the active step is
 * marked with `aria-current="step"`, and upcoming steps (after it) are muted
 * and locked. A completed step keeps its visited styling even when navigation
 * is disabled, so it never looks like an upcoming step. This is the step
 * pattern — distinct from `Tabs`, which models parallel, independently
 * selectable panels.
 */
export function Stepper({
  steps,
  current,
  onStepSelect,
  disabled = false,
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
        const status: StepStatus =
          index === current
            ? "active"
            : index < current
              ? "completed"
              : "upcoming";
        const navigable =
          status === "completed" && !disabled && !!onStepSelect;
        return (
          <button
            key={step.id}
            type="button"
            data-slot="stepper-step"
            disabled={!navigable}
            aria-current={status === "active" ? "step" : undefined}
            onClick={navigable ? () => onStepSelect?.(index) : undefined}
            className={stepVariants({ status })}
          >
            {step.label}
          </button>
        );
      })}
    </nav>
  );
}
