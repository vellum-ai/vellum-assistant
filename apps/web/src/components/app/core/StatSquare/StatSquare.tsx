
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "@vellum/design-library/utils/cn";

/**
 * StatSquare — a tinted square cell for surfacing a single
 * metric (a value + a label) with a leading icon badge.
 *
 * Used in stat rows like Settings → Billing's Credit Balance and Credit
 * Usage panels. Background sits on `--surface-base`, contrasting with the
 * parent `Card`'s `--surface-lift` background, and the leading icon sits in
 * a `--surface-lift` "badge" inside the cell.
 *
 * The `tone` prop colors the value text. `default` uses the standard
 * content color; `negative` uses the `--system-negative-strong` token for
 * negative balances. `muted` softens the value to `--content-tertiary` for
 * stale/incomplete data states.
 */

export type StatSquareTone = "default" | "negative" | "muted";

const VALUE_TONE_CLASSES: Record<StatSquareTone, string> = {
  default: "text-[var(--content-default)]",
  negative: "text-[var(--system-negative-strong)]",
  muted: "text-[var(--content-tertiary)]",
};

export interface StatSquareProps extends HTMLAttributes<HTMLDivElement> {
  /** Icon rendered in the leading badge. */
  icon?: ReactNode;
  /** Primary value displayed at title-small. */
  value: ReactNode;
  /** Secondary label rendered under the value. */
  label: ReactNode;
  /** Color treatment for the value. Defaults to `default`. */
  tone?: StatSquareTone;
}

export const StatSquare = forwardRef<HTMLDivElement, StatSquareProps>(
  function StatSquare(
    { icon, value, label, tone = "default", className, ...rest },
    ref,
  ) {
    return (
      <div
        {...rest}
        ref={ref}
        className={cn(
          "flex flex-1 items-center gap-3 rounded-xl bg-[var(--surface-base)] p-3",
          className,
        )}
      >
        {icon ? (
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-lift)] text-[var(--content-emphasised)]"
          >
            {icon}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-col">
          <span
            className={cn(
              "text-title-small leading-none",
              VALUE_TONE_CLASSES[tone],
            )}
          >
            {value}
          </span>
          <span className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
            {label}
          </span>
        </div>
      </div>
    );
  },
);

StatSquare.displayName = "StatSquare";
