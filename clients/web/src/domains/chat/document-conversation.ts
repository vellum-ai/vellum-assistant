import {
  conversationsByIdGet,
  conversationsPost,
  documentsByIdConversationsPost,
} from "@/generated/daemon/sdk.gen";
import { t } from "@/i18n";
import { subscribe } from "@/lib/event-bus";
import { SYNC_TAGS } from "@/lib/sync/types";
import type { DocumentContent } from "@/types/document-types";
import {
  assistantScopedSupports,
  whenAssistantVersionKnownFor,
} from "@/lib/backwards-compat/utils";
import { MIN_VERSION } from "@/lib/backwards-compat/server-minted-conversation";
import { resolveSupportsDocumentConversationLink } from "@/lib/backwards-compat/document-conversation-link";
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
    const supportsLink =
      await resolveSupportsDocumentConversationLink(assistantId);
    if (!isCurrent()) {
      return null;
    }
    if (supportsLink) {
      await documentsByIdConversationsPost({
        path: { assistant_id: assistantId, id: document.surfaceId },
        body: { conversationId },
        throwOnError: true,
      });
    }
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

/** Publishes a loaded document only after its link and observed writes settle. */
export async function loadDocumentConversation({
  assistantId,
  surfaceId,
  isCurrent,
  onReady,
}: {
  assistantId: string;
  surfaceId: string;
  isCurrent: () => boolean;
  onReady: (document: DocumentContent, conversationId: string | null) => void;
}): Promise<void> {
  let changed = false;
  const unsubscribe = subscribe("sse.event", ({ message }) => {
    if (
      isCurrent() &&
      ((message.type === "document_editor_update" &&
        message.surfaceId === surfaceId) ||
        (message.type === "sync_changed" &&
          message.tags.includes(SYNC_TAGS.documentsList)))
    ) {
      changed = true;
    }
  });
  try {
    const { loadDocumentContent } = await import("./api/document-load");
    while (isCurrent()) {
      changed = false;
      const document = await loadDocumentContent({
        assistantId,
        surfaceId,
        isCurrent,
      });
      if (!document || !isCurrent()) {
        return;
      }
      const conversationId = await resolveDocumentConversation({
        assistantId,
        document,
        isCurrent,
      });
      if (!isCurrent()) {
        return;
      }
      if (changed) {
        continue;
      }
      onReady(document, conversationId);
      return;
    }
  } finally {
    unsubscribe();
  }
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
