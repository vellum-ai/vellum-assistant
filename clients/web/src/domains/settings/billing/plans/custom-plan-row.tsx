import { SlidersHorizontal } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";

export interface CustomPlanRowProps {
  className?: string;
}

/**
 * "Custom Plan" prompt below the pricing columns. The Configure button is a
 * deliberate no-op — the self-serve customization flow isn't built yet.
 */
export function CustomPlanRow({ className }: CustomPlanRowProps) {
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
            <span className="text-[16px] font-medium text-[var(--content-emphasised)]">
              Custom Plan
            </span>
            <span className="text-[14px] font-medium text-[var(--content-tertiary)]">
              Select custom CPU power, Ram and Storage. Or just throw in some
              tokens.
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-[11px] font-medium text-[var(--content-tertiary)]">
            Billed monthly
          </span>
          <Button
            variant="outlined"
            onClick={() => {
              // Custom plan configuration flow isn't built yet.
            }}
          >
            Configure
          </Button>
        </div>
      </div>
    </div>
  );
}
