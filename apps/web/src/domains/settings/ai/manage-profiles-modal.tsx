import { GripVertical, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellum/design-library/components/button";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Toggle } from "@vellum/design-library/components/toggle";
import { Modal } from "@vellum/design-library/components/modal";
import { Tag } from "@vellum/design-library/components/tag";
import { Typography } from "@vellum/design-library/components/typography";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

import type { DaemonConfig, ProfileEntry, ProfileWithName } from "@/domains/settings/ai/ai-types";
import { ProfileEditorModal } from "@/domains/settings/ai/profile-editor-modal";
import {
  AUTO_PROFILE_NAME,
  gateAutoProfile,
} from "@/domains/settings/ai/profile-pickers";
import { inferenceProviderconnectionsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { filterFlaggedConnections } from "@/domains/settings/ai/provider-connections-client";
import { useDaemonConfig, useDaemonConfigMutation } from "@/domains/settings/ai/use-daemon-config";
import { assistantDaemonConfigQueryKey } from "@/lib/sync/query-tags";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BlockedDeleteState {
  name: string;
  label: string;
  isActive: boolean;
  callSiteIds: string[];
}

interface ManageProfilesModalProps {
  isOpen: boolean;
  assistantId: string;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// ManageProfilesModal
// ---------------------------------------------------------------------------

export function ManageProfilesModal({
  isOpen,
  assistantId,
  onClose,
}: ManageProfilesModalProps) {
  const {
    profiles,
    profileOrder,
    orderedProfiles,
    activeProfile,
    callSites,
  } = useDaemonConfig();
  const configMutation = useDaemonConfigMutation();

  const openAICompatibleEndpoints = useAssistantFeatureFlagStore.use.openAICompatibleEndpoints();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ProfileWithName | null>(null);

  // Provider connections — shared TanStack Query cache with ManageProvidersModal.
  const { data: connectionsData } = useQuery({
    ...inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: isOpen,
  });
  const connections = useMemo(
    () =>
      connectionsData
        ? filterFlaggedConnections(connectionsData.connections, openAICompatibleEndpoints)
        : undefined,
    [connectionsData, openAICompatibleEndpoints],
  );

  const existingNames = Object.keys(profiles);

  async function handleEditorSave(
    name: string,
    entry: ProfileEntry,
    options?: { mode?: "merge" | "replace" },
  ) {
    const mode = options?.mode ?? "replace";
    const isNew = !(name in profiles);

    // Merge mode (view-mode managed-profile policy edits): send a single
    // deep-merge PATCH so the caller's partial `entry` (typically just
    // `{label, status}`) layers on top of the existing record without
    // wiping seed-owned fields.
    if (mode === "merge" && !isNew) {
      await configMutation.mutateAsync({ llm: { profiles: { [name]: entry } } });
      setEditorOpen(false);
      setEditingProfile(null);
      return;
    }

    const llmPatch: {
      profiles: Record<string, ProfileEntry>;
      profileOrder?: string[];
    } = { profiles: { [name]: entry } };
    if (isNew) {
      const newOrder = profileOrder.includes(name)
        ? profileOrder
        : [...profileOrder, name];
      llmPatch.profileOrder = newOrder;
    }

    // For edits: delete the existing profile fragment first so the new entry
    // is a clean replacement rather than a deep-merge. This lets the user
    // reset advanced params back to "inherit" — without this step, deep-merge
    // semantics would silently preserve old values for omitted keys.
    if (!isNew) {
      const oldEntry = profiles[name];
      await configMutation.mutateAsync({ llm: { profiles: { [name]: null } } });
      try {
        await configMutation.mutateAsync({ llm: llmPatch });
      } catch (recreateErr) {
        // Best-effort rollback: restore old entry so the profile isn't lost
        if (oldEntry != null) {
          await configMutation.mutateAsync({ llm: { profiles: { [name]: oldEntry } } }).catch(() => {
            /* rollback failed — original error still propagates */
          });
        }
        throw recreateErr;
      }
    } else {
      await configMutation.mutateAsync({ llm: llmPatch });
    }

    setEditorOpen(false);
    setEditingProfile(null);
  }

  return (
    <>
      <Modal.Root
        open={isOpen}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        {isOpen ? (
          <ManageProfilesModalInner
            profiles={profiles}
            profileOrder={profileOrder}
            orderedProfiles={orderedProfiles}
            activeProfile={activeProfile}
            assistantId={assistantId}
            callSiteOverrides={callSites}
            onClose={onClose}
            onEditClick={(profile) => {
              setEditingProfile(profile);
              setEditorOpen(true);
            }}
            onNewClick={() => {
              setEditingProfile(null);
              setEditorOpen(true);
            }}
          />
        ) : null}
      </Modal.Root>
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
        onSave={handleEditorSave}
        onCancel={() => {
          setEditorOpen(false);
          setEditingProfile(null);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// ManageProfilesModalInner
// ---------------------------------------------------------------------------

interface ManageProfilesModalInnerProps {
  profiles: Record<string, ProfileEntry>;
  profileOrder: string[];
  orderedProfiles: ProfileWithName[];
  activeProfile: string | null;
  assistantId: string;
  callSiteOverrides: Record<string, { profile?: string | null } | null | undefined>;
  onClose: () => void;
  onEditClick: (profile: ProfileWithName) => void;
  onNewClick: () => void;
}

function ManageProfilesModalInner({
  profiles,
  profileOrder,
  orderedProfiles,
  activeProfile,
  assistantId,
  callSiteOverrides,
  onClose,
  onEditClick,
  onNewClick,
}: ManageProfilesModalInnerProps) {
  const configMutation = useDaemonConfigMutation();
  const queryClient = useQueryClient();
  const queryKey = assistantDaemonConfigQueryKey(assistantId);

  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [togglingNames, setTogglingNames] = useState<Set<string>>(new Set());
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Drag-and-drop state
  const [draggingName, setDraggingName] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ name: string; after: boolean } | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const lastConfirmedOrderRef = useRef<string[]>(profileOrder);
  const draggingNameRef = useRef<string | null>(null);
  const dropTargetRef = useRef<{ name: string; after: boolean } | null>(null);

  // Blocked-delete state
  const [blockedDelete, setBlockedDelete] = useState<BlockedDeleteState | null>(null);
  const [blockedDeleteError, setBlockedDeleteError] = useState<string | null>(null);
  const [blockedDeleteReplacement, setBlockedDeleteReplacement] = useState("");
  const [blockedDeleteSaving, setBlockedDeleteSaving] = useState(false);

  const queryComplexityRouting = useAssistantFeatureFlagStore.use.queryComplexityRouting();

  // Build ordered profile list
  const allOrderedProfiles: ProfileWithName[] = useMemo(() => {
    return gateAutoProfile(orderedProfiles, queryComplexityRouting);
  }, [orderedProfiles, queryComplexityRouting]);

  async function handleStatusToggle(
    profile: ProfileWithName,
    active: boolean,
  ): Promise<boolean> {
    if (togglingNames.has(profile.name)) return false;
    setTogglingNames((prev) => new Set(prev).add(profile.name));
    setToggleError(null);

    const wireStatus: "active" | "disabled" = active ? "active" : "disabled";
    const previousEntry = profiles[profile.name];
    if (!previousEntry) {
      setTogglingNames((prev) => {
        const next = new Set(prev);
        next.delete(profile.name);
        return next;
      });
      return false;
    }

    // Cancel in-flight refetches so they don't overwrite the optimistic update.
    // See: https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query
    await queryClient.cancelQueries({ queryKey });

    const previousStatus = previousEntry.status ?? "active";
    queryClient.setQueryData<DaemonConfig>(queryKey, (old) => {
      if (!old?.llm?.profiles?.[profile.name]) return old;
      return {
        ...old,
        llm: {
          ...old.llm,
          profiles: {
            ...old.llm.profiles,
            [profile.name]: { ...old.llm.profiles[profile.name], status: wireStatus },
          },
        },
      };
    });

    try {
      await configMutation.mutateAsync({
        llm: { profiles: { [profile.name]: { status: wireStatus } } },
      });
      return true;
    } catch {
      // Rollback only the toggled field to avoid overwriting concurrent cache updates
      queryClient.setQueryData<DaemonConfig>(queryKey, (old) => {
        if (!old?.llm?.profiles?.[profile.name]) return old;
        return {
          ...old,
          llm: {
            ...old.llm,
            profiles: {
              ...old.llm.profiles,
              [profile.name]: { ...old.llm.profiles[profile.name], status: previousStatus },
            },
          },
        };
      });
      setToggleError(
        `Couldn't update "${profile.label ?? profile.name}". Please try again.`,
      );
      return false;
    } finally {
      setTogglingNames((prev) => {
        const next = new Set(prev);
        next.delete(profile.name);
        return next;
      });
    }
  }

  async function handleDelete(name: string) {
    setDeleting((prev) => ({ ...prev, [name]: true }));
    setDeleteErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    try {
      const newOrder = profileOrder.filter((n) => n !== name);
      await configMutation.mutateAsync({
        llm: { profiles: { [name]: null }, profileOrder: newOrder },
      });
    } catch {
      setDeleteErrors((prev) => ({
        ...prev,
        [name]: "Failed to delete profile. Please try again.",
      }));
    } finally {
      setDeleting((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  }

  function handleDeleteClick(name: string) {
    const profile = allOrderedProfiles.find((p) => p.name === name);
    const label = profile?.label ?? name;
    const isActive = name === activeProfile;
    const blockedCallSiteIds = Object.entries(callSiteOverrides)
      .filter(([id, v]) => id !== "mainAgent" && v?.profile === name)
      .map(([id]) => id);

    if (isActive || blockedCallSiteIds.length > 0) {
      setBlockedDelete({ name, label, isActive, callSiteIds: blockedCallSiteIds });
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

    const patches: Record<string, unknown> = {};

    if (blockedDelete.isActive) {
      patches.activeProfile = blockedDeleteReplacement;
    }

    if (blockedDelete.callSiteIds.length > 0) {
      const callSitePatch: Record<string, unknown> = {};
      for (const id of blockedDelete.callSiteIds) {
        callSitePatch[id] = { profile: blockedDeleteReplacement };
      }
      patches.callSites = callSitePatch;
    }

    if (Object.keys(patches).length > 0) {
      try {
        await configMutation.mutateAsync({ llm: patches });
      } catch {
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

  async function handleReorder(
    sourceName: string,
    target: { name: string; after: boolean },
  ) {
    if (sourceName === target.name) return;
    setReorderError(null);

    const without = profileOrder.filter((n) => n !== sourceName);
    let insertAt = without.indexOf(target.name);
    if (insertAt === -1) return;
    if (target.after) insertAt += 1;
    const newOrder = [
      ...without.slice(0, insertAt),
      sourceName,
      ...without.slice(insertAt),
    ];

    // Cancel in-flight refetches so they don't overwrite the optimistic update.
    await queryClient.cancelQueries({ queryKey });

    queryClient.setQueryData<DaemonConfig>(queryKey, (old) => {
      if (!old?.llm) return old;
      return {
        ...old,
        llm: { ...old.llm, profileOrder: newOrder },
      };
    });

    try {
      await configMutation.mutateAsync({ llm: { profileOrder: newOrder } });
      lastConfirmedOrderRef.current = newOrder;
    } catch {
      // Rollback to last confirmed server state
      queryClient.setQueryData<DaemonConfig>(queryKey, (old) => {
        if (!old?.llm) return old;
        return {
          ...old,
          llm: { ...old.llm, profileOrder: lastConfirmedOrderRef.current },
        };
      });
      setReorderError("Failed to reorder profiles. Please try again.");
    }
  }

  // Prefer non-managed profiles as replacement targets
  const userReplacements = allOrderedProfiles.filter(
    (p) => p.name !== blockedDelete?.name && p.source !== "managed",
  );
  const availableReplacements =
    userReplacements.length > 0
      ? userReplacements
      : allOrderedProfiles.filter((p) => p.name !== blockedDelete?.name);

  return (
    <>
      <Modal.Content size="md">
        <Modal.Header>
          <Modal.Title>Model Profiles</Modal.Title>
          <Modal.Description>
            Bundle a provider and model into a named profile. Assign profiles to specific actions or swap between them when chatting.
          </Modal.Description>
        </Modal.Header>

        <Modal.Body>
          {allOrderedProfiles.length === 0 ? (
            <Typography
              variant="body-medium-lighter"
              as="p"
              className="py-4 text-center text-(--content-tertiary)"
            >
              No profiles yet. Create one to get started.
            </Typography>
          ) : (
            <div className="space-y-1">
              {allOrderedProfiles.map((profile) => {
                const isManaged = profile.source === "managed";
                const isDeleting = deleting[profile.name] ?? false;
                const deleteError = deleteErrors[profile.name];

                const isActive = profile.status !== "disabled";
                const isToggling = togglingNames.has(profile.name);
                const isAutoProfile = profile.name === AUTO_PROFILE_NAME;

                return (
                  <div key={profile.name} className="relative">
                    {dropTarget?.name === profile.name && !dropTarget.after && (
                      <div className="mx-0 h-0.5 rounded-full bg-[var(--border-active)]" />
                    )}
                    <div
                      className={`flex items-center gap-2 rounded-lg pr-2 py-2${draggingName === profile.name ? " opacity-50" : ""}`}
                      draggable={!isManaged}
                      onDragStart={(e) => {
                        draggingNameRef.current = profile.name;
                        setDraggingName(profile.name);
                        if (e.dataTransfer) {
                          e.dataTransfer.effectAllowed = "move";
                        }
                      }}
                      onDragEnd={() => {
                        draggingNameRef.current = null;
                        dropTargetRef.current = null;
                        setDraggingName(null);
                        setDropTarget(null);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const after = e.clientY > rect.top + rect.height / 2;
                        const t = { name: profile.name, after };
                        dropTargetRef.current = t;
                        setDropTarget(t);
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                          dropTargetRef.current = null;
                          setDropTarget((prev) =>
                            prev?.name === profile.name ? null : prev,
                          );
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const source = draggingNameRef.current;
                        const target = dropTargetRef.current;
                        draggingNameRef.current = null;
                        dropTargetRef.current = null;
                        setDraggingName(null);
                        setDropTarget(null);
                        if (source && target) {
                          void handleReorder(source, target);
                        }
                      }}
                    >
                      {/* Grip icon — invisible for managed profiles to preserve alignment */}
                      <GripVertical
                        className={`h-4 w-4 shrink-0 ${isManaged ? "invisible" : "cursor-grab text-[var(--content-tertiary)]"}`}
                      />

                      {/* Label — dimmed when disabled */}
                      <div
                        className={`min-w-0 flex-1${isActive ? "" : " opacity-55"}`}
                      >
                        <div className="flex items-center gap-2">
                          <Typography
                            variant="body-medium-default"
                            as="span"
                            className="text-(--content-default)"
                          >
                            {profile.label ?? profile.name}
                          </Typography>
                          {isManaged && profile.name !== AUTO_PROFILE_NAME && (
                            <Tag
                              tone="positive"
                              title="Managed by Platform — auth is locked, but you can rename or disable this profile."
                            >
                              Platform
                            </Tag>
                          )}
                        </div>
                        {profile.description ? (
                          <Typography
                            variant="body-medium-lighter"
                            as="p"
                            className="mt-0.5 text-(--content-tertiary)"
                          >
                            {profile.description}
                          </Typography>
                        ) : null}
                        {(profile.model ?? profile.provider) ? (
                          <Typography
                            variant="body-medium-lighter"
                            as="p"
                            className="mt-0.5 text-(--content-tertiary)"
                          >
                            {profile.model ?? profile.provider}
                          </Typography>
                        ) : null}
                      </div>

                      {/* Actions */}
                      <div className="flex shrink-0 items-center gap-2">
                        <div
                          className="flex shrink-0 items-center"
                          title={
                            isActive
                              ? "Active — toggle to hide from pickers"
                              : "Disabled — toggle to show in pickers"
                          }
                        >
                          <Toggle
                            checked={isActive}
                            onChange={(next) =>
                              void handleStatusToggle(profile, next)
                            }
                            disabled={isToggling}
                            aria-label={`${isActive ? "Disable" : "Enable"} ${profile.label ?? profile.name}`}
                          />
                        </div>
                        <div
                          className={`flex w-[92px] items-center justify-end gap-2${isAutoProfile ? " invisible" : ""}`}
                        >
                          <Button
                            variant="ghost"
                            size="compact"
                            onClick={() => onEditClick(profile)}
                          >
                            {isManaged ? "View" : "Edit"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="compact"
                            iconOnly={<Trash2 />}
                            aria-label={`Delete ${profile.label ?? profile.name}`}
                            disabled={isManaged || isDeleting}
                            title={
                              isManaged ? "Managed profiles cannot be deleted" : undefined
                            }
                            onClick={() => handleDeleteClick(profile.name)}
                            tintColor="var(--system-negative-strong)"
                          />
                        </div>
                      </div>
                    </div>
                    {dropTarget?.name === profile.name && dropTarget.after && (
                      <div className="mx-0 h-0.5 rounded-full bg-[var(--border-active)]" />
                    )}
                    {deleteError ? (
                      <Typography
                        variant="body-small-default"
                        as="p"
                        className="px-2 pb-1 text-(--system-negative-strong)"
                      >
                        {deleteError}
                      </Typography>
                    ) : null}
                    {profile.name === AUTO_PROFILE_NAME && (
                      <div className="mx-2 mt-1 border-b border-[var(--border-subtle)]" />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {reorderError && (
            <Typography
              variant="body-small-default"
              as="p"
              className="mt-2 text-(--system-negative-strong)"
            >
              {reorderError}
            </Typography>
          )}
          {toggleError && (
            <Typography
              variant="body-small-default"
              as="p"
              className="mt-2 text-(--system-negative-strong)"
            >
              {toggleError}
            </Typography>
          )}
        </Modal.Body>

        <Modal.Footer className="justify-between">
          <Button variant="outlined" size="compact" onClick={onNewClick}>
            + New Profile
          </Button>
          <Button variant="outlined" size="compact" onClick={onClose}>
            Done
          </Button>
        </Modal.Footer>
      </Modal.Content>

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

// ---------------------------------------------------------------------------
// BlockedDeleteModal
// ---------------------------------------------------------------------------

function BlockedDeleteModal({
  blocked,
  availableReplacements,
  replacement,
  onReplacementChange,
  error,
  saving,
  onClose,
  onConfirm,
}: {
  blocked: BlockedDeleteState | null;
  availableReplacements: ProfileWithName[];
  replacement: string;
  onReplacementChange: (value: string) => void;
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  let summary = "";
  if (blocked) {
    const display = blocked.label || blocked.name;
    if (blocked.isActive && blocked.callSiteIds.length > 0) {
      summary = `"${display}" is the active profile and is used by ${blocked.callSiteIds.length} call site(s). Pick a replacement profile.`;
    } else if (blocked.isActive) {
      summary = `"${display}" is the active profile. Pick a different active profile before deleting, or select a replacement below.`;
    } else {
      summary = `"${display}" is used by ${blocked.callSiteIds.length} call site(s). Select a replacement profile to reassign them before deleting.`;
    }
  }

  return (
    <Modal.Root
      open={blocked !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>Can&apos;t Delete Profile</Modal.Title>
        </Modal.Header>
        <Modal.Body className="space-y-4">
          <Typography variant="body-medium-default" as="p">
            {summary}
          </Typography>
          {blocked && blocked.callSiteIds.length > 0 && (
            <ul className="space-y-1 pl-1">
              {blocked.callSiteIds.map((id) => (
                <li
                  key={id}
                  className="text-body-small-default text-(--content-secondary)"
                >
                  • <code>{id}</code>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Replacement profile
            </label>
            <Dropdown
              aria-label="Replacement profile"
              value={replacement}
              onChange={onReplacementChange}
              options={[
                { value: "", label: "Select a replacement…" },
                ...availableReplacements.map((p) => ({
                  value: p.name,
                  label: p.label ?? p.name,
                })),
              ]}
            />
          </div>
          {error && (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-(--system-negative-strong)"
            >
              {error}
            </Typography>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" size="compact" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            disabled={!replacement || saving}
            onClick={onConfirm}
          >
            {saving ? "Saving…" : "Reassign and Delete"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
