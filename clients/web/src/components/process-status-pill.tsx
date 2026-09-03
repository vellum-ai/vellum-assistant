/**
 * "Working · 6 steps" / "Done · 4 steps": the compact status strip a surface
 * shows for a process it started and is not otherwise rendering.
 *
 * One shell for both states. Only the glyph and the label change, which is the
 * whole cue that a task finished (Figma: New-App `8300:166580` working,
 * `8300:166826` done). The count rides in its own inset chip so a long label
 * cannot push it off the row.
 *
 * Presentational: no store reads, no timers. The caller owns the state and the
 * already-formatted, already-pluralized count string.
 */

import { CircleCheck, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { cn, Typography } from "@vellumai/design-library";

export type ProcessStatusPillState = "working" | "done";

export interface ProcessStatusPillProps {
  state: ProcessStatusPillState;
  /** The state's word, e.g. "Working" or "Done". Already localized. */
  label: string;
  /** Pre-formatted count, e.g. "6 steps". Omitted when there is nothing to count. */
  count?: string;
  /** Overrides the state's default glyph. */
  icon?: ReactNode;
  className?: string;
}

export function ProcessStatusPill({
  state,
  label,
  count,
  icon,
  className,
}: ProcessStatusPillProps): ReactNode {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-[20px] border py-1.5 pl-2 pr-1.5",
        "border-[var(--border-base)] bg-[var(--surface-overlay)]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex shrink-0 items-center justify-center",
          state === "done"
            ? "text-[var(--system-positive-strong)]"
            : "text-[var(--content-secondary)]",
        )}
      >
        {icon ??
          (state === "working" ? (
            // `motion-safe` keeps the spin out of a reduced-motion session;
            // the glyph still reads as the working state without it.
            <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
          ) : (
            <CircleCheck className="h-4 w-4" />
          ))}
      </span>
      <Typography
        as="span"
        variant="body-small-emphasised"
        className="text-[var(--content-emphasised)]"
      >
        {label}
      </Typography>
      {count !== undefined && (
        <Typography
          as="span"
          variant="body-small-default"
          className="shrink-0 rounded-[var(--radius-pill)] bg-[var(--surface-base)] px-1.5 py-1 text-[var(--content-emphasised)]"
        >
          {count}
        </Typography>
      )}
    </span>
  );
}
