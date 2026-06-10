import { ExternalLink, Info } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { LanguageModelCard } from "@/domains/settings/ai/language-model-card";
import { ProfilesSidePanel } from "@/domains/settings/ai/profiles-side-panel";
import { WebSearchCard } from "@/domains/settings/ai/web-search-card";
import { EmailServiceCard } from "@/domains/settings/ai/email-service-card";
import { ImageGenerationCard } from "@/domains/settings/ai/image-generation-card";
import { TextToSpeechCard } from "@/domains/settings/ai/text-to-speech-card";
import { SpeechToTextCard } from "@/domains/settings/ai/speech-to-text-card";

// ---------------------------------------------------------------------------
// AiPage — layout shell
// ---------------------------------------------------------------------------

export type SettingsSidePanel = "profiles" | "providers" | null;

export function AiPage() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );
  const [sidePanel, setSidePanel] = useState<SettingsSidePanel>(null);

  const openProfiles = useCallback(() => setSidePanel("profiles"), []);
  const closePanel = useCallback(() => setSidePanel(null), []);

  const isReady = assistantId && (assistantStateKind === "active" || assistantStateKind === "self_hosted");

  // Scroll to hash target on mount (e.g. deep links to #email).
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ block: "start" });
    });
  }, []);

  return (
    <div className={sidePanel && isReady ? "flex h-full gap-4" : ""}>
      <div className={sidePanel && isReady ? "min-w-0 flex-1 overflow-y-auto" : ""}>
        <div className="space-y-5">
          {/* Managed services billing banner */}
          <div className="flex items-start gap-2 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] px-4 py-2.5">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-tertiary)]" />
            <p className="text-body-medium-lighter text-[var(--content-secondary)]">
              Managed services are metered and deducted from your Vellum account
              balance.{" "}
              <a
                href="https://www.vellum.ai/docs/pricing"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[var(--primary-base)] hover:underline"
              >
                View pricing
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </p>
          </div>

          <LanguageModelCard
            onOpenProfiles={openProfiles}
          />
          <WebSearchCard />
          <EmailServiceCard />
          <ImageGenerationCard />
          <TextToSpeechCard />
          <SpeechToTextCard />
        </div>
      </div>

      {sidePanel && isReady && (
        <div className="w-[420px] shrink-0 overflow-hidden rounded-2xl border border-[var(--border-base)] bg-[var(--surface-lift)]">
          {sidePanel === "profiles" && (
            <ProfilesSidePanel
              assistantId={assistantId}
              onClose={closePanel}
            />
          )}
        </div>
      )}
    </div>
  );
}
