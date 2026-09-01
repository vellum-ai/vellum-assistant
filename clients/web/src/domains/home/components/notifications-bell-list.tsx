import { useTranslation } from "@/i18n";
import {
  isPendingGuardianFeedItem,
  type FeedItem,
  type FeedItemStatus,
} from "@vellumai/assistant-api";
import { Tag, Typography } from "@vellumai/design-library";

import { HomeRecapRow } from "../home-recap-row";

export interface NotificationsBellListProps {
  /** Visible feed items, already sorted (pending guardian items first). */
  items: FeedItem[];
  onSelect: (item: FeedItem) => void;
  onDismiss: (itemId: string) => void;
  onToggleRead: (itemId: string, newStatus: FeedItemStatus) => void;
}

/**
 * The bell's notification list. While a guardian request is waiting on the
 * user, the list splits into labelled sections: "Needs attention" pins the
 * pending requests at the top under a pulsing marker, and everything else
 * files under "Updates". With nothing waiting, the labels carry no
 * information and the list renders unsectioned, as a plain stack of rows.
 */
export function NotificationsBellList({
  items,
  onSelect,
  onDismiss,
  onToggleRead,
}: NotificationsBellListProps) {
  const { t } = useTranslation("home");

  const row = (item: FeedItem) => (
    <HomeRecapRow
      key={item.id}
      item={item}
      density="compact"
      onSelect={onSelect}
      onDismiss={onDismiss}
      onToggleRead={onToggleRead}
    />
  );

  const attentionItems = items.filter(isPendingGuardianFeedItem);
  if (attentionItems.length === 0) {
    return <>{items.map(row)}</>;
  }
  const updateItems = items.filter((item) => !isPendingGuardianFeedItem(item));

  return (
    <>
      <SectionLabel attention>
        {t("notificationsBell.needsAttention")}
      </SectionLabel>
      {attentionItems.map(row)}
      {updateItems.length > 0 ? (
        <>
          <SectionLabel>{t("notificationsBell.updates")}</SectionLabel>
          {updateItems.map(row)}
        </>
      ) : null}
    </>
  );
}

interface SectionLabelProps {
  /**
   * Marks the section that is waiting on the user. That section takes the
   * same pill the request's own detail leads with, so the callout looks
   * the same wherever a person meets it; the section of things that only
   * report is a plain text divider.
   */
  attention?: boolean;
  children: string;
}

function SectionLabel({ attention = false, children }: SectionLabelProps) {
  return (
    <h3
      data-testid={
        attention
          ? "notifications-bell-section-attention"
          : "notifications-bell-section-updates"
      }
      className="flex items-center px-[var(--app-spacing-xs)] pt-[var(--app-spacing-xxs)]"
    >
      {attention ? (
        <Tag
          tone="warning"
          leftIcon={
            <span className="block h-1.5 w-1.5 rounded-full bg-[var(--system-mid-strong)] motion-safe:animate-pulse" />
          }
        >
          {children}
        </Tag>
      ) : (
        <Typography
          variant="body-small-emphasised"
          className="text-[var(--content-tertiary)]"
        >
          {children}
        </Typography>
      )}
    </h3>
  );
}
