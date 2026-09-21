/**
 * "New Document" from the Library. A document is owned by a conversation, so
 * this starts a conversation for it first: that conversation is where the
 * assistant works on the document with the user. The conversation is given
 * back if the document cannot be created, so a failure leaves no empty row
 * in the sidebar.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { toast } from "@vellumai/design-library";

import { useCreateDocument } from "@/hooks/use-create-document";
import { useTranslation } from "@/i18n";
import {
  createBackgroundConversation,
  discardBackgroundConversation,
} from "@/lib/background-conversation";
import { captureError } from "@/lib/sentry/capture-error";
import { invalidateConversationQueries } from "@/utils/conversation-cache";

export function useNewLibraryDocument(
  assistantId: string,
  onCreated: (surfaceId: string) => void,
): { newDocument: () => Promise<void>; isCreating: boolean } {
  const { t } = useTranslation("library");
  const queryClient = useQueryClient();
  const { createDocument } = useCreateDocument();
  const [isCreating, setIsCreating] = useState(false);
  // Each click mints a conversation and a document, so a click that lands
  // before the button disables is dropped rather than creating a second pair.
  const inFlight = useRef(false);

  const newDocument = useCallback(async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
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
      // The conversation's `conversations:list` broadcast skips the client
      // that created it, so this client refreshes its own sidebar.
      void invalidateConversationQueries(queryClient, assistantId);
      onCreated(surfaceId);
    } finally {
      inFlight.current = false;
      setIsCreating(false);
    }
  }, [assistantId, createDocument, onCreated, queryClient, t]);

  return { newDocument, isCreating };
}
