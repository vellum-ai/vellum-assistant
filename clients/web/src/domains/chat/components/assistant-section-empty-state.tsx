/**
 * The assistant-initiated section with nothing in it yet.
 *
 * Every other sidebar section renders only once it has rows, so none of them
 * needs an empty state. This one renders at zero on purpose: it is a section
 * the user never files anything into, so without a word here it reads as
 * broken rather than as waiting. The copy's whole job is to say what will
 * eventually arrive and who puts it there.
 *
 * Written in the assistant's own voice, first person, because the section is
 * the assistant's rather than a category of the user's. Copy alone, no hero
 * glyph: the eyes are the assistant herself (exclusive to the cluster at the
 * top of the rail), the brain belongs to that cluster's menu item, and the
 * section's own Inbox mark already stands in the header a line above -
 * restating it here would just be louder.
 *
 * Deliberately smaller than `EmptyStateScene`: this sits inside a sidebar
 * card a couple of hundred pixels wide, where that component's icon well and
 * recipe grid do not fit.
 */

import { useTranslation } from "@/i18n";
import { Typography } from "@vellumai/design-library";

export function AssistantSectionEmptyState() {
  const { t } = useTranslation("chat");

  return (
    <div className="flex flex-col items-center gap-[var(--app-spacing-sm)] px-[var(--app-spacing-md)] pt-[var(--app-spacing-sm)] pb-[var(--app-spacing-md)] text-center">
      <Typography
        variant="body-small-default"
        className="text-[var(--content-secondary)]"
      >
        {t("assistantSection.emptyTitle")}
      </Typography>
      <Typography
        variant="body-small-lighter"
        className="text-balance text-[var(--content-tertiary)]"
      >
        {t("assistantSection.emptyBody")}
      </Typography>
    </div>
  );
}
