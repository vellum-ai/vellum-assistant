import { Trash2 } from "lucide-react";
import { useEffect, useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { DetailShell } from "@/components/detail-shell";
import { BlockedDeleteModal } from "@/domains/settings/ai/manage-profiles-blocked-delete-modal";
import { ProfileEditorFields } from "@/domains/settings/ai/profile-editor-fields";
import { useProfileDeleteFlow } from "@/domains/settings/ai/use-profile-delete-flow";
import { useProfileEditor } from "@/domains/settings/ai/use-profile-editor";
import { useProfileSave } from "@/domains/settings/ai/use-profile-save";
import type { ProfileWithName } from "@/domains/settings/ai/utils";
import {
  configGetOptions,
  inferenceProviderconnectionsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";

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
 * Hosts must remount the panel per selection (key by `profileName`) - the
 * editor snapshots its initial values on mount. For the same reason the
 * panel must only be mounted once the config query has data: the opening
 * affordances (ProfilesSection rows and its Create button) are gated on
 * config presence, so a mount never snapshots a blank profile.
 */
export function ProfileDetailPanel({
  assistantId,
  profileName,
  onClose,
}: ProfileDetailPanelProps) {
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
  // editable - the daemon accepts every write to it.
  const mode =
    profileName == null
      ? "create"
      : initialValues?.source === "managed" || initialValues?.invariant === true
        ? "view"
        : "edit";

  const { saveProfile, isPending: savePending } = useProfileSave(assistantId, {
    onSaved: onClose,
  });

  const editor = useProfileEditor({
    mode,
    profileName: profileName ?? undefined,
    initialValues,
    existingNames,
    connections,
    assistantId,
    onSave: saveProfile,
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
    if (profileMissing && !editor.saving && !savePending) {
      onClose();
    }
  }, [profileMissing, editor.saving, savePending, onClose]);

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
