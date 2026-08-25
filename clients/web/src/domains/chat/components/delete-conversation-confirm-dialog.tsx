import { useCallback, useEffect, useState } from "react";

import { useTranslation } from "@/i18n";

import type { Conversation } from "@/types/conversation-types";
import { ConfirmDialog } from "@vellumai/design-library";

/**
 * Confirmation gate for the per-conversation Delete action. One click
 * must never permanently remove a conversation; the menu item requests
 * via {@link useDeleteConversationConfirmation} and the delete only
 * runs on the dialog's explicit confirm.
 *
 * Hosted by the chat layout next to the other sidebar dialogs rather
 * than inside the sidebar itself: the mobile overlay drawer unmounts
 * its subtree when it closes, and a pending confirmation must survive
 * that.
 */

interface UseDeleteConversationConfirmationParams {
  assistantId: string | null;
  /** Performs the delete once the user confirms. */
  deleteConversation: (conversation: Conversation) => void;
}

/**
 * Owns the pending delete request. `requestDelete` snapshots the row at
 * menu-click time so the conversation the user confirms is the one
 * deleted; `confirmDelete` runs the delete and clears the request.
 */
export function useDeleteConversationConfirmation({
  assistantId,
  deleteConversation,
}: UseDeleteConversationConfirmationParams) {
  const [pending, setPending] = useState<Conversation | null>(null);

  // A pending request holds a conversation from the assistant it was armed
  // against; confirming it after a switch would delete across a mismatched
  // assistant. Same rule as the archive-all confirmation gate.
  useEffect(() => {
    setPending(null);
  }, [assistantId]);

  const requestDelete = useCallback((conversation: Conversation) => {
    setPending(conversation);
  }, []);

  const confirmDelete = useCallback(() => {
    if (pending) {
      deleteConversation(pending);
    }
    setPending(null);
  }, [pending, deleteConversation]);

  const cancelDelete = useCallback(() => {
    setPending(null);
  }, []);

  return { pending, requestDelete, confirmDelete, cancelDelete };
}

export interface DeleteConversationConfirmDialogProps {
  pending: Conversation | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConversationConfirmDialog({
  pending,
  onConfirm,
  onCancel,
}: DeleteConversationConfirmDialogProps) {
  const { t } = useTranslation("chat");
  const title =
    pending?.title?.trim() || t("deleteConversationConfirmDialog.untitled");
  return (
    <ConfirmDialog
      open={pending !== null}
      title={t("deleteConversationConfirmDialog.title")}
      message={
        pending
          ? t("deleteConversationConfirmDialog.message", { title })
          : ""
      }
      confirmLabel={t("deleteConversationConfirmDialog.confirm")}
      cancelLabel={t("deleteConversationConfirmDialog.cancel")}
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
