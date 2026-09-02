import { useEffect, useRef } from "react";
import * as Sentry from "@sentry/react";

import { requestComposerFocus } from "@/domains/chat/composer-focus";
import {
  type ChatAttachment,
  useComposerStore,
} from "@/domains/chat/composer-store";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import type { DisplayAttachment } from "@/types/attachment-types";

/**
 * How long a parked share-inbox send may wait for its target to resolve
 * before it degrades to a pre-fill. Matches the thread-send park's bound.
 */
export const PENDING_SHARE_SEND_TTL_MS = 60_000;

export interface UseShareInboxSendOptions {
  assistantId: string | null;
  isAssistantActive: boolean;
  activeConversationId: string | null;
  conversationExistsOnServer: boolean;
  sendMessage: (
    content: string,
    attachments?: DisplayAttachment[],
  ) => Promise<void>;
}

interface InFlightShare {
  threadId: string;
  isNewDraft: boolean;
  text: string;
  /** Composer `localId`s this share queued. Existing strip items stay out. */
  ownedLocalIds: string[];
}

function ownedAttachments(
  attachments: ChatAttachment[],
  ownedLocalIds: string[],
): ChatAttachment[] {
  if (ownedLocalIds.length === 0) {
    return [];
  }
  const owned = new Set(ownedLocalIds);
  return attachments.filter((att) => owned.has(att.localId));
}

function removeOwnedAttachments(ownedLocalIds: string[]): void {
  const composer = useComposerStore.getState();
  for (const localId of ownedLocalIds) {
    composer.removeAttachment(localId);
  }
}

/**
 * Chat-domain half of `deeplink.share`: fulfils the send
 * `useGlobalDeepLinkConsumer` parked once the user has landed in the
 * target conversation.
 *
 * Files are queued through `addFiles` so they take the same upload,
 * resize, and vision-gate path as a dropped attachment. The send waits
 * until every *owned* upload finishes, then sends and removes only
 * those items, so a share into the conversation already on screen
 * leaves the user's existing strip alone. A failed owned upload
 * demotes to a composer pre-fill (owned files already in the strip)
 * rather than sending a partial set. Empty text with files is a valid
 * send.
 *
 * Existing threads use the same confirmation as `useDeepLinkThreadSend`:
 * a stale picker id must not mint a new conversation. A share aimed at a
 * fresh draft skips that check because the draft was minted for this
 * send.
 */
export function useShareInboxSend({
  assistantId,
  isAssistantActive,
  activeConversationId,
  conversationExistsOnServer,
  sendMessage,
}: UseShareInboxSendOptions): void {
  const pending = usePendingDeepLinkStore.use.pendingShareSend();
  const attachments = useComposerStore.use.attachments();
  const inFlightRef = useRef<InFlightShare | null>(null);
  const {
    conversations,
    isPending: listPending,
    isError: listErrored,
  } = useConversationListQuery(assistantId, isAssistantActive);

  useEffect(() => {
    const store = usePendingDeepLinkStore.getState();
    const breadcrumb = (outcome: string) => {
      Sentry.addBreadcrumb({
        category: "deeplink",
        level: "info",
        message: `shareInbox ${outcome}`,
      });
    };

    const inFlight = inFlightRef.current;
    if (inFlight !== null) {
      if (activeConversationId !== inFlight.threadId) {
        removeOwnedAttachments(inFlight.ownedLocalIds);
        if (inFlight.text.length > 0) {
          useComposerStore.getState().saveDraft(inFlight.threadId, inFlight.text);
        }
        inFlightRef.current = null;
        breadcrumb("saved as the target thread's draft: user navigated away");
        return;
      }
      const owned = ownedAttachments(attachments, inFlight.ownedLocalIds);
      if (owned.some((att) => att.kind === "uploading")) {
        return;
      }
      if (owned.some((att) => att.kind === "failed")) {
        inFlightRef.current = null;
        if (inFlight.text.length > 0) {
          store.setPendingComposerMessage(inFlight.text);
        }
        requestComposerFocus();
        breadcrumb("demoted to pre-fill: attachment upload failed");
        return;
      }
      const toSend: DisplayAttachment[] = owned
        .filter(
          (att): att is Extract<typeof att, { kind: "uploaded" }> =>
            att.kind === "uploaded",
        )
        .map((att) => ({
          id: att.id,
          filename: att.filename,
          mimeType: att.mimeType,
          sizeBytes: att.sizeBytes,
          previewUrl: att.previewUrl ?? null,
          thumbnailUrl: att.thumbnailUrl ?? null,
        }));
      inFlightRef.current = null;
      removeOwnedAttachments(inFlight.ownedLocalIds);
      void sendMessage(inFlight.text, toSend);
      breadcrumb("sent");
      return;
    }

    if (pending === null || activeConversationId === null) {
      return;
    }

    if (activeConversationId !== pending.threadId) {
      const parked = store.consumePendingShareSend();
      if (parked !== null && parked.text.length > 0) {
        useComposerStore.getState().saveDraft(parked.threadId, parked.text);
        breadcrumb("saved as the target thread's draft: user navigated away");
      }
      return;
    }

    const demote = (reason: string) => {
      const parked = store.consumePendingShareSend();
      if (parked === null) {
        return;
      }
      breadcrumb(`demoted to pre-fill: ${reason}`);
      if (parked.text.length > 0) {
        store.setPendingComposerMessage(parked.text);
      }
      if (parked.files.length > 0 && assistantId) {
        useComposerStore.getState().addFiles(parked.files, assistantId);
      }
      requestComposerFocus();
    };

    if (Date.now() - pending.parkedAt > PENDING_SHARE_SEND_TTL_MS) {
      demote("park expired");
      return;
    }

    if (!pending.isNewDraft && !conversationExistsOnServer) {
      const listLoaded = !listPending && !listErrored;
      if (
        listLoaded &&
        !conversations.some((c) => c.conversationId === pending.threadId)
      ) {
        demote("target absent from the loaded conversation list");
      }
      return;
    }

    if (pending.files.length > 0 && !assistantId) {
      return;
    }

    const parked = store.consumePendingShareSend();
    if (parked === null) {
      return;
    }
    const beforeIds = new Set(
      useComposerStore.getState().attachments.map((att) => att.localId),
    );
    if (parked.files.length > 0 && assistantId) {
      useComposerStore.getState().addFiles(parked.files, assistantId);
    }
    const ownedLocalIds = useComposerStore
      .getState()
      .attachments.filter((att) => !beforeIds.has(att.localId))
      .map((att) => att.localId);
    inFlightRef.current = {
      threadId: parked.threadId,
      isNewDraft: parked.isNewDraft,
      text: parked.text,
      ownedLocalIds,
    };
  }, [
    pending,
    attachments,
    activeConversationId,
    conversationExistsOnServer,
    conversations,
    listPending,
    listErrored,
    assistantId,
    sendMessage,
  ]);
}
