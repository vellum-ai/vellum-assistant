import { Typography } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

/**
 * Tombstone for a message deleted on its channel after the daemon stored it
 * (flagged `deletedAt`). Renders fixed copy in place of the row's content,
 * mirroring what the channel now shows; the stored content stays reachable
 * through Inspect. Same quiet register as the deliberate-silence marker.
 */
export function DeletedMessageRow() {
  const { t } = useTranslation("chat");
  return (
    <div data-testid="deleted-message-row" className="flex justify-center">
      <Typography
        variant="body-small-default"
        className="text-[var(--content-tertiary)] italic"
      >
        {t("deletedMessageRow.label")}
      </Typography>
    </div>
  );
}
