import { useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ByoServiceCard } from "@/domains/settings/ai/shared-ui";
import { CallSiteOverridesModal } from "@/domains/settings/ai/call-site-overrides-modal";
import { LanguageModelSection } from "@/domains/settings/ai/language-model-section";
import { ProfilesSection } from "@/domains/settings/ai/profiles-section";
import { ProvidersSection } from "@/domains/settings/ai/providers-section";
import {
  configGetOptions,
  configLlmDefaultproviderGetOptions,
  inferenceProviderconnectionsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useSupportsDefaultProviderSettings } from "@/lib/backwards-compat/default-provider-settings";

/**
 * What the Language Model sidepanel is showing. Owned by AiPage (the drawer
 * host); the card only requests transitions.
 */
export type LanguageModelPanelState =
  | { kind: "profile"; name: string }
  | { kind: "create-profile" }
  | { kind: "provider"; name: string }
  | { kind: "add-provider" };

interface LanguageModelCardProps {
  panel: LanguageModelPanelState | null;
  onOpenPanel: (panel: LanguageModelPanelState) => void;
  onClosePanel: () => void;
}

/**
 * The V2 Language Model card (Figma 7412:133089): Profiles and Providers as
 * inline sections whose details open in the settings sidepanel, and
 * Overrides collapsed to a count + Manage row (its own sidepanel conversion
 * is the remaining LUM-2881 follow-up).
 */
export function LanguageModelCard({
  panel,
  onOpenPanel,
  onClosePanel,
}: LanguageModelCardProps) {
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

  // Modal toggle - ephemeral UI state, correct as useState
  const [overridesOpen, setOverridesOpen] = useState(false);

  return (
    <>
      <ByoServiceCard
        title="Language Model"
        subtitle="Profiles choose which model answers. Providers supply access to it"
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
                "Your default provider is not available."}
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
            title="Overrides"
            count={overrideCount}
            action={
              <Button
                variant="outlined"
                size="compact"
                onClick={() => setOverridesOpen(true)}
              >
                Manage
              </Button>
            }
          />
        </div>
      </ByoServiceCard>

      {assistantId && (
        <CallSiteOverridesModal
          isOpen={overridesOpen}
          onClose={() => setOverridesOpen(false)}
          assistantId={assistantId}
        />
      )}
    </>
  );
}
