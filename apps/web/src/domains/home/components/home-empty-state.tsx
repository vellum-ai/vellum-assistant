import type { LucideIcon } from "lucide-react";

/**
 * Shared empty state for the Activity tabs (Schedules / Notifications).
 * Mirrors the Settings archive empty state — a circled icon over a title and
 * a one-line description — but without the surrounding Card, since the tabs
 * already render inside the page's PageShell.
 */
export function HomeEmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-base)]">
        <Icon className="h-6 w-6 text-[var(--content-disabled)] dark:text-[var(--content-default)]" />
      </div>
      <h2 className="mt-4 text-title-small text-[var(--content-default)]">
        {title}
      </h2>
      <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
        {description}
      </p>
    </div>
  );
}
