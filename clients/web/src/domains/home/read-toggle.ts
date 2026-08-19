import type { LucideIcon } from "lucide-react";

import type { TFunction } from "@/i18n";
import { readStateIcon } from "@/utils/read-state-icon";
import type { FeedItemStatus } from "@vellumai/assistant-api";

/**
 * The read/unread toggle a notification offers, in one definition every
 * surface renders from: the recap row's action list (its inline buttons,
 * swipe, and long-press sheet), the Activity page's detail panel, and the
 * notification bell's detail header.
 */
export interface ReadToggle {
  /** Names the item's current state, per `readStateIcon`. */
  icon: LucideIcon;
  /** Names the command, which is the opposite of the state the glyph shows. */
  label: string;
  /** The status the command writes. */
  nextStatus: FeedItemStatus;
}

export function buildReadToggle(
  isUnread: boolean,
  t: TFunction<"home">,
): ReadToggle {
  return {
    icon: readStateIcon(isUnread),
    label: isUnread ? t("actions.markAsRead") : t("actions.markAsUnread"),
    nextStatus: isUnread ? "seen" : "new",
  };
}
