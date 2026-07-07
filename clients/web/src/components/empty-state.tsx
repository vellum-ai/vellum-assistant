import type { ReactNode } from "react";

import { cn } from "@vellumai/design-library";

export interface EmptyStateProps {
  /** Glyph or brand mark rendered inside the icon well. */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Call-to-action slot, typically a design-library `Button`. */
  action?: ReactNode;
  className?: string;
}

/**
 * Centered placeholder for a surface with nothing to show yet: an optional
 * icon well, a short title, a one-line description, and an action slot.
 * Domain-agnostic — callers supply all content via props.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-4 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--surface-sunken)] text-[var(--content-tertiary)]">
          {icon}
        </div>
      ) : null}
      <h3 className="text-title-small text-[var(--content-default)]">{title}</h3>
      {description ? (
        <p className="max-w-md text-body-medium-lighter text-[color:var(--content-tertiary)]">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
