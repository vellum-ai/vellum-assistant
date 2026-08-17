/**
 * Shown in place of the section tree when the sidebar's conversation list
 * failed before it ever loaded.
 *
 * An empty section is dropped from the sidebar, and every section falls back
 * to rows derived from this same list, so a failed first load renders as a
 * sidebar with nothing in it at all. That is indistinguishable from an
 * assistant whose conversations have been deleted, which is how users read it.
 * This says the list did not load and offers the retry, so the failure stays a
 * failure.
 *
 * Only for the never-loaded case. React Query keeps the last successful data
 * when a later refetch fails, and those rows are still the real list, so a
 * failed refetch over a populated sidebar must keep drawing them.
 */

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

export function SidebarConversationError({
  onRetry,
}: {
  onRetry?: () => void;
}) {
  const { t } = useTranslation("chat");

  return (
    <div
      className="flex flex-col items-start gap-2 px-1.5 py-2"
      data-slot="sidebar-conversation-error"
      role="status"
    >
      <p className="text-muted-foreground text-xs">
        {t("sidebarConversationError.message")}
      </p>
      {onRetry ? (
        <Button variant="ghost" size="compact" onClick={onRetry}>
          {t("sidebarConversationError.retry")}
        </Button>
      ) : null}
    </div>
  );
}
