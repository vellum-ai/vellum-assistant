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
 * the assistant's rather than a category of the user's. That is also why the
 * hero is the assistant's own eyes instead of the section header's glyph:
 * `AssistantEyesMark` renders `null` for a custom-image or still-loading
 * avatar, so the scene degrades to copy alone without a guard here.
 *
 * Deliberately smaller than `EmptyStateScene`: this sits inside a sidebar
 * card a couple of hundred pixels wide, where that component's icon well and
 * recipe grid do not fit.
 */

import { AssistantEyesMark } from "@/domains/chat/components/assistant-eyes-mark";
import { useTranslation } from "@/i18n";
import { Typography } from "@vellumai/design-library";

export interface AssistantSectionEmptyStateProps {
  assistantId: string | null;
}

export function AssistantSectionEmptyState({
  assistantId,
}: AssistantSectionEmptyStateProps) {
  const { t } = useTranslation("chat");

  return (
    <div className="flex flex-col items-center gap-[var(--app-spacing-sm)] px-[var(--app-spacing-md)] pt-[var(--app-spacing-sm)] pb-[var(--app-spacing-md)] text-center">
      <AssistantEyesMark
        assistantId={assistantId}
        width={28}
        className="opacity-80"
      />
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
