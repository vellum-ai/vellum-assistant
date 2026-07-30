/**
 * Settings → AI card wrapping the shared {@link SttProviderForm} in the
 * settings page's card chrome. The form itself is shared with the live-voice
 * first-run card, which renders it bare inside its own modal.
 */

import { ByoServiceCard } from "@/domains/settings/ai/shared-ui";
import { SttProviderForm } from "@/components/speech/stt-provider-form";

export function SpeechToTextCard() {
  return (
    <ByoServiceCard
      title="Speech-to-Text"
      subtitle="Configure how your assistant transcribes speech"
    >
      <SttProviderForm />
    </ByoServiceCard>
  );
}
