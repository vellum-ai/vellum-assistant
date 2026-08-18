import { RotateCcw, Trash2 } from "lucide-react";

import { useTranslation } from "@/i18n";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";
import { Button } from "@vellumai/design-library";

import { buildReadToggle } from "./read-toggle";

export interface FeedItemStatusActionsProps {
  item: FeedItem;
  onUpdateStatus: (itemId: string, status: FeedItemStatus) => void;
  onDismiss: (itemId: string) => void;
}

/**
 * The status controls a notification's detail header carries: the read/unread
 * toggle, then dismiss (or restore, for an item already dismissed). Rendered
 * by the Activity page's detail panel and by the notification bell's detail.
 *
 * A fragment rather than a row: the two headers seat the pair differently
 * (the bell holds its width opposite a back control, the panel pushes it to
 * the trailing edge of a nav bar), so the container stays with each of them
 * and only the controls are shared.
 */
export function FeedItemStatusActions({
  item,
  onUpdateStatus,
  onDismiss,
}: FeedItemStatusActionsProps) {
  const { t } = useTranslation("home");
  const readToggle = buildReadToggle(item.status === "new", t);
  const ReadToggleIcon = readToggle.icon;

  return (
    <>
      <Button
        variant="ghost"
        iconOnly={<ReadToggleIcon />}
        onClick={() => onUpdateStatus(item.id, readToggle.nextStatus)}
        aria-label={readToggle.label}
        tooltip={readToggle.label}
      />
      {item.status === "dismissed" ? (
        <Button
          variant="ghost"
          iconOnly={<RotateCcw />}
          onClick={() => onUpdateStatus(item.id, "seen")}
          aria-label={t("actions.restore")}
          tooltip={t("actions.restore")}
        />
      ) : (
        <Button
          variant="ghost"
          iconOnly={<Trash2 />}
          onClick={() => onDismiss(item.id)}
          aria-label={t("actions.dismiss")}
          tooltip={t("actions.dismiss")}
        />
      )}
    </>
  );
}
