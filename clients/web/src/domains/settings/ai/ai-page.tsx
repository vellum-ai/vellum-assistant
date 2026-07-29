import { useEffect, useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { DetailDrawer, MobileDetailOverlay } from "@/components/detail-drawer";
import { EmailServiceCard } from "@/domains/settings/ai/email-service-card";
import { ImageGenerationCard } from "@/domains/settings/ai/image-generation-card";
import {
  LanguageModelCard,
  type LanguageModelPanelState,
} from "@/domains/settings/ai/language-model-card";
import { ManagedServicesBanner } from "@/domains/settings/ai/shared-ui";
import { ProfileDetailPanel } from "@/domains/settings/ai/profile-detail-panel";
import { ProviderDetailPanel } from "@/domains/settings/ai/provider-detail-panel";
import { SpeechToTextCard } from "@/domains/settings/ai/speech-to-text-card";
import { TextToSpeechCard } from "@/domains/settings/ai/text-to-speech-card";
import { WebFetchCard } from "@/domains/settings/ai/web-fetch-card";
import { WebSearchCard } from "@/domains/settings/ai/web-search-card";
import { useIsMobile } from "@/hooks/use-is-mobile";

// ---------------------------------------------------------------------------
// AiPage — layout shell
// ---------------------------------------------------------------------------

export function AiPage() {
  const assistantId = useActiveAssistantId();
  const isMobile = useIsMobile();

  // The Language Model sidepanel (profile detail / create). Page-owned so
  // the drawer can dock beside the whole card stack, schedules-page style.
  const [lmPanel, setLmPanel] = useState<LanguageModelPanelState | null>(null);

  // Scroll to hash target on mount (e.g. deep links to #email).
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) {
      return;
    }
    requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ block: "start" });
    });
  }, []);

  const section = (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
      <ManagedServicesBanner />

      <LanguageModelCard
        panel={lmPanel}
        onOpenPanel={setLmPanel}
        onClosePanel={() => setLmPanel(null)}
      />
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

  const detailKey =
    lmPanel?.kind === "profile"
      ? `profile:${lmPanel.name}`
      : lmPanel?.kind === "provider"
        ? `provider:${lmPanel.name}`
        : (lmPanel?.kind ?? "closed");
  const isProviderPanel =
    lmPanel?.kind === "provider" || lmPanel?.kind === "add-provider";
  const detail =
    lmPanel != null && assistantId ? (
      isProviderPanel ? (
        <ProviderDetailPanel
          key={detailKey}
          assistantId={assistantId}
          connectionName={lmPanel.kind === "provider" ? lmPanel.name : null}
          onClose={() => setLmPanel(null)}
        />
      ) : (
        <ProfileDetailPanel
          key={detailKey}
          assistantId={assistantId}
          profileName={lmPanel.kind === "profile" ? lmPanel.name : null}
          onClose={() => setLmPanel(null)}
        />
      )
    ) : null;

  // On mobile the detail takes over the whole screen; on desktop it opens as
  // a drawer beside the card stack.
  if (detail && isMobile) {
    return <MobileDetailOverlay>{detail}</MobileDetailOverlay>;
  }

  return detail ? (
    <DetailDrawer
      storageKey="aiSettingsDetailDrawerWidth"
      detailKey={detailKey}
      section={section}
      detail={detail}
    />
  ) : (
    section
  );
}
