import { useEffect } from "react";

import { LanguageModelCard } from "@/domains/settings/ai/language-model-card";
import { WebSearchCard } from "@/domains/settings/ai/web-search-card";
import { WebFetchCard } from "@/domains/settings/ai/web-fetch-card";
import { EmailServiceCard } from "@/domains/settings/ai/email-service-card";
import { ImageGenerationCard } from "@/domains/settings/ai/image-generation-card";
import { TextToSpeechCard } from "@/domains/settings/ai/text-to-speech-card";
import { SpeechToTextCard } from "@/domains/settings/ai/speech-to-text-card";
import { ManagedServicesBanner } from "@/domains/settings/ai/shared-ui";

// ---------------------------------------------------------------------------
// AiPage — layout shell
// ---------------------------------------------------------------------------

export function AiPage() {
  // Scroll to hash target on mount (e.g. deep links to #email).
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ block: "start" });
    });
  }, []);

  return (
    <div className="space-y-5">
      <ManagedServicesBanner />

      <LanguageModelCard />
      <WebSearchCard />
      <WebFetchCard />
      <EmailServiceCard />
      <ImageGenerationCard />
      {/* Speech providers are BYO provider config like every other card here.
          They used to sit behind a "Services" tab on the Voice page, where the
          voice picker got buried under an API-key form. */}
      <TextToSpeechCard />
      <SpeechToTextCard />
    </div>
  );
}
