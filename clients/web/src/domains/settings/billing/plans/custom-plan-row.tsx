import { SlidersHorizontal } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

const GENERIC_DESCRIPTOR =
  "Select custom CPU power, Ram and Storage. Or just throw in some tokens.";

export interface CustomPlanRowProps {
  className?: string;
  onConfigure: () => void;
  /**
   * Holds Configure disabled while a Pro sub's current tiers are still loading,
   * so the click can't resolve before the parent knows how to route it.
   */
  configureDisabled?: boolean;
  /**
   * Marks this row as the user's current plan — set for a custom Pro sub, whose
   * config isn't represented by any named column card.
   */
  isCurrent?: boolean;
  /**
   * A short recap of the current custom tiers (e.g. "Medium machine · 30 GB ·
   * $50 credits"). Shown as the row descriptor in place of the generic copy so
   * the user sees what their custom plan actually is.
   */
  currentSummary?: string;
}

/**
 * "Custom Plan" prompt below the pricing columns. The parent owns what
 * Configure does (opening the custom plan modal, or routing Pro subscribers
 * to the manage-plan modal).
 */
export function CustomPlanRow({
  className,
  onConfigure,
  configureDisabled,
  isCurrent = false,
  currentSummary,
}: CustomPlanRowProps) {
  return (
    <div className={`flex w-full flex-col items-center gap-8 ${className ?? ""}`}>
      <p className="text-center text-[20px] font-medium text-[var(--content-tertiary)]">
        Need something more tailored to your needs?
      </p>
      <div className="flex w-[840px] max-w-full flex-col items-start gap-4 rounded-2xl bg-[var(--surface-lift)] p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex shrink-0 items-center justify-center rounded-xl bg-[var(--content-disabled)] p-[14px]">
            <SlidersHorizontal
              className="h-6 w-6 text-[var(--aux-white)]"
              aria-hidden
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[16px] font-medium text-[var(--content-emphasised)]">
                Custom Plan
              </span>
              {isCurrent ? (
                <Tag className="bg-[var(--feed-digest-weak)] text-[var(--content-default)]">
                  Your Current Plan
                </Tag>
              ) : null}
            </div>
            <span className="text-[14px] font-medium text-[var(--content-tertiary)]">
              {currentSummary ?? GENERIC_DESCRIPTOR}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-[11px] font-medium text-[var(--content-tertiary)]">
            Billed monthly
          </span>
          <Button
            variant="outlined"
            onClick={onConfigure}
            disabled={configureDisabled}
          >
            Configure
          </Button>
        </div>
      </div>
    </div>
  );
}
