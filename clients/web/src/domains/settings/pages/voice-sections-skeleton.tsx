import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { VoiceSection } from "@/domains/settings/pages/voice-section";
import { useTranslation } from "@/i18n";

/**
 * Stand-in while the daemon answers which speech capabilities this assistant
 * has. Built from the same {@link VoiceSection} scaffolding as the real page,
 * so the same three headings are present and in the same order on both sides
 * of the swap and the page never reflows section by section.
 *
 * It does not hold the settled page's exact height. A row here is a fixed
 * size and a card sizes to its content, and two of the settled elements (the
 * services banner, the listening-language card) exist only for some answers.
 * Reserving room for those is what makes a placeholder assert a capability
 * the user may not have, which is the failure this gate exists to remove.
 */
export function VoiceSectionsSkeleton() {
  const { t } = useTranslation("settings");

  return (
    <div
      className="flex flex-col gap-8"
      role="status"
      aria-label={t("voicePage.loadingAria")}
    >
      <VoiceSection
        heading={t("voicePage.sectionOutputHeading")}
        description={t("voicePage.sectionOutputDescription")}
      >
        <CardSkeleton />
      </VoiceSection>

      <VoiceSection
        heading={t("voicePage.sectionInputHeading")}
        description={t("voicePage.sectionInputDescription")}
      >
        {/* One per card the section always has. The listening-language card is
            left out because it renders only for a provider that accepts one. */}
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </VoiceSection>

      <VoiceSection heading={t("voicePage.sectionCaptionsHeading")}>
        <CardSkeleton />
      </VoiceSection>
    </div>
  );
}

function CardSkeleton() {
  return <Skeleton className="h-20 w-full rounded-xl" />;
}
