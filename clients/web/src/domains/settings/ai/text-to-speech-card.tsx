/**
 * Settings → AI card wrapping the shared {@link TtsProviderForm} in the
 * settings page's card chrome. The form itself is shared with the live-voice
 * first-run card, which renders it bare inside its own modal.
 */

import { ByoServiceCard } from "@/components/byo-service-card";
import { TtsProviderForm } from "@/components/speech/tts-provider-form";
import { useTranslation } from "@/i18n";

export function TextToSpeechCard() {
  const { t } = useTranslation("settings");

  return (
    <ByoServiceCard
      id="text-to-speech"
      title={t("textToSpeechCard.title")}
      subtitle={t("textToSpeechCard.subtitle")}
    >
      <TtsProviderForm />
    </ByoServiceCard>
  );
}
