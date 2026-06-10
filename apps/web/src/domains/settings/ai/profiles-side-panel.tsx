import { Eye, Pencil, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { Typography } from "@vellumai/design-library/components/typography";

import { getModelsForProvider } from "@/assistant/llm-model-catalog";
import type { ProfileEntry, ProfileStatus, ProfileWithName } from "@/domains/settings/ai/ai-types";
import type { BlockedDeleteState } from "@/domains/settings/ai/manage-profiles-blocked-delete-modal";
import { BlockedDeleteModal } from "@/domains/settings/ai/manage-profiles-blocked-delete-modal";
import { ProfileEditorModal } from "@/domains/settings/ai/profile-editor-modal";
import { AUTO_PROFILE_NAME, gateAutoProfile, profilePickerLabel, visibleProfilesForPicker } from "@/domains/settings/ai/profile-pickers";
import { filterFlaggedConnections } from "@/domains/settings/ai/provider-connections-client";
import { useDaemonConfigMutation, useDaemonConfigQuery } from "@/domains/settings/ai/use-daemon-config";
import { captureError } from "@/lib/sentry/capture-error";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { inferenceProviderconnectionsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveModelDisplayName(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): string | null {
  if (!modelId) return null;
  if (!provider) return modelId;
  const entry = getModelsForProvider(provider).find((m) => m.id === modelId);
  return entry?.displayName ?? modelId;
}

function stripManagedSuffix(label: string): string {
  return label.replace(/\s*\(Managed\)\s*$/, "");
}

function formatProfileSubtitle(profile: ProfileWithName): string | null {
  const modelName = resolveModelDisplayName(profile.provider, profile.model);
  if (!modelName) return null;

  const parts: string[] = [modelName];

  if (profile.effort && profile.effort !== "none") {
    const label = profile.effort.charAt(0).toUpperCase() + profile.effort.slice(1);
    parts.push(`${label} Effort`);
  }

  if (profile.thinking?.enabled) {
    parts.push("Thinking ON");
  }

  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// ProfilesSidePanel
// ---------------------------------------------------------------------------

interface ProfilesSidePanelProps {
  assistantId: string;
  onClose: () => void;
}

export function ProfilesSidePanel({
  assistantId,
  onClose,
}: ProfilesSidePanelProps) {
  const {
    profiles,
    profileOrder,
    orderedProfiles,
    activeProfile,
    callSites,
  } = useDaemonConfigQuery();
  const configMutation = useDaemonConfigMutation();

  const openAICompatibleEndpoints = useAssistantFeatureFlagStore.use.openAICompatibleEndpoints();
  const chatgptSubscriptionAuth = useAssistantFeatureFlagStore.use.chatgptSubscriptionAuth();
  const queryComplexityRouting = useAssistantFeatureFlagStore.use.queryComplexityRouting();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ProfileWithName | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Provider connections
  const { data: connectionsData } = useQuery({
    ...inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId },
    }),
  });
  const connections = useMemo(
    () =>
      connectionsData
        ? filterFlaggedConnections(connectionsData.connections, openAICompatibleEndpoints)
        : undefined,
    [connectionsData, openAICompatibleEndpoints],
  );

  const existingNames = Object.keys(profiles);

  // Filtered and ordered profiles
  const allOrderedProfiles = useMemo(
    () => gateAutoProfile(orderedProfiles, queryComplexityRouting),
    [orderedProfiles, queryComplexityRouting],
  );

  const filteredProfiles = useMemo(() => {
    if (!searchQuery.trim()) return allOrderedProfiles;
    const q = searchQuery.toLowerCase();
    return allOrderedProfiles.filter(
      (p) =>
        (p.label ?? p.name).toLowerCase().includes(q) ||
        (p.model ?? "").toLowerCase().includes(q) ||
        (p.provider ?? "").toLowerCase().includes(q),
    );
  }, [allOrderedProfiles, searchQuery]);

  // Default profile picker entries
  const defaultProfilePickerEntries = useMemo(
    () => gateAutoProfile(
      visibleProfilesForPicker(orderedProfiles, [activeProfile]),
      queryComplexityRouting,
    ),
    [orderedProfiles, activeProfile, queryComplexityRouting],
  );

  // ------ Toggle ------
  const [togglingNames, setTogglingNames] = useState<Set<string>>(new Set());
  const [toggleError, setToggleError] = useState<string | null>(null);

  async function handleStatusToggle(profile: ProfileWithName, active: boolean): Promise<boolean> {
    if (togglingNames.has(profile.name)) return false;
    setTogglingNames((prev) => new Set(prev).add(profile.name));
    setToggleError(null);
    const wireStatus: ProfileStatus = active ? "active" : "disabled";
    if (!profiles[profile.name]) {
      setTogglingNames((prev) => { const next = new Set(prev); next.delete(profile.name); return next; });
      return false;
    }
    try {
      await configMutation.mutateAsync({ llm: { profiles: { [profile.name]: { status: wireStatus } } } });
      return true;
    } catch (error) {
      captureError(error, { context: "settings-ai-profile-toggle" });
      setToggleError(`Couldn't update "${profile.label ?? profile.name}". Please try again.`);
      return false;
    } finally {
      setTogglingNames((prev) => { const next = new Set(prev); next.delete(profile.name); return next; });
    }
  }

  // ------ Delete ------
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [blockedDelete, setBlockedDelete] = useState<BlockedDeleteState | null>(null);
  const [blockedDeleteError, setBlockedDeleteError] = useState<string | null>(null);
  const [blockedDeleteReplacement, setBlockedDeleteReplacement] = useState("");
  const [blockedDeleteSaving, setBlockedDeleteSaving] = useState(false);

  async function handleDelete(name: string) {
    setDeleting((prev) => ({ ...prev, [name]: true }));
    setDeleteErrors((prev) => { const next = { ...prev }; delete next[name]; return next; });
    try {
      const newOrder = profileOrder.filter((n) => n !== name);
      await configMutation.mutateAsync({ llm: { profiles: { [name]: null }, profileOrder: newOrder } });
    } catch (error) {
      captureError(error, { context: "settings-ai-profile-delete" });
      setDeleteErrors((prev) => ({ ...prev, [name]: "Failed to delete profile. Please try again." }));
    } finally {
      setDeleting((prev) => { const next = { ...prev }; delete next[name]; return next; });
    }
  }

  function handleDeleteClick(name: string) {
    const profile = allOrderedProfiles.find((p) => p.name === name);
    const label = profile?.label ?? name;
    const isActiveProfile = name === activeProfile;
    const blockedCallSiteIds = Object.entries(callSites)
      .filter(([id, v]) => id !== "mainAgent" && v?.profile === name)
      .map(([id]) => id);

    if (isActiveProfile || blockedCallSiteIds.length > 0) {
      setBlockedDelete({ name, label, isActive: isActiveProfile, callSiteIds: blockedCallSiteIds });
      setBlockedDeleteReplacement("");
      setBlockedDeleteError(null);
      return;
    }
    void handleDelete(name);
  }

  async function handleReassignAndDelete() {
    if (!blockedDelete || !blockedDeleteReplacement) return;
    setBlockedDeleteSaving(true);
    setBlockedDeleteError(null);

    const llmPatch: Record<string, unknown> = {};
    if (blockedDelete.isActive) llmPatch.activeProfile = blockedDeleteReplacement;
    if (blockedDelete.callSiteIds.length > 0) {
      const callSitePatch: Record<string, { profile: string } | null> = {};
      for (const id of blockedDelete.callSiteIds) {
        callSitePatch[id] = { profile: blockedDeleteReplacement };
      }
      llmPatch.callSites = callSitePatch;
    }

    if (Object.keys(llmPatch).length > 0) {
      try {
        await configMutation.mutateAsync({ llm: llmPatch });
      } catch (error) {
        captureError(error, { context: "settings-ai-profile-reassign-delete" });
        setBlockedDeleteError("Failed to reassign references. Please try again.");
        setBlockedDeleteSaving(false);
        return;
      }
    }
    const nameToDelete = blockedDelete.name;
    setBlockedDelete(null);
    setBlockedDeleteSaving(false);
    void handleDelete(nameToDelete);
  }

  // ------ Default profile change ------
  async function handleDefaultProfileChange(value: string) {
    try {
      await configMutation.mutateAsync({ llm: { activeProfile: value || null } });
    } catch (error) {
      captureError(error, { context: "settings-ai-side-panel-default-profile" });
      toast.error("Failed to switch profile. Please try again.");
    }
  }

  // ------ Editor save ------
  async function handleEditorSave(
    name: string,
    entry: ProfileEntry,
    options?: { mode?: "merge" | "replace" },
  ) {
    const mode = options?.mode ?? "replace";
    const isNew = !(name in profiles);

    if (mode === "merge" && !isNew) {
      await configMutation.mutateAsync({ llm: { profiles: { [name]: entry } } });
      setEditorOpen(false);
      setEditingProfile(null);
      return;
    }

    const llmPatch: {
      profiles: Record<string, ProfileEntry>;
      profileOrder?: string[];
      activeProfile?: string;
    } = { profiles: { [name]: entry } };
    if (isNew) {
      const newOrder = profileOrder.includes(name) ? profileOrder : [...profileOrder, name];
      llmPatch.profileOrder = newOrder;
      llmPatch.activeProfile = name;
    }

    if (!isNew) {
      const oldEntry = profiles[name];
      await configMutation.mutateAsync({ llm: { profiles: { [name]: null } } });
      try {
        await configMutation.mutateAsync({ llm: llmPatch });
      } catch (recreateErr) {
        captureError(recreateErr, { context: "settings-ai-profile-edit-recreate" });
        if (oldEntry != null) {
          await configMutation.mutateAsync({ llm: { profiles: { [name]: oldEntry } } }).catch(() => {});
        }
        throw recreateErr;
      }
    } else {
      await configMutation.mutateAsync({ llm: llmPatch });
    }

    if (isNew) {
      toast.success(`Profile "${entry.label ?? name}" created`);
    }

    setEditorOpen(false);
    setEditingProfile(null);
  }

  // Replacement targets for blocked-delete
  const userReplacements = allOrderedProfiles.filter(
    (p) => p.name !== blockedDelete?.name && p.source !== "managed",
  );
  const availableReplacements =
    userReplacements.length > 0
      ? userReplacements
      : allOrderedProfiles.filter((p) => p.name !== blockedDelete?.name);

  const profileCount = allOrderedProfiles.filter((p) => p.name !== AUTO_PROFILE_NAME).length;

  return (
    <>
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-base)] px-4 py-4">
          <Typography variant="body-large-default" as="h2" className="text-(--content-default)">
            Profiles{" "}
            <span className="text-(--content-tertiary)">· {profileCount}</span>
          </Typography>
          <div className="flex items-center gap-2">
            <Button
              variant="outlined"
              size="compact"
              onClick={() => {
                setEditingProfile(null);
                setEditorOpen(true);
              }}
            >
              + Add Profile
            </Button>
            <Button
              variant="ghost"
              size="compact"
              iconOnly={<X />}
              aria-label="Close profiles panel"
              onClick={onClose}
            />
          </div>
        </div>

        {/* Default Profile dropdown */}
        <div className="shrink-0 space-y-1 px-4 pt-4 pb-2">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Default Profile
          </label>
          <Dropdown
            value={activeProfile ?? ""}
            onChange={(val) => void handleDefaultProfileChange(val)}
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

        {/* Description */}
        <p className="shrink-0 px-4 pb-3 text-body-small-default text-[var(--content-tertiary)]">
          Bundle a provider, model and tuning into a named profile. Assign
          profiles to call sites or pick one for a single chat.
        </p>

        {/* Search */}
        <div className="shrink-0 px-4 pb-3">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search Profiles"
            fullWidth
            leftIcon={<Search className="h-4 w-4" />}
          />
        </div>

        {/* Profile list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {filteredProfiles.length === 0 ? (
            <Typography
              variant="body-medium-lighter"
              as="p"
              className="py-4 text-center text-(--content-tertiary)"
            >
              {searchQuery.trim() ? "No profiles match your search." : "No profiles yet. Create one to get started."}
            </Typography>
          ) : (
            <div className="space-y-1">
              {filteredProfiles.map((profile) => {
                const isManaged = profile.source === "managed";
                const isActive = profile.status !== "disabled";
                const isAutoProfile = profile.name === AUTO_PROFILE_NAME;
                const subtitle = formatProfileSubtitle(profile);
                const isItemDeleting = deleting[profile.name] ?? false;
                const deleteError = deleteErrors[profile.name];

                if (isAutoProfile) return null;

                return (
                  <div key={profile.name}>
                    <div
                      className={`flex items-center gap-3 rounded-lg px-2 py-2${isActive ? "" : " opacity-55"}`}
                    >
                      {/* Toggle */}
                      <div className="shrink-0">
                        <Toggle
                          checked={isActive}
                          onChange={(next) => void handleStatusToggle(profile, next)}
                          disabled={togglingNames.has(profile.name)}
                          aria-label={`${isActive ? "Disable" : "Enable"} ${stripManagedSuffix(profile.label ?? profile.name)}`}
                        />
                      </div>

                      {/* Name + model info */}
                      <div className="min-w-0 flex-1">
                        <Typography variant="body-medium-default" as="span" className="text-(--content-default)">
                          {stripManagedSuffix(profile.label ?? profile.name)}
                        </Typography>
                        {subtitle && (
                          <Typography variant="body-small-default" as="p" className="mt-0.5 text-(--content-tertiary)">
                            {subtitle}
                          </Typography>
                        )}
                      </div>

                      {/* Managed/Own tag */}
                      {isManaged ? (
                        <Tag tone="neutral">Managed</Tag>
                      ) : (
                        <Tag tone="positive">Own</Tag>
                      )}

                      {/* Actions */}
                      <div className="flex shrink-0 items-center gap-1">
                        {isManaged ? (
                          <Button
                            variant="ghost"
                            size="compact"
                            iconOnly={<Eye className="h-4 w-4" />}
                            aria-label={`View ${stripManagedSuffix(profile.label ?? profile.name)}`}
                            onClick={() => {
                              setEditingProfile(profile);
                              setEditorOpen(true);
                            }}
                          />
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="compact"
                              iconOnly={<Pencil className="h-4 w-4" />}
                              aria-label={`Edit ${profile.label ?? profile.name}`}
                              onClick={() => {
                                setEditingProfile(profile);
                                setEditorOpen(true);
                              }}
                            />
                            <Button
                              variant="ghost"
                              size="compact"
                              iconOnly={<Trash2 className="h-4 w-4" />}
                              aria-label={`Delete ${profile.label ?? profile.name}`}
                              disabled={isItemDeleting}
                              onClick={() => handleDeleteClick(profile.name)}
                              tintColor="var(--system-negative-strong)"
                            />
                          </>
                        )}
                      </div>
                    </div>
                    {deleteError && (
                      <Typography variant="body-small-default" as="p" className="px-2 pb-1 text-(--system-negative-strong)">
                        {deleteError}
                      </Typography>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {toggleError && (
            <Typography variant="body-small-default" as="p" className="mt-2 text-(--system-negative-strong)">
              {toggleError}
            </Typography>
          )}
        </div>
      </div>

      {/* Profile editor modal (stays as modal overlay) */}
      <ProfileEditorModal
        isOpen={editorOpen}
        mode={
          editingProfile
            ? editingProfile.source === "managed"
              ? "view"
              : "edit"
            : "create"
        }
        profileName={editingProfile?.name}
        initialValues={editingProfile ?? undefined}
        existingNames={existingNames}
        connections={connections}
        openAICompatibleEndpointsEnabled={openAICompatibleEndpoints}
        assistantId={assistantId}
        chatgptSubscriptionEnabled={chatgptSubscriptionAuth}
        onSave={handleEditorSave}
        onCancel={() => {
          setEditorOpen(false);
          setEditingProfile(null);
        }}
      />

      <BlockedDeleteModal
        blocked={blockedDelete}
        availableReplacements={availableReplacements}
        replacement={blockedDeleteReplacement}
        onReplacementChange={setBlockedDeleteReplacement}
        error={blockedDeleteError}
        saving={blockedDeleteSaving}
        onClose={() => {
          setBlockedDelete(null);
          setBlockedDeleteError(null);
        }}
        onConfirm={() => void handleReassignAndDelete()}
      />
    </>
  );
}
