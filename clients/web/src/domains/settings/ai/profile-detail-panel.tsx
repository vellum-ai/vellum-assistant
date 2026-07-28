import { Trash2 } from "lucide-react";
import { useEffect, useMemo } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";

import { DetailShell } from "@/components/detail-shell";
import { BlockedDeleteModal } from "@/domains/settings/ai/manage-profiles-blocked-delete-modal";
import { ProfileEditorFields } from "@/domains/settings/ai/profile-editor-fields";
import { useProfileDeleteFlow } from "@/domains/settings/ai/use-profile-delete-flow";
import { useProfileEditor } from "@/domains/settings/ai/use-profile-editor";
import type { ProfileWithName } from "@/domains/settings/ai/utils";
import { captureError } from "@/lib/sentry/capture-error";
import {
  configGetOptions,
  configGetSetQueryData,
  inferenceProfilesGetQueryKey,
  inferenceProviderconnectionsGetOptions,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ProfilePatchEntry } from "@/generated/daemon/types.gen";

interface ProfileDetailPanelProps {
  assistantId: string;
  /** Profile key to open, or `null` for the create flow. */
  profileName: string | null;
  onClose: () => void;
}

/**
 * Sidepanel host for the profile editor (Figma 7412:134159): DetailShell
 * chrome with the profile name, a Delete header action for user profiles,
 * the flat field stack, and a pinned "Save Changes" footer. Managed
 * profiles open read-only with "Save As New" as the escape hatch.
 *
 * Hosts must remount the panel per selection (key by `profileName`) — the
 * editor snapshots its initial values on mount.
 */
export function ProfileDetailPanel({
  assistantId,
  profileName,
  onClose,
}: ProfileDetailPanelProps) {
  const queryClient = useQueryClient();

  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  const { data: connectionsData } = useQuery({
    ...inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId },
    }),
  });
  const connections = connectionsData?.connections;

  const profiles = useMemo(
    () => config?.llm?.profiles ?? {},
    [config?.llm?.profiles],
  );
  const profileOrder = useMemo(
    () => config?.llm?.profileOrder ?? [],
    [config?.llm?.profileOrder],
  );
  const existingNames = Object.keys(profiles);

  const initialValues: ProfileWithName | undefined = useMemo(() => {
    if (profileName == null) {
      return undefined;
    }
    const entry = profiles[profileName];
    return entry ? { name: profileName, ...entry } : undefined;
  }, [profileName, profiles]);

  // Managed profiles AND invariant-flagged profiles open in view mode. The
  // daemon stamps `invariant` only on managed-source entries, so the two
  // checks normally coincide; keeping both is defensive. A user-owned
  // profile sharing a managed name carries neither marker and opens fully
  // editable — the daemon accepts every write to it.
  const mode =
    profileName == null
      ? "create"
      : initialValues?.source === "managed" || initialValues?.invariant === true
        ? "view"
        : "edit";

  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId } },
        data,
      );
      void queryClient.invalidateQueries({
        queryKey: inferenceProfilesGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
    },
  });

  async function handleEditorSave(
    name: string,
    entry: ProfilePatchEntry,
    options?: { mode?: "merge" | "replace" },
  ) {
    const saveMode = options?.mode ?? "replace";
    const isNew = !(name in profiles);

    // Merge mode (view-mode managed-profile re-enable): a single deep-merge
    // PATCH layers the partial entry on top of the existing record without
    // wiping seed-owned fields.
    if (saveMode === "merge" && !isNew) {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { llm: { profiles: { [name]: entry } } },
      });
      onClose();
      return;
    }

    const llmPatch: {
      profiles: Record<string, ProfilePatchEntry>;
      profileOrder?: string[];
    } = { profiles: { [name]: entry } };
    if (isNew) {
      llmPatch.profileOrder = profileOrder.includes(name)
        ? profileOrder
        : [...profileOrder, name];
    }

    // For edits: delete the existing profile fragment first so the new entry
    // is a clean replacement rather than a deep-merge. This lets the user
    // reset advanced params back to "inherit" — without this step, deep-merge
    // semantics would silently preserve old values for omitted keys.
    if (!isNew) {
      const oldEntry = profiles[name];
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { llm: { profiles: { [name]: null } } },
      });
      try {
        await configMutation.mutateAsync({
          path: { assistant_id: assistantId },
          body: { llm: llmPatch },
        });
      } catch (recreateErr) {
        captureError(recreateErr, {
          context: "settings-ai-profile-edit-recreate",
        });
        // Best-effort rollback: restore old entry so the profile isn't lost
        if (oldEntry != null) {
          await configMutation
            .mutateAsync({
              path: { assistant_id: assistantId },
              body: { llm: { profiles: { [name]: oldEntry } } },
            })
            .catch(() => {
              /* rollback failed — original error still propagates */
            });
        }
        throw recreateErr;
      }
    } else {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { llm: llmPatch },
      });
    }

    if (isNew) {
      toast.success(`Profile "${entry.label ?? name}" created`);
    }
    onClose();
  }

  const editor = useProfileEditor({
    mode,
    profileName: profileName ?? undefined,
    initialValues,
    existingNames,
    connections,
    assistantId,
    onSave: handleEditorSave,
  });

  const deleteFlow = useProfileDeleteFlow(assistantId, config, {
    onDeleted: () => onClose(),
  });

  // The open profile can vanish underneath the panel (deleted from a row
  // kebab, or removed on another device). Close rather than editing a ghost.
  // The edit save path transiently deletes the entry mid-cycle, so hold off
  // while a save is in flight.
  const profileMissing =
    profileName != null && config != null && !(profileName in profiles);
  useEffect(() => {
    if (profileMissing && !editor.saving && !configMutation.isPending) {
      onClose();
    }
  }, [profileMissing, editor.saving, configMutation.isPending, onClose]);

  const isManaged = mode === "view";
  const title =
    editor.effectiveMode === "create"
      ? "New Profile"
      : (initialValues?.label ?? profileName ?? "Profile");

  return (
    <>
      <DetailShell
        title={title}
        closeVariant="outlined"
        onClose={onClose}
        headerTrailing={
          isManaged && editor.effectiveMode !== "create" ? (
            <Tag tone="neutral">Managed by Vellum</Tag>
          ) : null
        }
        headerActions={
          editor.effectiveMode !== "create" && !editor.isReadOnly ? (
            <Button
              variant="outlined"
              size="compact"
              leftIcon={<Trash2 />}
              tintColor="var(--system-negative-strong)"
              onClick={() => {
                if (profileName != null) {
                  deleteFlow.requestDelete(profileName);
                }
              }}
              disabled={editor.saving}
            >
              Delete
            </Button>
          ) : null
        }
        footer={
          editor.isReadOnly ? (
            <div className="flex justify-end gap-2">
              <Button
                variant="outlined"
                onClick={editor.switchToSaveAsNew}
                disabled={editor.saving}
              >
                Save As New
              </Button>
              {editor.hasViewModeChanges ? (
                <Button
                  variant="primary"
                  onClick={() => void editor.handleSave()}
                  disabled={editor.saving}
                >
                  {editor.saving ? "Saving…" : "Save"}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex justify-end">
              <Button
                variant="primary"
                onClick={() => void editor.handleSave()}
                disabled={editor.isInvalid || editor.saving}
              >
                {editor.saving
                  ? "Saving…"
                  : editor.effectiveMode === "create"
                    ? "Create Profile"
                    : "Save Changes"}
              </Button>
            </div>
          )
        }
      >
        <ProfileEditorFields
          editor={editor}
          assistantId={assistantId}
          connections={connections}
          variant="panel"
        />
      </DetailShell>

      <BlockedDeleteModal {...deleteFlow.blockedDeleteModalProps} />
    </>
  );
}
