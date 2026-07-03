import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { captureError } from "@/lib/sentry/capture-error";
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
  profilePickerLabel,
  visibleProfilesForPicker,
} from "@/assistant/profile-pickers";
import { useStickyProfiles } from "@/assistant/use-sticky-profiles";
import {
  configGetOptions,
  configGetSetQueryData,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
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
  const advisorProfile = config?.llm?.advisorProfile ?? null;
  const callSites = config?.llm?.callSites ?? {};
  // Retain the last non-empty profile list so a transient empty config payload
  // can't blank the Default Profile dropdown until the next good fetch — managed
  // profiles are always seeded, so an empty map is never a steady state.
  const { profiles, profileOrder } = useStickyProfiles(
    config?.llm,
    assistantId,
  );
  const orderedProfiles = useMemo(
    () => buildOrderedProfiles(profiles, profileOrder),
    [profiles, profileOrder],
  );

  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId } },
        data,
      );
    },
  });

  const [effectiveActiveProfile, setDraftActiveProfile] =
    useDraftOverride(activeProfile);
  const [effectiveAdvisorProfile, setDraftAdvisorProfile] =
    useDraftOverride(advisorProfile);

  // Modal toggles — ephemeral UI state, correct as useState
  const [manageProfilesOpen, setManageProfilesOpen] = useState(false);
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [manageProvidersOpen, setManageProvidersOpen] = useState(false);

  const defaultProfilePickerEntries = useMemo(
    () => visibleProfilesForPicker(orderedProfiles, [effectiveActiveProfile]),
    [orderedProfiles, effectiveActiveProfile],
  );

  // Advisor Profile picker reuses the same option source as the Default
  // Profile dropdown; the current advisor selection stays visible even if
  // disabled so the trigger can render its label.
  const advisorProfilePickerEntries = useMemo(
    () => visibleProfilesForPicker(orderedProfiles, [effectiveAdvisorProfile]),
    [orderedProfiles, effectiveAdvisorProfile],
  );

  const overrideCount = Object.entries(callSites).filter(
    ([id, s]) =>
      id !== "mainAgent" &&
      (s?.profile != null || s?.provider != null || s?.model != null),
  ).length;
  const overrideLabel =
    overrideCount === 1
      ? "1 Override"
      : overrideCount > 0
        ? `${overrideCount} Overrides`
        : "Overrides";
  const isProfileDirty = effectiveActiveProfile !== activeProfile;
  const isAdvisorProfileDirty = effectiveAdvisorProfile !== advisorProfile;

  // One save for the whole card. Only the dirty field(s) are sent so we never
  // re-write a value the user didn't edit (the config PATCH deep-merges every
  // provided key, so blindly re-sending a stale selector could clobber a change
  // made elsewhere — e.g. an `/model` switch). `null` clears the advisor profile.
  const handleSave = useCallback(async () => {
    try {
      const llm: {
        activeProfile?: string | null;
        advisorProfile?: string | null;
      } = {};
      if (isProfileDirty) llm.activeProfile = effectiveActiveProfile;
      if (isAdvisorProfileDirty) llm.advisorProfile = effectiveAdvisorProfile;
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { llm },
      });
      toast.success("Saved.");
    } catch (error) {
      toast.error("Failed to save. Please try again.");
      captureError(error, { context: "settings-ai-language-model-save" });
    }
  }, [
    isProfileDirty,
    isAdvisorProfileDirty,
    effectiveActiveProfile,
    effectiveAdvisorProfile,
    configMutation,
    assistantId,
  ]);

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
                label: profilePickerLabel(p),
              }))}
            />
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

          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Advisor Profile
            </label>
            <Dropdown
              value={effectiveAdvisorProfile ?? ""}
              onChange={(val) => {
                setDraftAdvisorProfile(val === "" ? null : val);
              }}
              placeholder="Select an advisor profile…"
              options={advisorProfilePickerEntries.map((p) => ({
                value: p.name,
                label: profilePickerLabel(p),
              }))}
            />
            <Typography
              variant="body-small-default"
              as="p"
              className="mt-1 text-(--content-tertiary)"
            >
              Which model your assistant consults for a second opinion
            </Typography>
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

          {(isProfileDirty || isAdvisorProfileDirty) && (
            <div className="flex items-center gap-2">
              <SaveButton
                onClick={handleSave}
                disabled={configMutation.isPending}
              />
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
