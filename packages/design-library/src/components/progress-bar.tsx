import { type Ref } from "react";

import { cn } from "../utils/cn";

export interface ProgressBarProps {
  /**
   * Completion fraction in `[0, 1]`. `null` renders the bar indeterminate: a
   * band sweeps the track and no `aria-valuenow` is exposed, which is how
   * assistive tech reads "busy, extent unknown".
   */
  value: number | null;
  "aria-label"?: string;
  className?: string;
  /**
   * Fill colour, for bars whose meaning is carried by colour rather than
   * length alone (a threshold gauge that shifts neutral to amber to red).
   * Any CSS colour; prefer a token. Defaults to `--content-default`.
   * Style the track with `className`.
   */
  fillColor?: string;
  height?: number;
  ref?: Ref<HTMLDivElement>;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function ProgressBar({
  value,
  "aria-label": ariaLabel,
  className,
  fillColor,
  height = 6,
  ref,
}: ProgressBarProps) {
  const percent = value == null ? null : clamp01(value) * 100;

  return (
    <div
      ref={ref}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={percent == null ? undefined : Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      data-slot="progress-bar"
      className={cn(
        "rounded-full overflow-hidden bg-[var(--surface-lift)]",
        className,
      )}
      style={{ height }}
    >
      {percent == null ? (
        <div
          data-slot="progress-bar-fill"
          className="h-full w-2/5 bg-[var(--content-default)] rounded-full motion-safe:animate-progress-indeterminate motion-reduce:w-full motion-reduce:opacity-40"
          style={{ backgroundColor: fillColor }}
        />
      ) : (
        <div
          data-slot="progress-bar-fill"
          className="h-full bg-[var(--content-default)] rounded-full"
          style={{
            width: `${percent}%`,
            backgroundColor: fillColor,
            transition: "width 400ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        />
      )}
    </div>
  );
}
