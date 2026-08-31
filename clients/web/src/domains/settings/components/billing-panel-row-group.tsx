import type { ReactNode } from "react";

import { cn } from "@vellumai/design-library";

export interface BillingPanelRowGroupProps {
  children: ReactNode;
  /** Deep-link target; only the daily-limit group is anchored. */
  id?: string;
  className?: string;
}

/**
 * One of the divided row groups below the Credits balance, shared by
 * `BillingPanel` and its skeleton: the rule above the group plus the spacing
 * on either side of it.
 */
export function BillingPanelRowGroup({
  children,
  id,
  className,
}: BillingPanelRowGroupProps) {
  return (
    <div
      id={id}
      className={cn(
        "mt-6 border-t border-[var(--border-subtle)] pt-6",
        className,
      )}
    >
      {children}
    </div>
  );
}
