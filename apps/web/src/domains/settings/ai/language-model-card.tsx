import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Typography } from "@vellum/design-library/components/typography";
import { toast } from "@vellum/design-library/components/toast";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

import { ByoServiceCard, SaveButton } from "@/domains/settings/ai/ai-shared-ui";
import { useDaemonConfig } from "@/domains/settings/ai/use-daemon-config";
import { CallSiteOverridesModal } from "@/domains/settings/ai/call-site-overrides-modal";
import { ManageProfilesModal } from "@/domains/settings/ai/manage-profiles-modal";
import { ManageProvidersModal } from "@/domains/settings/ai/manage-providers-modal";
import {
  AUTO_PROFILE_NAME,
  gateAutoProfile,
  profilePickerLabel,
  visibleProfilesForPicker,
} from "@/domains/settings/ai/profile-pickers";

export function LanguageModelCard() {
  const {
    assistantId,
    orderedProfiles,
    activeProfile,
    callSites,
    patchDaemonConfig,
  } = useDaemonConfig();

  // Draft active profile — ephemeral UI state for the unsaved dropdown
  // selection. Resets to the server value when the server value changes
  // (i.e. after a successful save + cache invalidation).
  const [draftActiveProfile, setDraftActiveProfile] = useState<string | null>(null);
  const [draftInitialized, setDraftInitialized] = useState(false);

  // Sync draft to server value when server value arrives or changes.
  // This replaces the old `initialized` ref + one-shot useEffect pattern
  // with a controlled derivation: when the cache has data and the draft
  // hasn't been touched yet, seed it; when the cache refreshes after a
  // save, re-sync so the dropdown reflects the persisted value.
  const effectiveActiveProfile = useMemo(() => {
    if (!draftInitialized && activeProfile !== null) {
      return activeProfile;
    }
    return draftActiveProfile ?? activeProfile;
  }, [draftInitialized, draftActiveProfile, activeProfile]);

  // Saving state for the "save profile" button
  const [managedProfileSaving, setManagedProfileSaving] = useState(false);

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
    if (!assistantId) {
      toast.error("Assistant not ready. Please try again.");
      return;
    }
    setManagedProfileSaving(true);
    try {
      await patchDaemonConfig({ llm: { activeProfile: effectiveActiveProfile } });
      // Cache invalidation happens automatically via patchConfigMutation.onSettled.
      // Reset draft state so it re-syncs from the new cache value.
      setDraftInitialized(false);
      setDraftActiveProfile(null);
      toast.success("Profile saved.");
    } catch {
      toast.error("Failed to switch profile. Please try again.");
    } finally {
      setManagedProfileSaving(false);
    }
  }, [effectiveActiveProfile, assistantId, patchDaemonConfig]);

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
                setDraftInitialized(true);
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
              <SaveButton onClick={handleManagedProfileSave} disabled={managedProfileSaving} />
              {managedProfileSaving && (
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
