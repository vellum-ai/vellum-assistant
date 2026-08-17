/**
 * Settings → AI card wrapping the shared {@link SttProviderForm} in the
 * settings page's card chrome. The form itself is shared with the live-voice
 * first-run card, which renders it bare inside its own modal.
 */

import { ByoServiceCard } from "@/domains/settings/ai/shared-ui";
import { SttProviderForm } from "@/components/speech/stt-provider-form";
import { useTranslation } from "@/i18n";

export function SpeechToTextCard() {
  const { t } = useTranslation("settings");

  return (
    <ByoServiceCard
      title={t("speechToTextCard.title")}
      subtitle={t("speechToTextCard.subtitle")}
    >
      <SttProviderForm />
    </ByoServiceCard>
  );
}
