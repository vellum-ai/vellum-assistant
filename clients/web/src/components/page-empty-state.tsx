import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Full-page empty state shared by the Activity feed and the Schedules page.
 * Mirrors the Library empty state — a rounded-square icon over a title and a
 * one-line description, with optional action buttons beneath. For a compact
 * inline placeholder use `EmptyState` instead.
 */
export function PageEmptyState({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-[400px] flex-col items-center justify-center gap-4 px-4 py-24 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--surface-base)]">
        <Icon size={32} className="text-[var(--content-tertiary)]" />
      </div>
      <h2 className="text-title-medium text-[var(--content-default)]">{title}</h2>
      <p className="max-w-md text-body-medium-lighter text-[var(--content-tertiary)]">
        {description}
      </p>
      {actions ? (
        <div className="flex flex-col items-center gap-3">{actions}</div>
      ) : null}
    </div>
  );
}
