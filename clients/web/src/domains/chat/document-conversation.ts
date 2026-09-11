import {
  conversationsByIdGet,
  conversationsPost,
  documentsByIdConversationsPost,
} from "@/generated/daemon/sdk.gen";
import { t } from "@/i18n";
import {
  assistantScopedSupports,
  whenAssistantVersionKnownFor,
} from "@/lib/backwards-compat/utils";
import { MIN_VERSION } from "@/lib/backwards-compat/server-minted-conversation";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  getEditChatConversationId,
  setEditChatConversationId,
} from "@/utils/edit-chat-session";

export interface DocumentConversationRef {
  surfaceId: string;
  conversationId: string;
}

export function getDocumentFeedbackPrompt(title: string): string {
  return t("chat:documentConversation.feedbackPrompt", { title });
}

interface DocumentConversationOptions {
  assistantId: string;
  document: DocumentConversationRef;
  isCurrent: () => boolean;
}

/** A scope is invalid permanently after an assistant switch, including A-B-A. */
export function documentRequestScope(assistantId: string) {
  let current =
    useResolvedAssistantsStore.getState().activeAssistantId === assistantId;
  const unsubscribe = useResolvedAssistantsStore.subscribe((state) => {
    if (state.activeAssistantId !== assistantId) {
      current = false;
    }
  });
  return {
    isCurrent: () => current,
    dispose: () => {
      current = false;
      unsubscribe();
    },
  };
}

async function existingConversation(
  assistantId: string,
  id: string,
): Promise<string | null> {
  const result = await conversationsByIdGet({
    path: { assistant_id: assistantId, id },
    throwOnError: false,
  });
  if (result.response?.status === 404) {
    return null;
  }
  if (!result.response?.ok || !result.data?.conversation?.id) {
    throw new Error(t("chat:documentConversation.unavailable"));
  }
  return result.data.conversation.id;
}

async function linkDocumentConversation(
  { assistantId, document, isCurrent }: DocumentConversationOptions,
  conversationId: string,
) {
  if (!isCurrent()) {
    return null;
  }
  if (conversationId !== document.conversationId) {
    await documentsByIdConversationsPost({
      path: { assistant_id: assistantId, id: document.surfaceId },
      body: { conversationId },
      throwOnError: true,
    });
  }
  return isCurrent() ? conversationId : null;
}

/** Resolves an existing conversation only. Opening a document never creates one. */
export async function resolveDocumentConversation(
  options: DocumentConversationOptions,
): Promise<string | null> {
  const { assistantId, document, isCurrent } = options;
  const cached = getEditChatConversationId(assistantId, document.surfaceId);
  const candidates = [
    ...new Set(
      [document.conversationId, cached].filter((id): id is string =>
        Boolean(id),
      ),
    ),
  ];
  for (const candidate of candidates) {
    if (!isCurrent()) {
      return null;
    }
    const conversationId = await existingConversation(assistantId, candidate);
    if (!isCurrent()) {
      return null;
    }
    if (conversationId) {
      return linkDocumentConversation(options, conversationId);
    }
  }
  return null;
}

/** Explicit recovery action for a document whose linked conversation is gone. */
export async function startDocumentConversation(
  options: DocumentConversationOptions,
): Promise<string | null> {
  const { assistantId, document, isCurrent } = options;
  await whenAssistantVersionKnownFor(assistantId);
  if (!isCurrent()) {
    return null;
  }
  if (!assistantScopedSupports(MIN_VERSION, assistantId)) {
    throw new Error(t("chat:documentConversation.updateRequired"));
  }
  const resolved = await resolveDocumentConversation(options);
  if (resolved || !isCurrent()) {
    return resolved;
  }
  // The key also makes retry safe when creation succeeded but its response was lost.
  const conversationKey =
    getEditChatConversationId(assistantId, document.surfaceId) ||
    crypto.randomUUID();
  setEditChatConversationId(assistantId, document.surfaceId, conversationKey);
  const { data } = await conversationsPost({
    path: { assistant_id: assistantId },
    body: { conversationKey },
    throwOnError: true,
  });
  if (!isCurrent()) {
    return null;
  }
  setEditChatConversationId(assistantId, document.surfaceId, data.id);
  return linkDocumentConversation(options, data.id);
}
