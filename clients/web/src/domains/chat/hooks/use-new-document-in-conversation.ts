/**
 * "New document" from a conversation: creates a blank document owned by the
 * conversation and opens it the way a document card in the transcript opens,
 * so the user and the assistant start writing in it together.
 */

import { useCallback } from "react";
import { toast } from "@vellumai/design-library/components/toast";

import { useCreateDocument } from "@/hooks/use-create-document";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";

import { useOpenDocumentFromChat } from "./use-open-app-from-chat";

export function useNewDocumentInConversation(
  assistantId: string | null,
): (conversationId: string) => Promise<void> {
  const { createDocument } = useCreateDocument();
  const openDocument = useOpenDocumentFromChat(assistantId ?? undefined);
  const { t } = useTranslation("chat");

  return useCallback(
    async (conversationId) => {
      if (!assistantId) {
        return;
      }
      let surfaceId: string;
      try {
        ({ surfaceId } = await createDocument({ assistantId, conversationId }));
      } catch (error) {
        captureError(error, { context: "new_document_in_conversation" });
        toast.error(t("conversationActions.newDocumentFailed"));
        return;
      }
      await openDocument(surfaceId);
    },
    [assistantId, createDocument, openDocument, t],
  );
}
