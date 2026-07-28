import type { CSSProperties, ReactNode } from "react";

import { cn } from "@vellumai/design-library";

/**
 * Shared rounded-overlay container for the assistant's main content pages
 * (Intelligence "About Assistant" tabs, Library). Keeps the surface,
 * border, padding, and min-h-0 flex behavior consistent across pages so
 * children only own their per-page header/body layout.
 */
export function PageShell({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] px-6 py-5",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}
