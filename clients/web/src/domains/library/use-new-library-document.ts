/**
 * "New Document" from the Library. A document is owned by a conversation, so
 * this starts a conversation for it first: that conversation is where the
 * assistant works on the document with the user. The conversation is given
 * back if the document cannot be created, so a failure leaves no empty row
 * in the sidebar.
 */

import { useCallback, useState } from "react";
import { toast } from "@vellumai/design-library";

import { useCreateDocument } from "@/hooks/use-create-document";
import { useTranslation } from "@/i18n";
import {
  createBackgroundConversation,
  discardBackgroundConversation,
} from "@/lib/background-conversation";
import { captureError } from "@/lib/sentry/capture-error";

export function useNewLibraryDocument(
  assistantId: string,
  onCreated: (surfaceId: string) => void,
): { newDocument: () => Promise<void>; isCreating: boolean } {
  const { t } = useTranslation("library");
  const { createDocument } = useCreateDocument();
  const [isCreating, setIsCreating] = useState(false);

  const newDocument = useCallback(async () => {
    setIsCreating(true);
    try {
      const conversation = await createBackgroundConversation({
        assistantId,
        fallback: t("libraryView.newDocumentFailed"),
      });
      if (!conversation.ok) {
        toast.error(conversation.error);
        return;
      }
      let surfaceId: string;
      try {
        ({ surfaceId } = await createDocument({
          assistantId,
          conversationId: conversation.conversationId,
        }));
      } catch (error) {
        captureError(error, { context: "new_library_document" });
        void discardBackgroundConversation(
          assistantId,
          conversation.conversationId,
        );
        toast.error(t("libraryView.newDocumentFailed"));
        return;
      }
      onCreated(surfaceId);
    } finally {
      setIsCreating(false);
    }
  }, [assistantId, createDocument, onCreated, t]);

  return { newDocument, isCreating };
}
