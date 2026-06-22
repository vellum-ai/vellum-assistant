import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { RenameConversationDialog } from "@/domains/chat/components/rename-conversation-dialog";
import { useRenameRequestStore } from "@/domains/chat/rename-request-store";
import { conversationsByIdNamePatch } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { patchConversation } from "@/utils/conversation-cache";

/**
 * Store-driven rename dialog. Reads the pending rename request from
 * `useRenameRequestStore`, shows the dialog, and handles optimistic
 * rename + rollback on failure. Extracted as its own component so the
 * optimistic-update logic is colocated with the UI rather than threaded
 * through the parent orchestrator's dependency tree.
 */
export function RenameDialogFromStore({ assistantId }: { assistantId: string | null }) {
  const renameRequest = useRenameRequestStore.use.renameRequest();
  const clearRename = useRenameRequestStore.use.clearRename();
  const queryClient = useQueryClient();

  const handleSubmit = useCallback(
    async (newTitle: string) => {
      if (!renameRequest || !assistantId) return;
      const { conversationId, currentTitle } = renameRequest;
      clearRename();

      const trimmed = newTitle.trim();
      if (!trimmed || trimmed === currentTitle) return;

      patchConversation(queryClient, assistantId, conversationId, {
        title: trimmed,
      });

      try {
        await conversationsByIdNamePatch({
          path: { assistant_id: assistantId, id: conversationId },
          body: { name: trimmed },
          throwOnError: true,
        });
      } catch (err) {
        patchConversation(queryClient, assistantId, conversationId, {
          title: currentTitle,
        });
        captureError(err, { context: "renameConversation" });
      }
    },
    [assistantId, queryClient, renameRequest, clearRename],
  );

  return (
    <RenameConversationDialog
      open={renameRequest !== null}
      currentTitle={renameRequest?.currentTitle ?? ""}
      onSubmit={handleSubmit}
      onCancel={clearRename}
    />
  );
}
