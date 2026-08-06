/**
 * A sidebar section backed by one group: Pinned, or a custom group.
 *
 * Owns its own query. The section asks the server for its own rows rather
 * than receiving a slice of somebody else's list, which is what makes its
 * contents, its unread indicator, and its bulk actions describe the same set
 * of conversations. A pinned conversation shows up here even when it sorts
 * many pages deep in the full list, because this never reads that list.
 *
 * The rows are drained in full rather than paginated: curated membership is a
 * small fraction of a workspace's history, and a section showing only its
 * first page would silently exclude the rest of itself from its own actions.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useGroupConversationListQuery } from "@/hooks/conversation-queries";
import { SidebarSectionCard } from "@/domains/chat/components/sidebar-section-card";
import type { GroupMenuItemsProps } from "@/domains/chat/components/group-actions-menu";

export interface GroupSectionCardProps {
  assistantId: string | null;
  /** `system:pinned`, or a custom group's id. */
  groupId: string;
  /** Collapse key. Defaults to `groupId`, which is already unique. */
  value?: string;
  label: string;
  icon: LucideIcon;
  /** This section's own actions, scoped to the rows it fetched. */
  groupMenu?: GroupMenuItemsProps;
  trailing?: ReactNode;
  collapsedIndicator?: ReactNode;
  /** Grow to fit the rows rather than capping and scrolling within. */
  unbounded?: boolean;
  /**
   * Gate the fetch. Passing `false` keeps the section subscribed to cache
   * updates without issuing a request.
   */
  enabled?: boolean;
}

export function GroupSectionCard({
  assistantId,
  groupId,
  value,
  label,
  icon,
  groupMenu,
  trailing,
  collapsedIndicator,
  unbounded,
  enabled = true,
}: GroupSectionCardProps) {
  const { conversations } = useGroupConversationListQuery(
    assistantId,
    groupId,
    enabled,
  );

  return (
    <SidebarSectionCard
      value={value ?? groupId}
      label={label}
      icon={icon}
      items={conversations}
      groupMenu={groupMenu}
      trailing={trailing}
      collapsedIndicator={collapsedIndicator}
      unbounded={unbounded}
    />
  );
}
