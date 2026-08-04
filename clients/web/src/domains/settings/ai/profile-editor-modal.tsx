import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Tag } from "@vellumai/design-library/components/tag";

import { ProfileEditorFields } from "@/domains/settings/ai/profile-editor-fields";
import type { ProfileWithName } from "@/domains/settings/ai/utils";
import {
  useProfileEditor,
  type ProfileEditorMode,
} from "@/domains/settings/ai/use-profile-editor";
import type {
  ProfilePatchEntry,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

export interface ProfileEditorModalProps {
  isOpen: boolean;
  mode: ProfileEditorMode;
  profileName?: string;
  initialValues?: ProfileWithName;
  existingNames: string[];
  /**
   * Provider connections, supplied by the host. Used to render the
   * per-provider Connection sub-dropdown and filter the Provider picker to
   * providers with at least one connection.
   *
   * `undefined` vs `[]` is meaningful:
   * - `undefined` → caller has not yet loaded connections. The Provider
   *   picker falls back to the full catalog so the trigger isn't empty
   *   during that gap.
   * - `[]` → caller fetched and got zero connections. The Provider filter
   *   runs and yields empty, the empty-state hint fires, and the user is
   *   steered to Providers instead of picking a provider the daemon can't
   *   dispatch through.
   */
  connections?: ProviderConnection[];
  /**
   * Assistant whose provider connections the inline "+ Create new provider"
   * sub-form writes to. Required for the create-mode quick-add flow.
   */
  assistantId: string;
  /** See `UseProfileEditorArgs.onSave` for the merge/replace contract. */
  onSave: (
    name: string,
    entry: ProfilePatchEntry,
    options?: { mode?: "merge" | "replace" },
  ) => Promise<void>;
  onCancel: () => void;
}

/**
 * Modal host for the profile editor (the composer quick-add flow, and any
 * host that wants the editor in a dialog). The editor's state/persistence
 * lives in `useProfileEditor`; the settings page hosts the same editor in
 * the sidepanel via `ProfileDetailPanel`.
 */
export function ProfileEditorModal({
  isOpen,
  mode,
  profileName,
  initialValues,
  existingNames,
  connections,
  assistantId,
  onSave,
  onCancel,
}: ProfileEditorModalProps) {
  return (
    <Modal.Root
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
    >
      {isOpen ? (
        <ProfileEditorModalInner
          mode={mode}
          profileName={profileName}
          initialValues={initialValues}
          existingNames={existingNames}
          connections={connections}
          assistantId={assistantId}
          onSave={onSave}
          onCancel={onCancel}
        />
      ) : null}
    </Modal.Root>
  );
}

type ProfileEditorModalInnerProps = Omit<ProfileEditorModalProps, "isOpen">;

function ProfileEditorModalInner({
  mode,
  profileName,
  initialValues,
  existingNames,
  connections,
  assistantId,
  onSave,
  onCancel,
}: ProfileEditorModalInnerProps) {
  const editor = useProfileEditor({
    mode,
    profileName,
    initialValues,
    existingNames,
    connections,
    assistantId,
    onSave,
  });

  const modalTitle =
    editor.effectiveMode === "create"
      ? "New Profile"
      : editor.effectiveMode === "edit"
        ? "Edit Profile"
        : (initialValues?.label ?? profileName ?? "Profile");

  return (
    <Modal.Content size="md">
      <Modal.Header>
        {editor.effectiveMode === "view" ? (
          <div className="flex items-center gap-2">
            <Modal.Title>{modalTitle}</Modal.Title>
            <Tag tone="positive">Platform</Tag>
          </div>
        ) : (
          <Modal.Title>{modalTitle}</Modal.Title>
        )}
      </Modal.Header>

      <Modal.Body>
        <ProfileEditorFields
          editor={editor}
          assistantId={assistantId}
          connections={connections}
          variant="modal"
        />
      </Modal.Body>

      <Modal.Footer>
        {/* `isReadOnly` (not `effectiveMode === "view"`) picks the footer so
            an invariant profile opened in edit mode still gets the safe
            footer: Close, Save As New, and a Save gated by
            `hasViewModeChanges` that only ever takes the merge path. */}
        {editor.isReadOnly ? (
          <>
            <Button
              variant="outlined"
              className="touch-mobile:h-10"
              onClick={onCancel}
              disabled={editor.saving}
              data-testid="modal-cancel-btn"
            >
              Close
            </Button>
            <Button
              variant="outlined"
              className="touch-mobile:h-10"
              onClick={editor.switchToSaveAsNew}
              disabled={editor.saving}
            >
              Save As New
            </Button>
            {/* Save in view mode persists ONLY the status re-enable. The
                button is gated by `hasViewModeChanges` so an unchanged view
                session can't round-trip a no-op write. */}
            <Button
              variant="primary"
              className="touch-mobile:h-10"
              onClick={() => void editor.handleSave()}
              disabled={!editor.hasViewModeChanges || editor.saving}
              data-testid="modal-save-btn"
            >
              {editor.saving ? "Saving…" : "Save"}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outlined"
              className="touch-mobile:h-10"
              onClick={onCancel}
              disabled={editor.saving}
              data-testid="modal-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              className="touch-mobile:h-10"
              onClick={() => void editor.handleSave()}
              disabled={editor.isInvalid || editor.saving}
              data-testid="modal-save-btn"
            >
              {editor.saving ? "Saving…" : "Save"}
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal.Content>
  );
}
