import type { ReactNode } from "react";

export function countBadge(n: number): ReactNode {
  return n > 0 ? (
    <span className="text-label-small-default inline-flex items-center justify-center rounded-[4px] bg-[var(--surface-base)] px-[4px] py-[2px] text-[var(--content-tertiary)]">
      {n}
    </span>
  ) : null;
}
