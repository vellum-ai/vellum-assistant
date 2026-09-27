import { MailOpen } from "lucide-react";

import { useTranslation } from "@/i18n";

/**
 * The reading pane with nothing open: the same shape as a folder's empty
 * state (a glyph on a disc, a title, a line under it), so the two cards read
 * as one surface. The line under the title is where a first-time reader
 * learns the list's checkboxes exist, since those only show on hover.
 */
export function ReadingPaneEmptyState() {
  const { t } = useTranslation("assistant-inbox");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-[var(--surface-active)]">
        <MailOpen
          className="size-6 text-[var(--content-tertiary)]"
          aria-hidden="true"
        />
      </span>
      <p className="text-body-medium-default text-[var(--content-default)]">
        {t("assistantInboxPage.selectPromptTitle")}
      </p>
      <p className="max-w-xs text-body-small-lighter text-[var(--content-tertiary)]">
        {t("assistantInboxPage.selectPromptBody")}
      </p>
    </div>
  );
}
