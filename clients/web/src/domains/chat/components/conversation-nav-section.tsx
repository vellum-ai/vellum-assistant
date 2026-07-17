/**
 * The two list-shaped pieces of the sidebar conversation list:
 *
 * - {@link ConversationRowList} — a `SideMenu.SubList` of
 *   {@link ConversationRow}s with optional "Show more / Show less"
 *   pagination. Used directly by Pinned and Recents, and inside every
 *   collapsible section.
 * - {@link ConversationNavSection} — a `CollapsibleNavSection.Section`
 *   shell (icon + label + trailing + context menu) wrapping a
 *   `ConversationRowList`. Used by channel sections and custom groups.
 *
 * Row callbacks and state come from {@link useConversationListContext}
 * (via `ConversationRow`), so neither takes them as props.
 */

import { type ReactNode } from "react";

import { type LucideIcon } from "lucide-react";

import { SideMenu } from "@vellumai/design-library";

import { CollapsibleNavSection } from "@/components/collapsible-nav-section";
import { ConversationRow } from "@/domains/chat/components/conversation-row";
import type { PaginatedSection } from "@/domains/chat/use-sidebar-state";
import type { Conversation } from "@/types/conversation-types";

type PaginationControls = Pick<
  PaginatedSection,
  "showMore" | "onShowMore" | "showLess" | "onShowLess"
>;

export interface ConversationRowListProps {
  items: Conversation[];
  /** Drag-reorder section key; omit for non-reorderable lists. */
  dragSection?: string;
  /**
   * Full ordered list for drag math. Defaults to `items` — pass explicitly
   * only when the visible `items` are a paginated subset (drag operates on
   * the whole section).
   */
  dragSiblings?: Conversation[];
  /** Show-more/less controls; omit for non-paginated lists (Pinned, groups). */
  pagination?: PaginationControls;
}

export function ConversationRowList({
  items,
  dragSection,
  dragSiblings,
  pagination,
}: ConversationRowListProps) {
  return (
    <SideMenu.SubList>
      {items.map((conversation) => (
        <ConversationRow
          key={conversation.conversationId}
          conversation={conversation}
          dragSection={dragSection}
          dragSiblings={dragSiblings ?? items}
        />
      ))}
      {pagination?.showMore ? (
        <SideMenu.Item
          label="Show more"
          emphasized
          onSelect={pagination.onShowMore}
        />
      ) : null}
      {pagination?.showLess ? (
        <SideMenu.Item
          label="Show less"
          emphasized
          onSelect={pagination.onShowLess}
        />
      ) : null}
    </SideMenu.SubList>
  );
}

export interface ConversationNavSectionProps extends ConversationRowListProps {
  /** Collapse/expand key (matches the controlling `CollapsibleNavSection.Root`). */
  value: string;
  label: string;
  icon?: LucideIcon;
  trailing?: ReactNode;
  contextMenuContent?: ReactNode;
}

export function ConversationNavSection({
  value,
  label,
  icon,
  trailing,
  contextMenuContent,
  ...listProps
}: ConversationNavSectionProps) {
  return (
    <CollapsibleNavSection.Section
      value={value}
      icon={icon}
      label={label}
      trailing={trailing}
      contextMenuContent={contextMenuContent}
    >
      <ConversationRowList {...listProps} />
    </CollapsibleNavSection.Section>
  );
}
