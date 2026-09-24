import type { ReactNode } from "react";

export interface UsageBalancePanelProps {
  /** One or more `UsageBalanceReading` rows. */
  children: ReactNode;
}

/**
 * The current-plan tile's footer, in place of the price row: one bordered
 * block holding every usage reading the tile charts, one row each. The rows
 * share a label column and a percentage column, so their bars start and end
 * on the same lines whatever each title and percentage measure.
 */
export function UsageBalancePanel({ children }: UsageBalancePanelProps) {
  return (
    // One surface step above the tile's base, so the panel reads as its own
    // block. `@container` serves the reading's wide-tile bar margin.
    <div
      className="@container grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 rounded-[10px] border border-[var(--border-base)] bg-[var(--surface-overlay)] px-4 py-3"
      data-testid="plan-usage-panel"
    >
      {children}
    </div>
  );
}
