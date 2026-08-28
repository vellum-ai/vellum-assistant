/**
 * Settings → Voice, input section: which spoken language the assistant
 * listens for.
 *
 * Sits with Microphone and Push to Talk because it belongs to the same half
 * of the conversation: those cards say which device carries your voice and
 * how you open the mic; this one says what the far end expects to hear. It is
 * the durable home for a selection that is otherwise only offered before a
 * first session (the voice first-run card, on locale evidence) or beside the
 * API keys on Models & Services, neither of which a user returns to when the
 * transcript starts coming back wrong.
 *
 * Matches {@link VoicePickerCard}'s shape deliberately: current value on its
 * own row, Change beside it, the full catalog in the shared search-first
 * {@link SttLanguagePickerModal}. Same gesture as choosing a voice, since
 * these are the same kind of choice pointed in opposite directions.
 *
 * Renders nothing when the daemon reports the configured provider as not
 * manually language-selectable (Gemini and Whisper detect natively; old
 * daemons omit the capability). That is the rule every language surface
 * follows: show no control rather than one whose value the daemon ignores.
 *
 * A pick hot-applies from the user's next spoken turn, so there is no Save.
 */

import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";

import { DetailCard } from "@/components/detail-card";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { SttLanguagePickerModal } from "@/components/speech/stt-language-picker-modal";
import { useSttLanguageSelection } from "@/components/speech/use-stt-language-selection";
import { sttLanguageLabelForCode } from "@/lib/stt/language-catalog";
import { useTranslation } from "@/i18n";

export function ListeningLanguageCard() {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();
  const {
    available,
    currentCode,
    configuredProviderId,
    selectLanguage,
    selecting,
  } = useSttLanguageSelection(assistantId);
  const [pickerOpen, setPickerOpen] = useState(false);

  if (!available) {
    return null;
  }

  return (
    <DetailCard
      title={t("listeningLanguageCard.title")}
      // Named for what it governs rather than for the setting's key: people
      // arrive here having noticed the assistant mishearing them, not having
      // gone looking for a speech-recognition parameter.
      subtitle={t("listeningLanguageCard.subtitle")}
    >
      <div className="flex items-center gap-3">
        <span className="min-w-0 text-body-medium-lighter text-[var(--content-default)]">
          {sttLanguageLabelForCode(currentCode, configuredProviderId)}
        </span>
        <Button
          variant="outlined"
          onClick={() => setPickerOpen(true)}
          className="shrink-0"
        >
          {t("listeningLanguageCard.change")}
        </Button>
      </div>
      <SttLanguagePickerModal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={t("listeningLanguageCard.title")}
        currentCode={currentCode}
        configuredProviderId={configuredProviderId}
        selectLanguage={selectLanguage}
        selecting={selecting}
      />
    </DetailCard>
  );
}
