import type { MouseEvent } from "react";

import { Typography } from "@vellumai/design-library";

import { getRiskBadgeWeakStyle } from "@/domains/chat/utils/risk";
import { cn } from "@/utils/misc";

export interface RiskBadgeProps {
  level?: string;
  className?: string;
  /** When provided the badge renders as a `<button>` with hover affordance. */
  onClick?: () => void;
}

/**
 * Weak-background / strong-text risk pill matching the macOS `RiskBadgeView`
 * convention (Figma node 5010-103197). Renders `null` when no `level` is
 * supplied so callers can pass optional risk without guarding the call site.
 *
 * When `onClick` is provided the badge renders as a `<button>` and stops
 * propagation so it can be nested inside another interactive element (e.g. a
 * tool-step pill) without triggering the parent's handler.
 */
export function RiskBadge({ level, className, onClick }: RiskBadgeProps) {
  if (!level) {
    return null;
  }

  const { bg, text, label } = getRiskBadgeWeakStyle(level);

  const sharedClasses = cn(
    "inline-flex items-center justify-center rounded-[100px] px-[6px] pt-[2px] pb-[3px]",
    bg,
    className,
  );

  if (onClick) {
    const handleClick = (e: MouseEvent) => {
      e.stopPropagation();
      onClick();
    };
    return (
      <button
        type="button"
        data-testid="risk-badge"
        data-risk-level={level}
        className={cn(sharedClasses, "cursor-pointer hover:opacity-80")}
        onClick={handleClick}
      >
        <Typography variant="label-medium-default" className={text}>
          {label}
        </Typography>
      </button>
    );
  }

  return (
    <span
      data-testid="risk-badge"
      data-risk-level={level}
      className={sharedClasses}
    >
      <Typography variant="label-medium-default" className={text}>
        {label}
      </Typography>
    </span>
  );
}
