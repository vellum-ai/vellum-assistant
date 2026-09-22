/**
 * The assistant-initiated section with nothing in it yet.
 *
 * It renders at zero on purpose: it is a section the user never files
 * anything into, so without a word here it reads as broken rather than as
 * waiting. The copy's whole job is to say what will eventually arrive and who
 * puts it there.
 *
 * Written in the assistant's own voice, first person, because the section is
 * the assistant's rather than a category of the user's.
 */

import { SidebarSectionEmptyState } from "@/domains/chat/components/sidebar-section-empty-state";
import { useTranslation } from "@/i18n";

export function AssistantSectionEmptyState() {
  const { t } = useTranslation("chat");

  return (
    <SidebarSectionEmptyState
      title={t("assistantSection.emptyTitle")}
      body={t("assistantSection.emptyBody")}
    />
  );
}
