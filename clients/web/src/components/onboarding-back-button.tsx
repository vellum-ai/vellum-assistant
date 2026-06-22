/**
 * Shared "go back" affordance for the research-onboarding steps.
 *
 * SPIKE — research-onboarding flow.
 *
 * A `fixed` "‹ Back" control pinned to the top-left of the viewport so it sits
 * in the same spot on every step that has a previous step (the check-in overlay
 * and the results overlay — the form is the entry point, so it has none).
 * z-index sits above the focused overlays (results z-50, check-in z-60) so it
 * stays clickable on each.
 */

import { ChevronLeft } from "lucide-react";

import { cn } from "@vellumai/design-library/utils/cn";

export function OnboardingBackButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "fixed left-4 top-4 z-[70] flex h-9 items-center gap-0.5 rounded-md pl-1.5 pr-3",
        "text-body-medium-default text-[var(--content-secondary)] transition-colors duration-150",
        "hover:bg-[var(--surface-lift)] hover:text-[var(--content-default)]",
        "animate-[fadeInUp_0.4s_ease-out_both]",
        className,
      )}
    >
      <ChevronLeft className="h-5 w-5" />
      Back
    </button>
  );
}
