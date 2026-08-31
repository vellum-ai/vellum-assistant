import type { ReactNode } from "react";

export interface PlanTileRowProps {
  children: ReactNode;
}

/**
 * The plan card's tile row, shared by the resolved card and its skeleton: the
 * tiles sit side by side from `lg` and stack below it.
 */
export function PlanTileRow({ children }: PlanTileRowProps) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
      {children}
    </div>
  );
}
