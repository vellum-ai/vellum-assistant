/**
 * Settings → AI card wrapping the shared {@link SttProviderForm} in the
 * settings page's card chrome. The form itself is shared with the live-voice
 * first-run card, which renders it bare inside its own modal.
 */

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ByoServiceCard } from "@/components/byo-service-card";
import { SttProviderForm } from "@/components/speech/stt-provider-form";
import { SttRoleOverrides } from "@/components/speech/stt-role-overrides";
import { useTranslation } from "@/i18n";

export function SpeechToTextCard() {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();

  return (
    <ByoServiceCard
      title={t("speechToTextCard.title")}
      subtitle={t("speechToTextCard.subtitle")}
    >
      <SttProviderForm />
      {/* Only the settings card carries this. The live-voice first-run modal
          renders the form bare to get someone speaking, and a consumer that
          diverges from the global is a thing to review later, not a decision
          to make mid-setup. */}
      <SttRoleOverrides assistantId={assistantId} />
    </ByoServiceCard>
  );
}
