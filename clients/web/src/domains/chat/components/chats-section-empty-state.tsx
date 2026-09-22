/**
 * The Chats section with no rows.
 *
 * Chats always renders, because it is where a new conversation lands, so an
 * empty one needs a word rather than a blank card. What it says depends on
 * how it got empty. Under `sidebar-done` the usual way is that every chat in
 * it was marked done, so it says the list is clear and points at the Old
 * chats page, where those chats went. Without the flag an empty Chats means
 * there are no chats yet.
 */

import { Link } from "react-router";

import { SidebarSectionEmptyState } from "@/domains/chat/components/sidebar-section-empty-state";
import { useTranslation } from "@/i18n";
import { useSidebarDoneEnabled } from "@/utils/done-labels";
import { Button } from "@vellumai/design-library";

export function ChatsSectionEmptyState({
  viewAllHref,
}: {
  /** The All chats page for this section; `null` offers no link. */
  viewAllHref: string | null;
}) {
  const { t } = useTranslation("chat");
  const sidebarDone = useSidebarDoneEnabled();

  if (!sidebarDone) {
    return (
      <SidebarSectionEmptyState
        title={t("chatsSection.emptyTitle")}
        body={t("chatsSection.emptyBody")}
      />
    );
  }

  return (
    <SidebarSectionEmptyState
      title={t("chatsSection.doneEmptyTitle")}
      body={t("chatsSection.doneEmptyBody")}
      action={
        viewAllHref !== null ? (
          <Button variant="outlined" size="compact" asChild>
            <Link to={viewAllHref}>{t("sidebarSectionViewAll.label")}</Link>
          </Button>
        ) : undefined
      }
    />
  );
}
