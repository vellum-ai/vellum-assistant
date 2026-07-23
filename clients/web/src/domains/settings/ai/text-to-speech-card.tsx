/**
 * Settings → AI card wrapping the shared {@link TtsProviderForm} in the
 * settings page's card chrome. The form itself is shared with the live-voice
 * first-run card, which renders it bare inside its own modal.
 */

import { ByoServiceCard } from "@/domains/settings/ai/shared-ui";
import { TtsProviderForm } from "@/components/speech/tts-provider-form";

export function TextToSpeechCard() {
  return (
    <ByoServiceCard
      id="text-to-speech"
      title="Text-to-Speech"
      subtitle="Configure how your assistant speaks"
    >
      <TtsProviderForm />
    </ByoServiceCard>
  );
}
