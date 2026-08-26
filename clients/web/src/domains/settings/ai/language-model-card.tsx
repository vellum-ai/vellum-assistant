import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ByoServiceCard } from "@/components/byo-service-card";
import { LanguageModelSection } from "@/domains/settings/ai/language-model-section";
import { ProfilesSection } from "@/domains/settings/ai/profiles-section";
import { ProvidersSection } from "@/domains/settings/ai/providers-section";
import {
  configGetOptions,
  configLlmDefaultproviderGetOptions,
  inferenceProviderconnectionsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useSupportsDefaultProviderSettings } from "@/lib/backwards-compat/default-provider-settings";
import { useTranslation } from "@/i18n";

/**
 * What the Language Model sidepanel is showing. Owned by AiPage (the drawer
 * host); the card only requests transitions.
 */
export type LanguageModelPanelState =
  | { kind: "profile"; name: string }
  | { kind: "create-profile" }
  | { kind: "provider"; name: string }
  | { kind: "add-provider" }
  | { kind: "overrides" };

interface LanguageModelCardProps {
  panel: LanguageModelPanelState | null;
  onOpenPanel: (panel: LanguageModelPanelState) => void;
  onClosePanel: () => void;
}

/**
 * The V2 Language Model card (Figma 7412:133089): Profiles and Providers
 * as inline sections and Overrides collapsed to a count + Manage row, with
 * every detail surface opening in the settings sidepanel.
 */
export function LanguageModelCard({
  panel,
  onOpenPanel,
  onClosePanel,
}: LanguageModelCardProps) {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();

  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });

  // Older assistants 404 the default-provider route; the gate keeps the
  // query dark and the notice hidden against them.
  const supportsDefaultProvider = useSupportsDefaultProviderSettings();
  const { data: defaultProviderStatus } = useQuery({
    ...configLlmDefaultproviderGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: supportsDefaultProvider,
  });
  const availability = defaultProviderStatus?.availability;

  // Connection rows resolve openai-compatible model display names in the
  // profile rows; shared TanStack cache with the sections and sidepanels.
  const { data: connectionsData } = useQuery({
    ...inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId },
    }),
  });
  const connections = connectionsData?.connections;

  const callSites = config?.llm?.callSites ?? {};
  const overrideCount = Object.entries(callSites).filter(
    ([id, s]) =>
      id !== "mainAgent" &&
      (s?.profile != null || s?.provider != null || s?.model != null),
  ).length;

  return (
    <ByoServiceCard
        title={t("languageModelCard.title")}
        subtitle={t("languageModelCard.subtitle")}
      >
        <div className="space-y-2">
          {availability && availability.status !== "ok" && (
            // The server owns the explainable wording - render its message
            // verbatim. `unknown` is transient (credential store unreachable),
            // everything else is a config problem the user must fix.
            <Notice
              tone={availability.status === "unknown" ? "warning" : "error"}
            >
              {availability.message ??
                t("languageModelCard.defaultProviderUnavailable")}
            </Notice>
          )}

          {assistantId && (
            <ProfilesSection
              assistantId={assistantId}
              config={config}
              connections={connections}
              selectedProfileName={
                panel?.kind === "profile" ? panel.name : null
              }
              onOpenProfile={(name) => onOpenPanel({ kind: "profile", name })}
              onCreateProfile={() => onOpenPanel({ kind: "create-profile" })}
              onProfileDeleted={(name) => {
                if (panel?.kind === "profile" && panel.name === name) {
                  onClosePanel();
                }
              }}
            />
          )}

          {assistantId && (
            <ProvidersSection
              assistantId={assistantId}
              selectedConnectionName={
                panel?.kind === "provider" ? panel.name : null
              }
              onOpenConnection={(name) =>
                onOpenPanel({ kind: "provider", name })
              }
              onAddProvider={() => onOpenPanel({ kind: "add-provider" })}
              onConnectionDeleted={(name) => {
                if (panel?.kind === "provider" && panel.name === name) {
                  onClosePanel();
                }
              }}
            />
          )}

          <LanguageModelSection
            title={t("languageModelCard.overridesTitle")}
            count={overrideCount}
            action={
              <Button
                variant="outlined"
                onClick={() => onOpenPanel({ kind: "overrides" })}
              >
                {t("languageModelCard.manage")}
              </Button>
            }
          />
        </div>
    </ByoServiceCard>
  );
}
