import { useCallback, useEffect, useState } from "react";

import { useTranslation } from "@/i18n";

import type { Conversation } from "@/types/conversation-types";
import { ConfirmDialog } from "@vellumai/design-library";

/**
 * Confirmation gate for the sidebar's section-header "Archive All…" action:
 * one click must never clear a whole section from the active view
 * (LUM-3036). The menu item requests via {@link useArchiveAllConfirmation};
 * the archive only runs on the dialog's explicit confirm.
 *
 * Hosted by the chat layout next to the other sidebar dialogs
 * (`RenameDialogFromStore`, `GroupNameDialogFromStore`) rather than inside
 * the sidebar itself: the mobile overlay drawer unmounts its subtree when
 * it closes, and a pending confirmation must survive that.
 */

export interface PendingArchiveAll {
  groupName: string;
  conversations: Conversation[];
}

interface UseArchiveAllConfirmationParams {
  assistantId: string | null;
  /** Performs the archive once the user confirms. */
  archiveAllInGroup: (
    groupName: string,
    conversations: Conversation[],
  ) => void | Promise<void>;
}

/**
 * Owns the pending "Archive All" request. `requestArchiveAll` snapshots the
 * section's conversation set at menu-click time, so the set the user
 * confirms is the set archived; `confirmArchiveAll` runs the archive and
 * clears the request.
 */
export function useArchiveAllConfirmation({
  assistantId,
  archiveAllInGroup,
}: UseArchiveAllConfirmationParams) {
  const [pending, setPending] = useState<PendingArchiveAll | null>(null);

  // A pending request holds conversations from the assistant it was armed
  // against; confirming it after a switch would archive across a mismatched
  // assistant. Same rule as the group-name request store's clear-on-switch.
  useEffect(() => {
    setPending(null);
  }, [assistantId]);

  const requestArchiveAll = useCallback(
    (groupName: string, conversations: Conversation[]) => {
      setPending({ groupName, conversations });
    },
    [],
  );

  const confirmArchiveAll = useCallback(() => {
    if (pending) {
      void archiveAllInGroup(pending.groupName, pending.conversations);
    }
    setPending(null);
  }, [pending, archiveAllInGroup]);

  const cancelArchiveAll = useCallback(() => {
    setPending(null);
  }, []);

  return { pending, requestArchiveAll, confirmArchiveAll, cancelArchiveAll };
}

export interface ArchiveAllConfirmDialogProps {
  pending: PendingArchiveAll | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ArchiveAllConfirmDialog({
  pending,
  onConfirm,
  onCancel,
}: ArchiveAllConfirmDialogProps) {
  const { t } = useTranslation("chat");
  const count = pending?.conversations.length ?? 0;
  return (
    <ConfirmDialog
      open={pending !== null}
      title={t("archiveAllConfirmDialog.title")}
      message={
        pending
          ? t("archiveAllConfirmDialog.message", {
              count,
              groupName: pending.groupName,
            })
          : ""
      }
      confirmLabel={t("archiveAllConfirmDialog.confirm")}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
