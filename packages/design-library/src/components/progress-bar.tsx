import { forwardRef } from "react";

import { cn } from "../utils/cn.js";

export interface ProgressBarProps {
  value: number;
  "aria-label"?: string;
  className?: string;
  height?: number;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export const ProgressBar = forwardRef<HTMLDivElement, ProgressBarProps>(
  function ProgressBar(
    { value, "aria-label": ariaLabel, className, height = 6 },
    ref,
  ) {
    const clamped = clamp01(value);
    const percent = clamped * 100;
    const valueNow = Math.round(percent);

    return (
      <div
        ref={ref}
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuenow={valueNow}
        aria-valuemin={0}
        aria-valuemax={100}
        className={cn(
          "rounded-full overflow-hidden bg-[var(--surface-lift)]",
          className,
        )}
        style={{ height }}
      >
        <div
          className="h-full bg-[var(--content-default)] rounded-full"
          style={{
            width: `${percent}%`,
            transition: "width 400ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        />
      </div>
    );
  },
);
