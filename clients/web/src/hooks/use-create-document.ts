/**
 * Creates a blank document owned by a conversation. Every "New document"
 * entry point goes through this so they share one request and one cache
 * refresh.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  documentsCreatePostMutation,
  documentsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { DocumentsCreatePostResponse } from "@/generated/daemon/types.gen";

export interface CreateDocumentArgs {
  assistantId: string;
  conversationId: string;
}

export function useCreateDocument(): {
  createDocument: (
    args: CreateDocumentArgs,
  ) => Promise<DocumentsCreatePostResponse>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    ...documentsCreatePostMutation(),
    onSuccess: (_data, variables) => {
      // The create's `documents:list` broadcast skips the client that sent
      // it, so this client refreshes its own lists. The key prefix matches
      // the Library's list and every per-conversation list alike.
      void queryClient.invalidateQueries({
        queryKey: documentsGetQueryKey({ path: variables.path }),
      });
    },
  });
  return {
    createDocument: ({ assistantId, conversationId }) =>
      mutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { conversationId },
      }),
    isPending: mutation.isPending,
  };
}
