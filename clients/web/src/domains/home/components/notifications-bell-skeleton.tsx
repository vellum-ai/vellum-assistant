import { useTranslation } from "@/i18n";
import { Skeleton } from "@vellumai/design-library";

/**
 * The bell's first-load state.
 *
 * Shaped like the list it is standing in for: a section header over two rows,
 * twice, with the same gutter, card height, and spacing the real rows use. A
 * generic spinner would tell the reader the panel is busy; this tells them
 * what is coming, and the panel does not resize when it arrives.
 *
 * Only drawn when there is nothing cached to show. A refetch over an existing
 * list leaves the list up, because replacing rows the user is reading with
 * placeholders is a worse answer than briefly stale rows.
 */
export function NotificationsBellSkeleton() {
  const { t } = useTranslation("home");

  return (
    <div
      role="status"
      aria-label={t("notificationsBell.loading")}
      className="flex flex-col gap-[var(--app-spacing-md)]"
    >
      {[0, 1].map((section) => (
        <div
          key={section}
          className="flex flex-col gap-[var(--app-spacing-sm)]"
        >
          <Skeleton className="mx-[var(--app-spacing-sm)] h-3 w-24" />
          {[0, 1].map((row) => (
            <div
              key={row}
              className="flex items-start gap-[var(--app-spacing-sm)] rounded-[var(--radius-lg)] border border-[var(--border-base)] bg-[var(--surface-overlay)] p-[var(--app-spacing-sm)]"
            >
              <Skeleton className="mt-2 size-4 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-[var(--app-spacing-xxs)]">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3.5 w-4/5" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
