import { useCallback } from "react";

import { NameInputDialog } from "@/domains/chat/components/name-input-dialog";
import { useGroupNameRequestStore } from "@/domains/chat/group-name-request-store";
import { useSupportsGroupIcons } from "@/lib/backwards-compat/use-supports-group-icons";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";

/**
 * Store-driven group-name dialog. Reads the pending create/rename request from
 * {@link useGroupNameRequestStore} and drives one {@link NameInputDialog} for
 * both. On a "create" submit it creates the group and moves the requesting
 * conversation into it; on "rename" it renames. Extracted so the
 * create-then-move / rename wiring lives with the dialog rather than being
 * threaded through the parent orchestrator's dependency tree.
 *
 * The icon picker renders only when the active assistant persists group
 * icons ({@link useSupportsGroupIcons}); against an older assistant the
 * dialog stays name-only and no `icon` field is written.
 */
interface GroupNameDialogFromStoreProps {
  createGroup: (
    name: string,
    icon?: string | null,
  ) => Promise<ConversationGroup | null>;
  renameGroup: (groupId: string, name: string, icon?: string | null) => void;
  moveToGroup: (conversation: Conversation, groupId: string) => void;
}

export function GroupNameDialogFromStore({
  createGroup,
  renameGroup,
  moveToGroup,
}: GroupNameDialogFromStoreProps) {
  const request = useGroupNameRequestStore.use.groupNameRequest();
  const clear = useGroupNameRequestStore.use.clearGroupNameRequest();
  const supportsGroupIcons = useSupportsGroupIcons();

  const handleSubmit = useCallback(
    async (name: string, icon?: string | null) => {
      if (!request) {
        return;
      }
      clear();
      if (request.mode === "create") {
        const group = await createGroup(name, icon);
        if (group) {
          moveToGroup(request.conversation, group.id);
        }
      } else {
        renameGroup(request.groupId, name, icon);
      }
    },
    [request, clear, createGroup, renameGroup, moveToGroup],
  );

  const isRename = request?.mode === "rename";
  const currentName = request?.mode === "rename" ? request.currentName : "";
  const currentIcon = request?.mode === "rename" ? request.currentIcon : null;

  return (
    <NameInputDialog
      open={request !== null}
      title={isRename ? "Rename group" : "New group"}
      submitLabel={isRename ? "Save" : "Create"}
      initialValue={currentName}
      iconPicker={supportsGroupIcons ? { initialIcon: currentIcon } : undefined}
      onSubmit={handleSubmit}
      onCancel={clear}
    />
  );
}
