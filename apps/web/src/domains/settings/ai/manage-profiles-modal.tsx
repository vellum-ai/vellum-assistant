import { useMemo, useRef, useState } from "react";

import { captureError } from "@/lib/sentry/capture-error";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

import type { CallSiteOverrideDraft, ConfigPatchRequest, ProfileEntry, ProfilePatchEntry, ProfileStatus } from "@/generated/daemon/types.gen";

import { type ProfileWithName, buildOrderedProfiles } from "@/domains/settings/ai/utils";
import type { BlockedDeleteState } from "@/domains/settings/ai/manage-profiles-blocked-delete-modal";
import { BlockedDeleteModal } from "@/domains/settings/ai/manage-profiles-blocked-delete-modal";
import { ProfileListItem } from "@/domains/settings/ai/manage-profiles-list-item";
import { ProfileEditorModal } from "@/domains/settings/ai/profile-editor-modal";
import { gateAutoProfile } from "@/assistant/profile-pickers";
import { configGetOptions, configGetSetQueryData, inferenceProviderconnectionsGetOptions, useConfigPatchMutation } from "@/generated/daemon/@tanstack/react-query.gen";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  const queryClient = useQueryClient();

  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });

  const profiles = useMemo(() => config?.llm?.profiles ?? {}, [config?.llm?.profiles]);
  const profileOrder = useMemo(() => config?.llm?.profileOrder ?? [], [config?.llm?.profileOrder]);
  const activeProfile = config?.llm?.activeProfile ?? null;
  const callSites = config?.llm?.callSites ?? {};
  const orderedProfiles = useMemo(
    () => buildOrderedProfiles(profiles, profileOrder),
    [profiles, profileOrder],
  );

  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(queryClient, { path: { assistant_id: assistantId } }, data);
    },
  });

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ProfileWithName | null>(null);

  // Provider connections — shared TanStack Query cache with ManageProvidersModal.
  const { data: connectionsData } = useQuery({
    ...inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: isOpen,
  });
  const connections = connectionsData?.connections;

  const existingNames = Object.keys(profiles);

  async function handleEditorSave(
    name: string,
    entry: ProfilePatchEntry,
    options?: { mode?: "merge" | "replace" },
  ) {
    const mode = options?.mode ?? "replace";
    const isNew = !(name in profiles);

    // Merge mode (view-mode managed-profile policy edits): send a single
    // deep-merge PATCH so the caller's partial `entry` (typically just
    // `{label, status}`) layers on top of the existing record without
    // wiping seed-owned fields.
    if (mode === "merge" && !isNew) {
      await configMutation.mutateAsync({ path: { assistant_id: assistantId }, body: { llm: { profiles: { [name]: entry } } } });
      setEditorOpen(false);
      setEditingProfile(null);
      return;
    }

    const llmPatch: {
      profiles: Record<string, ProfilePatchEntry>;
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
      await configMutation.mutateAsync({ path: { assistant_id: assistantId }, body: { llm: { profiles: { [name]: null } } } });
      try {
        await configMutation.mutateAsync({ path: { assistant_id: assistantId }, body: { llm: llmPatch } });
      } catch (recreateErr) {
        captureError(recreateErr, { context: "settings-ai-profile-edit-recreate" });
        // Best-effort rollback: restore old entry so the profile isn't lost
        if (oldEntry != null) {
          await configMutation.mutateAsync({ path: { assistant_id: assistantId }, body: { llm: { profiles: { [name]: oldEntry } } } }).catch(() => {
            /* rollback failed — original error still propagates */
          });
        }
        throw recreateErr;
      }
    } else {
      await configMutation.mutateAsync({ path: { assistant_id: assistantId }, body: { llm: llmPatch } });
    }

    // Fire the profile-create success toast from the SETTINGS surface only.
    // The composer quick-add surface owns its own create toast, so firing
    // here (rather than inside ProfileEditorModal, which both surfaces share)
    // keeps exactly one success toast per create with no double-fire.
    if (isNew) {
      toast.success(`Profile "${entry.label ?? name}" created`);
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
            assistantId={assistantId}
            profiles={profiles}
            profileOrder={profileOrder}
            orderedProfiles={orderedProfiles}
            activeProfile={activeProfile}
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
        assistantId={assistantId}
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
  assistantId: string;
  profiles: Record<string, ProfileEntry>;
  profileOrder: string[];
  orderedProfiles: ProfileWithName[];
  activeProfile: string | null;
  callSiteOverrides: Record<string, { profile?: string | null } | null | undefined>;
  onClose: () => void;
  onEditClick: (profile: ProfileWithName) => void;
  onNewClick: () => void;
}

function ManageProfilesModalInner({
  assistantId,
  profiles,
  profileOrder,
  orderedProfiles,
  activeProfile,
  callSiteOverrides,
  onClose,
  onEditClick,
  onNewClick,
}: ManageProfilesModalInnerProps) {
  const queryClient = useQueryClient();
  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(queryClient, { path: { assistant_id: assistantId } }, data);
    },
  });

  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [togglingNames, setTogglingNames] = useState<Set<string>>(new Set());
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Drag-and-drop state
  const [draggingName, setDraggingName] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ name: string; after: boolean } | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
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

    const wireStatus: ProfileStatus = active ? "active" : "disabled";
    if (!profiles[profile.name]) {
      setTogglingNames((prev) => {
        const next = new Set(prev);
        next.delete(profile.name);
        return next;
      });
      return false;
    }

    try {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { llm: { profiles: { [profile.name]: { status: wireStatus } } } },
      });
      return true;
    } catch (error) {
      captureError(error, { context: "settings-ai-profile-toggle" });
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
        path: { assistant_id: assistantId },
        body: { llm: { profiles: { [name]: null }, profileOrder: newOrder } },
      });
    } catch (error) {
      captureError(error, { context: "settings-ai-profile-delete" });
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

    const llmPatch: NonNullable<ConfigPatchRequest["llm"]> = {};

    if (blockedDelete.isActive) {
      llmPatch.activeProfile = blockedDeleteReplacement;
    }

    if (blockedDelete.callSiteIds.length > 0) {
      const callSitePatch: Record<string, CallSiteOverrideDraft | null> = {};
      for (const id of blockedDelete.callSiteIds) {
        callSitePatch[id] = { profile: blockedDeleteReplacement };
      }
      llmPatch.callSites = callSitePatch;
    }

    if (Object.keys(llmPatch).length > 0) {
      try {
        await configMutation.mutateAsync({ path: { assistant_id: assistantId }, body: { llm: llmPatch } });
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

    try {
      await configMutation.mutateAsync({ path: { assistant_id: assistantId }, body: { llm: { profileOrder: newOrder } } });
    } catch (error) {
      captureError(error, { context: "settings-ai-profile-reorder" });
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
              {allOrderedProfiles.map((profile) => (
                <ProfileListItem
                  key={profile.name}
                  profile={profile}
                  isDragging={draggingName === profile.name}
                  dropTarget={dropTarget}
                  isDeleting={deleting[profile.name] ?? false}
                  deleteError={deleteErrors[profile.name]}
                  isToggling={togglingNames.has(profile.name)}
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
                  onEditClick={() => onEditClick(profile)}
                  onDeleteClick={() => handleDeleteClick(profile.name)}
                  onStatusToggle={(next) => void handleStatusToggle(profile, next)}
                />
              ))}
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
