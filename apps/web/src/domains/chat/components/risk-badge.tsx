import { Typography } from "@vellum/design-library";

import { cn } from "@/utils/misc";
import { getRiskBadgeWeakStyle } from "@/domains/chat/utils/risk";

/**
 * Weak-background / strong-text risk pill matching the macOS `RiskBadgeView`
 * convention (Figma node 5010-103197). Renders `null` when no `level` is
 * supplied so callers can pass optional risk without guarding the call site.
 */
export function RiskBadge({ level, className }: { level?: string; className?: string }) {
  if (!level) return null;

  const { bg, text, label } = getRiskBadgeWeakStyle(level);

  return (
    <span
      data-testid="risk-badge"
      data-risk-level={level}
      className={cn(
        "inline-flex items-center justify-center rounded-[100px] px-[6px] pt-[2px] pb-[3px]",
        bg,
        className,
      )}
    >
      <Typography variant="label-medium-default" className={text}>
        {label}
      </Typography>
    </span>
  );
}
