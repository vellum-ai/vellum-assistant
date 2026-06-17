import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { captureError } from "@/lib/sentry/capture-error";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

import { ByoServiceCard, SaveButton } from "@/domains/settings/ai/shared-ui";
import { buildOrderedProfiles } from "@/domains/settings/ai/utils";
import { CallSiteOverridesModal } from "@/domains/settings/ai/call-site-overrides-modal";
import { ManageProfilesModal } from "@/domains/settings/ai/manage-profiles-modal";
import { ManageProvidersModal } from "@/domains/settings/ai/manage-providers-modal";
import {
    AUTO_PROFILE_NAME,
    gateAutoProfile,
    profilePickerLabel,
    visibleProfilesForPicker,
} from "@/assistant/profile-pickers";
import { useStickyProfiles } from "@/assistant/use-sticky-profiles";
import { configGetOptions, configGetSetQueryData, useConfigPatchMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { useDraftOverride } from "@/domains/settings/ai/use-draft-override";
import { useQuery } from "@tanstack/react-query";

export function LanguageModelCard() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });

  const activeProfile = config?.llm?.activeProfile ?? null;
  const callSites = config?.llm?.callSites ?? {};
  // Retain the last non-empty profile list so a transient empty config payload
  // can't blank the Default Profile dropdown until the next good fetch — managed
  // profiles are always seeded, so an empty map is never a steady state.
  const { profiles, profileOrder } = useStickyProfiles(config?.llm, assistantId);
  const orderedProfiles = useMemo(
    () => buildOrderedProfiles(profiles, profileOrder),
    [profiles, profileOrder],
  );

  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(queryClient, { path: { assistant_id: assistantId } }, data);
    },
  });

  const [effectiveActiveProfile, setDraftActiveProfile] = useDraftOverride(activeProfile);

  // Modal toggles — ephemeral UI state, correct as useState
  const [manageProfilesOpen, setManageProfilesOpen] = useState(false);
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [manageProvidersOpen, setManageProvidersOpen] = useState(false);

  const queryComplexityRoutingEnabled =
    useAssistantFeatureFlagStore.use.queryComplexityRouting();

  const defaultProfilePickerEntries = useMemo(
    () =>
      gateAutoProfile(
        visibleProfilesForPicker(orderedProfiles, [effectiveActiveProfile]),
        queryComplexityRoutingEnabled,
      ),
    [orderedProfiles, effectiveActiveProfile, queryComplexityRoutingEnabled],
  );

  const overrideCount = Object.entries(callSites).filter(
    ([id, s]) => id !== "mainAgent" && (s?.profile != null || s?.provider != null || s?.model != null),
  ).length;
  const overrideLabel =
    overrideCount === 1 ? "1 Override" : overrideCount > 0 ? `${overrideCount} Overrides` : "Overrides";
  const isProfileDirty = effectiveActiveProfile !== activeProfile;

  const handleManagedProfileSave = useCallback(async () => {
    try {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { llm: { activeProfile: effectiveActiveProfile } },
      });
      toast.success("Profile saved.");
    } catch (error) {
      toast.error("Failed to switch profile. Please try again.");
      captureError(error, { context: "settings-ai-language-model-save" });
    }
  }, [effectiveActiveProfile, configMutation, assistantId]);

  return (
    <>
      <ByoServiceCard
        title="Language Model"
        subtitle="Configure the LLMs that power your assistant"
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Default Profile
            </label>
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
                No profiles yet. Click Profiles below to create one.
              </Typography>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outlined"
              size="compact"
              onClick={() => setManageProvidersOpen(true)}
            >
              Providers
            </Button>
            <Button
              variant="outlined"
              size="compact"
              onClick={() => setManageProfilesOpen(true)}
            >
              Profiles
            </Button>
            <Button
              variant="outlined"
              size="compact"
              onClick={() => setOverridesOpen(true)}
            >
              {overrideLabel}
            </Button>
          </div>

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
