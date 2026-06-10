import { ChevronRight, Loader2, Plus, Settings } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { captureError } from "@/lib/sentry/capture-error";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { Button } from "@vellumai/design-library/components/button";
import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

import { ByoServiceCard, SaveButton } from "@/domains/settings/ai/ai-shared-ui";
import { CallSiteOverridesModal } from "@/domains/settings/ai/call-site-overrides-modal";
import { ManageProfilesModal } from "@/domains/settings/ai/manage-profiles-modal";
import { ManageProvidersModal } from "@/domains/settings/ai/manage-providers-modal";
import {
    AUTO_PROFILE_NAME,
    gateAutoProfile,
    profilePickerLabel,
    visibleProfilesForPicker,
} from "@/domains/settings/ai/profile-pickers";
import { filterFlaggedConnections } from "@/domains/settings/ai/provider-connections-client";
import { useDaemonConfigMutation, useDaemonConfigQuery } from "@/domains/settings/ai/use-daemon-config";
import { useDraftOverride } from "@/domains/settings/ai/use-draft-override";
import { configLlmCallsitesGetOptions, inferenceProviderconnectionsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

export function LanguageModelCard() {
  const {
    assistantId,
    orderedProfiles,
    activeProfile,
    callSites,
  } = useDaemonConfigQuery();
  const configMutation = useDaemonConfigMutation();

  const [effectiveActiveProfile, setDraftActiveProfile] = useDraftOverride(activeProfile);

  const [manageProfilesOpen, setManageProfilesOpen] = useState(false);
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [manageProvidersOpen, setManageProvidersOpen] = useState(false);

  const queryComplexityRoutingEnabled =
    useAssistantFeatureFlagStore.use.queryComplexityRouting();
  const openAICompatibleEndpoints =
    useAssistantFeatureFlagStore.use.openAICompatibleEndpoints();
  const analyzeConversationEnabled =
    useAssistantFeatureFlagStore.use.analyzeConversation();

  const defaultProfilePickerEntries = useMemo(
    () =>
      gateAutoProfile(
        visibleProfilesForPicker(orderedProfiles, [effectiveActiveProfile]),
        queryComplexityRoutingEnabled,
      ),
    [orderedProfiles, effectiveActiveProfile, queryComplexityRoutingEnabled],
  );

  // Provider connections — fetched inline for counts
  const { data: connectionsData } = useQuery({
    ...inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId,
    staleTime: 60_000,
  });
  const connections = useMemo(
    () => filterFlaggedConnections(connectionsData?.connections ?? [], openAICompatibleEndpoints),
    [connectionsData, openAICompatibleEndpoints],
  );

  const managedConnectionCount = connections.filter((c) => c.isManaged).length;
  const ownConnectionCount = connections.filter((c) => !c.isManaged).length;

  const managedProfileCount = orderedProfiles.filter(
    (p) => p.source === "managed" && p.name !== AUTO_PROFILE_NAME,
  ).length;
  const ownProfileCount = orderedProfiles.filter(
    (p) => p.source !== "managed" && p.name !== AUTO_PROFILE_NAME,
  ).length;

  // Call-site catalog — fetched for the true total count
  const { data: catalogData } = useQuery({
    ...configLlmCallsitesGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId,
    staleTime: 60_000,
  });
  const totalCallSiteCount = useMemo(() => {
    const all = (catalogData?.callSites ?? []).filter((cs) => cs.id !== "mainAgent");
    if (analyzeConversationEnabled) return all.length;
    return all.filter((cs) => cs.id !== "analyzeConversation").length;
  }, [catalogData, analyzeConversationEnabled]);

  const overrideCount = Object.entries(callSites).filter(
    ([id, s]) => id !== "mainAgent" && (s?.profile != null || s?.provider != null || s?.model != null),
  ).length;

  const isProfileDirty = effectiveActiveProfile !== activeProfile;

  const handleManagedProfileSave = useCallback(async () => {
    try {
      await configMutation.mutateAsync({ llm: { activeProfile: effectiveActiveProfile } });
      toast.success("Profile saved.");
    } catch (error) {
      toast.error("Failed to switch profile. Please try again.");
      captureError(error, { context: "settings-ai-language-model-save" });
    }
  }, [effectiveActiveProfile, configMutation]);

  return (
    <>
      <ByoServiceCard
        title="Model Profiles"
        subtitle="Configure the base LLMs which power your assistants."
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Default Profile
            </label>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Dropdown
                  value={effectiveActiveProfile ?? ""}
                  onChange={(val) => {
                    setDraftActiveProfile(val === "" ? null : val);
                  }}
                  placeholder="Select a default profile…"
                  options={defaultProfilePickerEntries.map((p) => ({
                    value: p.name,
                    label:
                      p.name === AUTO_PROFILE_NAME
                        ? "Automatically switch between profiles"
                        : profilePickerLabel(p),
                  }))}
                />
              </div>
              <Button
                variant="outlined"
                size="regular"
                onClick={() => setManageProfilesOpen(true)}
              >
                + Create
              </Button>
            </div>
            {queryComplexityRoutingEnabled && effectiveActiveProfile === AUTO_PROFILE_NAME && (
              <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-warning-subtle)] px-3 py-2">
                <span className="text-body-small-default text-[var(--content-warning)]">
                  Auto may use more powerful models when needed, which can increase costs.
                </span>
              </div>
            )}
            {defaultProfilePickerEntries.length === 0 ? (
              <Typography
                variant="body-small-default"
                as="p"
                className="mt-1 text-(--content-tertiary)"
              >
                No profiles yet. Open Advanced Options to create one.
              </Typography>
            ) : null}
          </div>

          <Collapsible.Root type="single" collapsible>
            <Collapsible.Item value="advanced">
              <Collapsible.Trigger className="group gap-2 rounded-md py-2">
                <Settings className="h-4 w-4 text-[var(--content-tertiary)]" />
                <span className="text-body-medium-default text-[var(--content-secondary)]">
                  Advanced Options
                </span>
                <ChevronRight className="h-3.5 w-3.5 text-[var(--content-tertiary)] transition-transform duration-200 group-data-[state=open]:rotate-90" />
              </Collapsible.Trigger>
              <Collapsible.Content>
                <p className="mb-4 text-body-small-default text-[var(--content-disabled)]">
                  Define custom model APIs, create and edit Profiles and manage overrides.
                </p>
                <div className="space-y-1">
                  <AdvancedRow
                    label="Provider Connections"
                    description="Configure your own API keys & view Vellum managed options"
                    counts={
                      connections.length > 0
                        ? { managed: managedConnectionCount, own: ownConnectionCount }
                        : undefined
                    }
                    onAdd={() => setManageProvidersOpen(true)}
                    onManage={() => setManageProvidersOpen(true)}
                  />
                  <AdvancedRow
                    label="Profiles"
                    description="View and manage assistant usage profiles"
                    counts={
                      orderedProfiles.length > 0
                        ? { managed: managedProfileCount, own: ownProfileCount }
                        : undefined
                    }
                    onAdd={() => setManageProfilesOpen(true)}
                    onManage={() => setManageProfilesOpen(true)}
                  />
                  <AdvancedRow
                    label="Overrides"
                    description="Assign specific profiles or provider/model combinations"
                    overrideSummary={
                      totalCallSiteCount > 0
                        ? `${overrideCount}/${totalCallSiteCount} overrides`
                        : undefined
                    }
                    onManage={() => setOverridesOpen(true)}
                  />
                </div>
              </Collapsible.Content>
            </Collapsible.Item>
          </Collapsible.Root>

          {isProfileDirty && (
            <div className="flex items-center gap-2">
              <SaveButton onClick={handleManagedProfileSave} disabled={configMutation.isPending} />
              {configMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />
              )}
            </div>
          )}
        </div>
      </ByoServiceCard>

      {assistantId && (
        <ManageProfilesModal
          isOpen={manageProfilesOpen}
          assistantId={assistantId}
          onClose={() => setManageProfilesOpen(false)}
        />
      )}

      {assistantId && (
        <CallSiteOverridesModal
          isOpen={overridesOpen}
          onClose={() => setOverridesOpen(false)}
          assistantId={assistantId}
        />
      )}

      {assistantId && (
        <ManageProvidersModal
          isOpen={manageProvidersOpen}
          assistantId={assistantId}
          onClose={() => setManageProvidersOpen(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// AdvancedRow — a single row inside the Advanced Options collapsible
// ---------------------------------------------------------------------------

interface AdvancedRowProps {
  label: string;
  description: string;
  counts?: { managed: number; own: number };
  overrideSummary?: string;
  onAdd?: () => void;
  onManage: () => void;
}

function AdvancedRow({ label, description, counts, overrideSummary, onAdd, onManage }: AdvancedRowProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-1 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-body-medium-default text-[var(--content-default)]">{label}</div>
        <div className="text-body-small-default text-[var(--content-tertiary)]">{description}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {counts && (
          <div className="flex items-center gap-1.5 text-body-small-default">
            {counts.managed > 0 && (
              <span className="rounded bg-[var(--surface-active)] px-1.5 py-0.5 text-[var(--content-secondary)]">
                {counts.managed} Managed
              </span>
            )}
            {counts.own > 0 && (
              <span className="rounded bg-[var(--system-positive-weak)] px-1.5 py-0.5 text-[var(--system-positive-strong)]">
                {counts.own} Own
              </span>
            )}
          </div>
        )}
        {overrideSummary && (
          <span className="text-body-small-default text-[var(--content-tertiary)]">
            {overrideSummary}
          </span>
        )}
        {onAdd && (
          <Button
            variant="ghost"
            size="compact"
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
            aria-label={`Add ${label.toLowerCase()}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="compact"
          onClick={(e) => {
            e.stopPropagation();
            onManage();
          }}
          aria-label={`Manage ${label.toLowerCase()}`}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
