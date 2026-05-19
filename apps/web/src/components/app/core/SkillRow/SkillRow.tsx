
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "@vellum/design-library/utils/cn";

/**
 * SkillRow — a tinted content row for surfacing a labeled item with a
 * leading icon, stacked title + subtitle, and a trailing action slot.
 *
 * Used as a card body element when a `Card` needs to present "one thing
 * with one button next to it" (e.g. Settings → Billing's plan, payment
 * method, and referral rows). The row sits on `--surface-base`, contrasting
 * with the parent `Card`'s `--surface-lift` background.
 */

// `title` shadows HTMLDivElement's tooltip-string `title` attribute; omit
// the base attribute so our ReactNode redefinition doesn't widen the type.
export interface SkillRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /**
   * Leading icon — typically a small lucide icon. Rendered inside a fixed
   * 24px square, vertically centered.
   */
  icon?: ReactNode;
  /** Primary label. Renders at body-medium-default. */
  title: ReactNode;
  /** Optional secondary text under the title. Renders at body-small-default. */
  subtitle?: ReactNode;
  /**
   * Right-aligned action slot — typically one or more `Button`s. Wrapped
   * in a flex container so multiple actions stack horizontally with a
   * 4px gap.
   */
  action?: ReactNode;
}

export const SkillRow = forwardRef<HTMLDivElement, SkillRowProps>(
  function SkillRow({ icon, title, subtitle, action, className, ...rest }, ref) {
    return (
      <div
        {...rest}
        ref={ref}
        className={cn(
          // Stack content + action on small viewports so the trailing
          // button doesn't squeeze the title into a cramped multi-line
          // wrap. Switch to a single-row layout at `sm` (640px+).
          "flex flex-col gap-4 rounded-lg bg-[var(--surface-base)] px-2 py-1.5",
          "sm:flex-row sm:items-center sm:justify-between sm:gap-3",
          className,
        )}
      >
        {/* `items-start` keeps the icon next to the title row when the
            subtitle wraps to multiple lines on mobile — without this, the
            icon vertically centers between title and subtitle and visually
            drifts down the column. */}
        <div className="flex min-w-0 items-start gap-1.5">
          {icon ? (
            <span
              aria-hidden
              className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--content-emphasised)]"
            >
              {icon}
            </span>
          ) : null}
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-body-medium-default text-[var(--content-default)]">
              {title}
            </span>
            {subtitle ? (
              <span className="text-body-small-default text-[var(--content-tertiary)]">
                {subtitle}
              </span>
            ) : null}
          </div>
        </div>
        {action ? (
          <div className="flex shrink-0 items-center gap-1">{action}</div>
        ) : null}
      </div>
    );
  },
);

SkillRow.displayName = "SkillRow";
