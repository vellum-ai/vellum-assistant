/**
 * "View all chats" on a sidebar section header, under `sidebar-done`.
 *
 * A section shows a window onto its chats, and a chat marked done leaves that
 * window without leaving the assistant. This is where it went: the All chats
 * page, opened on the section's own filter.
 *
 * It stands beside the section's "…" in the header's trailing cell and wears
 * that control's exact box ({@link SECTION_HEADER_CONTROL_CLASSES}), so the
 * two read as one pair. Like the "…", the shared reveal rules paint it only
 * while the header is hovered or focused: nothing new is visible at rest.
 * Its name is in a tooltip, as the New Chat button's is.
 */

import { List } from "lucide-react";
import { Link } from "react-router";

import { SECTION_HEADER_CONTROL_CLASSES } from "@/components/section-actions-button";
import { useTranslation } from "@/i18n";
import { Tooltip } from "@vellumai/design-library";

export function SectionViewAllLink({ to }: { to: string }) {
  const { t } = useTranslation("chat");
  const label = t("sidebarSectionViewAll.label");

  return (
    <Tooltip content={label} side="top">
      <Link
        to={to}
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        className={SECTION_HEADER_CONTROL_CLASSES}
      >
        <List
          size={14}
          aria-hidden
          className="max-md:h-[21px] max-md:w-[21px]"
        />
      </Link>
    </Tooltip>
  );
}
