import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Typography } from "@vellum/design-library/components/typography";
import { toast } from "@vellum/design-library/components/toast";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

import type { ProfileEntry } from "@/domains/settings/ai/ai-types";
import { reconcileFromDaemonConfig } from "@/domains/settings/ai/ai-utils";
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
    config: daemonConfig,
    invalidateConfig,
    patchDaemonConfig,
  } = useDaemonConfig();

  // Profile state
  const [activeProfile, setActiveProfile] = useState<string | null>(null);
  const [savedActiveProfile, setSavedActiveProfile] = useState<string | null>(null);
  const [managedProfileSaving, setManagedProfileSaving] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, ProfileEntry>>({});
  const [profileOrder, setProfileOrder] = useState<string[]>([]);

  // Modal toggles
  const [manageProfilesOpen, setManageProfilesOpen] = useState(false);
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [manageProvidersOpen, setManageProvidersOpen] = useState(false);

  // Hydrate from daemon config on first load
  const initialized = useRef(false);
  useEffect(() => {
    if (!daemonConfig || initialized.current) return;
    initialized.current = true;
    const reconciled = reconcileFromDaemonConfig(daemonConfig);
    if (reconciled.activeProfile !== undefined) {
      const resolved = reconciled.activeProfile ?? null;
      setActiveProfile(resolved);
      setSavedActiveProfile(resolved);
    }
    if (reconciled.profiles) setProfiles(reconciled.profiles);
    if (reconciled.profileOrder !== undefined) setProfileOrder(reconciled.profileOrder);
  }, [daemonConfig]);

  // Derived state
  const orderedProfiles = useMemo(() => {
    const ordered = profileOrder
      .filter((name) => name in profiles)
      .map((name) => ({ name, ...profiles[name]! }));
    const inOrder = new Set(profileOrder);
    const extras = Object.entries(profiles)
      .filter(([name]) => !inOrder.has(name))
      .map(([name, entry]) => ({ name, ...entry }));
    return [...ordered, ...extras];
  }, [profiles, profileOrder]);

  const queryComplexityRoutingEnabled =
    useAssistantFeatureFlagStore.use.queryComplexityRouting();

  const defaultProfilePickerEntries = useMemo(
    () =>
      gateAutoProfile(
        visibleProfilesForPicker(orderedProfiles, [activeProfile]),
        queryComplexityRoutingEnabled,
      ),
    [orderedProfiles, activeProfile, queryComplexityRoutingEnabled],
  );

  const overrideCount = Object.entries(daemonConfig?.llm?.callSites ?? {}).filter(
    ([id, s]) => id !== "mainAgent" && (s?.profile != null || s?.provider != null || s?.model != null),
  ).length;
  const overrideLabel =
    overrideCount === 1 ? "1 Override" : overrideCount > 0 ? `${overrideCount} Overrides` : "Overrides";
  const isProfileDirty = activeProfile !== savedActiveProfile;

  const handleManagedProfileSave = useCallback(async () => {
    if (!assistantId) {
      toast.error("Assistant not ready. Please try again.");
      return;
    }
    setManagedProfileSaving(true);
    try {
      await patchDaemonConfig({ llm: { activeProfile } });
      setSavedActiveProfile(activeProfile);
      invalidateConfig();
      toast.success("Profile saved.");
    } catch {
      toast.error("Failed to switch profile. Please try again.");
    } finally {
      setManagedProfileSaving(false);
    }
  }, [activeProfile, assistantId, invalidateConfig, patchDaemonConfig]);

  const handleProfilesChanged = useCallback(
    (updates: {
      profiles?: Record<string, ProfileEntry | null>;
      profileOrder?: string[];
      activeProfile?: string | null;
      callSites?: Record<string, string>;
    }) => {
      if (updates.profiles) {
        setProfiles((prev) => {
          const next = { ...prev };
          for (const [name, entry] of Object.entries(updates.profiles!)) {
            if (entry === null) {
              delete next[name];
            } else {
              next[name] = entry;
            }
          }
          return next;
        });
        invalidateConfig();
      }
      if (updates.profileOrder !== undefined) {
        setProfileOrder(updates.profileOrder);
      }
      if (updates.activeProfile !== undefined) {
        setActiveProfile(updates.activeProfile);
        setSavedActiveProfile(updates.activeProfile);
      }
      if (updates.callSites !== undefined) {
        invalidateConfig();
      }
    },
    [invalidateConfig],
  );

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
              value={activeProfile ?? ""}
              onChange={(val) => {
                setActiveProfile(val === "" ? null : val);
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
            {queryComplexityRoutingEnabled && activeProfile === AUTO_PROFILE_NAME && (
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
          profiles={profiles}
          profileOrder={profileOrder}
          activeProfile={activeProfile}
          assistantId={assistantId}
          callSiteOverrides={daemonConfig?.llm?.callSites ?? {}}
          onClose={() => setManageProfilesOpen(false)}
          onProfilesChanged={handleProfilesChanged}
        />
      )}

      {assistantId && (
        <CallSiteOverridesModal
          isOpen={overridesOpen}
          onClose={() => setOverridesOpen(false)}
          assistantId={assistantId}
          orderedProfiles={orderedProfiles}
          persistedOverrides={daemonConfig?.llm?.callSites ?? {}}
          daemonConfigLoaded={!!daemonConfig}
          onSaved={invalidateConfig}
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
