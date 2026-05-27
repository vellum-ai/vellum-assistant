import { GripVertical, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Toggle } from "@vellum/design-library/components/toggle";
import { Modal } from "@vellum/design-library/components/modal";
import { Tag } from "@vellum/design-library/components/tag";
import { Typography } from "@vellum/design-library/components/typography";
import { client } from "@/generated/api/client.gen";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store";

import { type ProfileEntry } from "@/domains/settings/ai/ai-page";
import { ProfileEditorModal } from "@/domains/settings/ai/profile-editor-modal";
import {
  listConnections,
  type ProviderConnection,
} from "@/domains/settings/ai/provider-connections-client";

function filterFlaggedConnections(
  connections: ProviderConnection[],
  openAICompatibleEndpointsEnabled: boolean,
): ProviderConnection[] {
  if (openAICompatibleEndpointsEnabled) return connections;
  return connections.filter((c) => c.provider !== "openai-compatible");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Profile {
  name: string;
  source?: "managed" | "user";
  status?: "active" | "disabled";
  label?: string | null;
  description?: string | null;
  provider?: string | null;
  /**
   * Optional name of a `provider_connections` row this profile is bound to.
   * Mirrors `ProfileEntry.provider_connection` — snake_case both on the
   * wire AND on this in-memory shape (matches the daemon's Zod schema in
   * `assistant/src/config/schemas/llm.ts` and the existing `ProfileEntry`
   * convention in `page.tsx`). Used by `ProfileEditorModal` to populate
   * the per-provider Connection sub-dropdown when re-opening a profile.
   */
  provider_connection?: string | null;
  model?: string | null;
  // Advanced inference params — passed through from the stored ProfileEntry
  // so ProfileEditorModal can initialize them correctly in edit/view mode.
  maxTokens?: number;
  effort?: string;
  speed?: string;
  verbosity?: string;
  temperature?: number | null;
  thinking?: { enabled?: boolean; streamThinking?: boolean };
  contextWindow?: { maxInputTokens?: number };
}

interface BlockedDeleteState {
  name: string;
  label: string;
  isActive: boolean;
  callSiteIds: string[];
}

interface ManageProfilesModalProps {
  isOpen: boolean;
  profiles: Record<string, ProfileEntry>;
  profileOrder: string[];
  activeProfile: string | null;
  assistantId: string;
  callSiteOverrides: Record<string, { profile?: string | null } | null | undefined>;
  onClose: () => void;
  onProfilesChanged: (updates: {
    profiles?: Record<string, ProfileEntry | null>;
    profileOrder?: string[];
    activeProfile?: string | null;
    callSites?: Record<string, string>;
  }) => void;
}

// ---------------------------------------------------------------------------
// ManageProfilesModal
// ---------------------------------------------------------------------------

export function ManageProfilesModal({
  isOpen,
  profiles,
  profileOrder,
  activeProfile,
  assistantId,
  callSiteOverrides,
  onClose,
  onProfilesChanged,
}: ManageProfilesModalProps) {
  const openAICompatibleEndpoints = useAssistantFeatureFlagStore.use.openAICompatibleEndpoints();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  // Provider connections, fetched alongside the modal so ProfileEditorModal can
  // render the per-provider Connection sub-dropdown without dragging the
  // entire SettingsStore into the editor. Mirrors the macOS pattern where
  // `InferenceProfilesSheet` owns the connections list and passes it down to
  // `InferenceProfileEditor` as a `connections` prop. Re-fetches whenever the
  // editor closes so cross-surface additions (e.g. user creates a connection
  // from another tab) are picked up before the user opens another profile.
  //
  // `undefined` vs `[]` is meaningful:
  // - `undefined` → `listConnections` has not yet resolved (pre-load window).
  //   The editor's provider picker falls back to the full catalog so the
  //   trigger isn't empty during that gap.
  // - `[]` → fetch returned zero connections. Fresh workspace with nothing
  //   configured. The editor's filter runs and yields empty, the empty-state
  //   hint fires, and the user is steered to Providers instead of being
  //   allowed to bind a profile to a non-dispatchable provider.
  //
  // Mirrors macOS `InferenceProfilesSheet.connections: [ProviderConnection]?`
  // (PR #30330 follow-up). The web sibling had the same nil-vs-empty trap.
  const [connections, setConnections] = useState<ProviderConnection[] | undefined>(undefined);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const fresh = await listConnections(assistantId);
        if (!cancelled) {
          setConnections(
            filterFlaggedConnections(fresh, openAICompatibleEndpoints),
          );
        }
      } catch {
        // Tolerate failure — keep stale list so the editor still has options
        // if the backend hiccups. Matches macOS `refreshConnections()`.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, assistantId, editorOpen, openAICompatibleEndpoints]);

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
    // wiping seed-owned fields. Skip the delete-then-recreate cycle that
    // replace mode uses. Codex P1 / Devin 🔴 on PR #6543: without this
    // branch, view-mode Save would destroy provider/model/advanced params
    // because the recreate step writes back ONLY the partial entry.
    if (mode === "merge" && !isNew) {
      await client.patch({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: assistantId },
        body: { llm: { profiles: { [name]: entry } } },
        headers: { "Content-Type": "application/json" },
        throwOnError: true,
      });
      // Mirror the server's deep-merge in the in-memory state so the
      // parent's profile map stays consistent with what's on disk.
      const mergedEntry: ProfileEntry = {
        ...profiles[name],
        ...entry,
      };
      onProfilesChanged({ profiles: { [name]: mergedEntry } });
      setEditorOpen(false);
      setEditingProfile(null);
      return;
    }

    const updates: {
      profiles: Record<string, ProfileEntry>;
      profileOrder?: string[];
    } = {
      profiles: { [name]: entry },
    };
    // Build a single atomic PATCH so profile + profileOrder land together.
    const llmPatch: {
      profiles: Record<string, ProfileEntry>;
      profileOrder?: string[];
    } = { profiles: { [name]: entry } };
    if (isNew) {
      // Dedup guard: skip append if name already in profileOrder (stale config).
      const newOrder = profileOrder.includes(name)
        ? profileOrder
        : [...profileOrder, name];
      llmPatch.profileOrder = newOrder;
      updates.profileOrder = newOrder;
    }
    // For edits: delete the existing profile fragment first so the new entry
    // is a clean replacement rather than a deep-merge. This lets the user
    // reset advanced params (maxTokens, effort, speed, etc.) back to "inherit"
    // by using the Inherit button — without this step, deep-merge semantics
    // in deepMergeOverwrite would silently preserve old values for omitted keys.
    // deepMergeOverwrite treats { profiles: { [name]: null } } as a delete-sentinel
    // for the object key, completely removing the profile fragment from config.
    //
    // Rollback: if the recreate PATCH fails after the delete succeeds, we
    // attempt to restore the original entry to avoid data loss. If rollback
    // also fails, the error is still re-thrown so the caller surfaces it.
    if (!isNew) {
      const oldEntry = profiles[name];
      await client.patch({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: assistantId },
        body: { llm: { profiles: { [name]: null } } },
        headers: { "Content-Type": "application/json" },
        throwOnError: true,
      });
      try {
        await client.patch({
          url: `/v1/assistants/{assistant_id}/config`,
          path: { assistant_id: assistantId },
          body: { llm: llmPatch },
          headers: { "Content-Type": "application/json" },
          throwOnError: true,
        });
      } catch (recreateErr) {
        // Best-effort rollback: restore old entry so the profile isn't lost
        if (oldEntry != null) {
          await client
            .patch({
              url: `/v1/assistants/{assistant_id}/config`,
              path: { assistant_id: assistantId },
              body: { llm: { profiles: { [name]: oldEntry } } },
              headers: { "Content-Type": "application/json" },
              throwOnError: true,
            })
            .catch(() => {
              /* rollback failed — original error still propagates */
            });
        }
        throw recreateErr;
      }
    } else {
      await client.patch({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: assistantId },
        body: { llm: llmPatch },
        headers: { "Content-Type": "application/json" },
        throwOnError: true,
      });
    }
    onProfilesChanged(updates);
    setEditorOpen(false);
    setEditingProfile(null);
  }

  // `profiles` is captured at handler-definition time; we need the LATEST
  // entry inside the rollback path so concurrent edits (e.g. user opens the
  // editor mid-toggle and saves new fields) aren't clobbered when restoring
  // `status`. The ref is updated on every render — reads are deferred to
  // rollback so the closure stays fresh. (Codex P2, iter2 round 2.)
  const profilesRef = useRef(profiles);
  useEffect(() => {
    profilesRef.current = profiles;
  });

  async function handleStatusToggle(
    profile: Profile,
    active: boolean,
  ): Promise<boolean> {
    const wireStatus: "active" | "disabled" = active ? "active" : "disabled";
    const previousEntry = profiles[profile.name];
    if (!previousEntry) return false;
    const previousStatus = previousEntry.status;

    // Optimistic update via the parent's onProfilesChanged. The parent
    // owns the profiles state map and re-renders the modal with the
    // flipped status; this mirrors how the editor save flow propagates
    // changes upward.
    onProfilesChanged({
      profiles: {
        [profile.name]: { ...previousEntry, status: wireStatus },
      },
    });
    try {
      await client.patch({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: assistantId },
        body: { llm: { profiles: { [profile.name]: { status: wireStatus } } } },
        headers: { "Content-Type": "application/json" },
        throwOnError: true,
      });
      return true;
    } catch {
      // Selective rollback: restore only `status` on top of whatever the
      // LATEST profile entry is. If the user saved an edit while this
      // PATCH was in flight, those new fields survive — we only undo our
      // own optimistic status flip.
      const latestEntry = profilesRef.current[profile.name];
      if (!latestEntry) {
        // Profile was deleted while toggle was in flight — nothing to
        // restore.
        return false;
      }
      onProfilesChanged({
        profiles: {
          [profile.name]: { ...latestEntry, status: previousStatus },
        },
      });
      return false;
    }
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
            activeProfile={activeProfile}
            assistantId={assistantId}
            callSiteOverrides={callSiteOverrides}
            onClose={onClose}
            onProfilesChanged={onProfilesChanged}
            onEditClick={(profile) => {
              setEditingProfile(profile);
              setEditorOpen(true);
            }}
            onNewClick={() => {
              setEditingProfile(null);
              setEditorOpen(true);
            }}
            onStatusToggle={handleStatusToggle}
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
        assistantId={assistantId}
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
  activeProfile: string | null;
  assistantId: string;
  callSiteOverrides: Record<string, { profile?: string | null } | null | undefined>;
  onClose: () => void;
  onProfilesChanged: (updates: {
    profiles?: Record<string, ProfileEntry | null>;
    profileOrder?: string[];
    activeProfile?: string | null;
    callSites?: Record<string, string>;
  }) => void;
  onEditClick: (profile: Profile) => void;
  onNewClick: () => void;
  /// Inline row-status toggle. Returns `true` on success, `false` on
  /// failure (after the outer wrapper has already rolled back the
  /// optimistic update). The inner uses this to surface a transient
  /// error string when the daemon PATCH fails.
  onStatusToggle: (profile: Profile, active: boolean) => Promise<boolean>;
}

function ManageProfilesModalInner({
  profiles,
  profileOrder,
  activeProfile,
  assistantId,
  callSiteOverrides,
  onClose,
  onProfilesChanged,
  onEditClick,
  onNewClick,
  onStatusToggle,
}: ManageProfilesModalInnerProps) {
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  /// Guards against overlapping toggles for the same profile so a rapid
  /// off→on→off sequence can't produce out-of-order PATCH responses
  /// that clobber the user's final intent. Mirrors `manage-providers-modal`.
  const [togglingNames, setTogglingNames] = useState<Set<string>>(new Set());
  const [toggleError, setToggleError] = useState<string | null>(null);

  async function handleRowStatusToggle(profile: Profile, active: boolean) {
    if (togglingNames.has(profile.name)) return;
    setTogglingNames((prev) => new Set(prev).add(profile.name));
    setToggleError(null);
    try {
      const ok = await onStatusToggle(profile, active);
      if (!ok) {
        setToggleError(
          `Couldn't update "${profile.label ?? profile.name}". Please try again.`,
        );
      }
    } finally {
      setTogglingNames((prev) => {
        const next = new Set(prev);
        next.delete(profile.name);
        return next;
      });
    }
  }

  // Drag-and-drop state
  const [draggingName, setDraggingName] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ name: string; after: boolean } | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  // Tracks the last order successfully persisted to the server. Used for
  // rollback so that a failed drag doesn't undo a concurrent successful one.
  const lastConfirmedOrderRef = useRef<string[]>(profileOrder);
  // Refs allow the onDrop handler to read the latest drag state without
  // depending on React's batched state flushing across fireEvent calls.
  const draggingNameRef = useRef<string | null>(null);
  const dropTargetRef = useRef<{ name: string; after: boolean } | null>(null);

  // Blocked-delete state
  const [blockedDelete, setBlockedDelete] = useState<BlockedDeleteState | null>(null);
  const [blockedDeleteError, setBlockedDeleteError] = useState<string | null>(null);
  const [blockedDeleteReplacement, setBlockedDeleteReplacement] = useState("");
  const [blockedDeleteSaving, setBlockedDeleteSaving] = useState(false);

  // Build ordered profile list
  const orderedProfiles: Profile[] = profileOrder
    .filter((name) => name in profiles)
    .map((name) => {
      const entry = profiles[name]!;
      return {
        name,
        source: entry.source,
        status: entry.status ?? "active",
        label: entry.label ?? undefined,
        description: entry.description ?? undefined,
        provider: entry.provider ?? undefined,
        provider_connection: entry.provider_connection ?? undefined,
        model: entry.model ?? undefined,
        maxTokens: entry.maxTokens,
        effort: entry.effort,
        speed: entry.speed,
        verbosity: entry.verbosity,
        temperature: entry.temperature,
        thinking: entry.thinking,
        contextWindow: entry.contextWindow,
      };
    });

  // Profiles not explicitly in profileOrder but in profiles map
  const profileNames = new Set(profileOrder);
  const extraProfiles: Profile[] = Object.entries(profiles)
    .filter(([name]) => !profileNames.has(name))
    .map(([name, entry]) => ({
      name,
      source: entry.source,
      status: entry.status ?? "active",
      label: entry.label ?? undefined,
      description: entry.description ?? undefined,
      provider: entry.provider ?? undefined,
      provider_connection: entry.provider_connection ?? undefined,
      model: entry.model ?? undefined,
      maxTokens: entry.maxTokens,
      effort: entry.effort,
      speed: entry.speed,
      verbosity: entry.verbosity,
      temperature: entry.temperature,
      thinking: entry.thinking,
      contextWindow: entry.contextWindow,
    }));

  const allOrderedProfiles = [...orderedProfiles, ...extraProfiles];

  async function handleDelete(name: string) {
    setDeleting((prev) => ({ ...prev, [name]: true }));
    setDeleteErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    try {
      const newOrder = profileOrder.filter((n) => n !== name);
      await client.patch({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: assistantId },
        body: { llm: { profiles: { [name]: null }, profileOrder: newOrder } },
        headers: { "Content-Type": "application/json" },
        throwOnError: true,
      });
      onProfilesChanged({
        profiles: { [name]: null },
        profileOrder: newOrder,
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
        await client.patch({
          url: `/v1/assistants/{assistant_id}/config`,
          path: { assistant_id: assistantId },
          body: { llm: patches },
          headers: { "Content-Type": "application/json" },
          throwOnError: true,
        });
        // Propagate all reassigned fields so the parent can invalidate its
        // cache. This matters if the subsequent delete PATCH fails — without
        // this call the parent's callSiteOverrides would stay stale and the
        // user would see the blocked-delete modal again on retry.
        const callSiteUpdate =
          blockedDelete.callSiteIds.length > 0
            ? Object.fromEntries(
                blockedDelete.callSiteIds.map((id) => [id, blockedDeleteReplacement]),
              )
            : undefined;
        onProfilesChanged({
          ...(blockedDelete.isActive && { activeProfile: blockedDeleteReplacement }),
          ...(callSiteUpdate && { callSites: callSiteUpdate }),
        });
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
    // Clear any lingering error from a previous failed drag.
    setReorderError(null);

    const without = profileOrder.filter((n) => n !== sourceName);
    let insertAt = without.indexOf(target.name);
    // Extra profiles (not in profileOrder) are valid drag targets but have no
    // defined position — silently ignore drops onto them to avoid corrupting
    // the order (indexOf would return -1 and slice(0, -1) would drop the last entry).
    if (insertAt === -1) return;
    if (target.after) insertAt += 1;
    const newOrder = [
      ...without.slice(0, insertAt),
      sourceName,
      ...without.slice(insertAt),
    ];

    // Optimistic update
    onProfilesChanged({ profileOrder: newOrder });

    try {
      await client.patch({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: assistantId },
        body: { llm: { profileOrder: newOrder } },
        headers: { "Content-Type": "application/json" },
        throwOnError: true,
      });
      // Record the confirmed server state so concurrent-drag rollbacks
      // don't accidentally undo a later successful reorder.
      lastConfirmedOrderRef.current = newOrder;
    } catch {
      // Roll back to last confirmed server state, not the pre-drag capture,
      // so a failed drag doesn't undo a concurrent successful one.
      onProfilesChanged({ profileOrder: lastConfirmedOrderRef.current });
      setReorderError("Failed to reorder profiles. Please try again.");
    }
  }

  // Prefer non-managed profiles as replacement targets. Fall back to managed
  // profiles when there are no user profiles left — otherwise the modal could
  // show an empty picker with no way for the user to proceed.
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

                      {/* Label — dimmed when disabled (matches macOS opacity) */}
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
                          {isManaged && (
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
                        {/* Inline status toggle — works for managed profiles
                            too. `status` is a UI-level preference the user
                            always owns; auth/managed-edit rules don't apply.
                            Mirrors `manage-providers-modal`. */}
                        <span
                          title={
                            isActive
                              ? "Active — toggle to hide from pickers"
                              : "Disabled — toggle to show in pickers"
                          }
                        >
                          <Toggle
                            checked={isActive}
                            onChange={(next) =>
                              void handleRowStatusToggle(profile, next)
                            }
                            disabled={isToggling}
                            aria-label={`${isActive ? "Disable" : "Enable"} ${profile.label ?? profile.name}`}
                          />
                        </span>
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
  availableReplacements: Profile[];
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
