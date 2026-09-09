/**
 * Submit logic for the composer pinned to a document editor
 * (`MobileDocumentOverlay`, and on mobile, the standalone document route).
 * Mirrors the shape of `useComposerSubmit`: assemble content/attachments,
 * clear draft state, send. Scoped to the `"document"` composer-store slot and
 * a fixed target conversation instead of whatever conversation is globally
 * "active".
 *
 * Deliberately thinner than `useComposerSubmit` + `useSendMessage`: this
 * surface has no transcript to reconcile against, so there is no optimistic
 * message row, no turn-store phase flip, and no SSE stream to fold, just a
 * POST and a local status the caller renders. A fresh draft mints its
 * conversation first, so the document is already linked to it when the
 * daemon assembles the first turn's context.
 *
 * Also raises the inline "Sent" toast with a "View conversation" action on
 * send. The follow-up "Assistant replied" toast is not owned here: this hook
 * lives inside `DocumentComposerPanel`, which unmounts when the host closes
 * the document (`MobileDocumentOverlay` returning `null`, or navigating off
 * the standalone document route), so a subscription kept here would drop a
 * reply that arrives afterward. This hook only records the conversation to
 * watch, via `document-composer-reply-store.ts`; the always-mounted
 * `DocumentComposerReplyWatcher` (in `RootLayout`) owns the subscription and
 * raises the toast.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellumai/design-library/components/toast";

import { postChatMessage } from "@/domains/chat/api/messages";
import { conversationsPost } from "@/generated/daemon/sdk.gen";
import {
  selectUploadedIds,
  selectUploadingCount,
  useComposerStore,
} from "@/domains/chat/composer-store";
import { useDocumentComposerReplyStore } from "@/domains/chat/document-composer-reply-store";
import {
  linkDocumentConversationIfNeeded,
  markOpenedDocumentLinked,
  persistDocumentConversationId,
  resolveDocumentConversationId,
  type DocumentConversationRef,
} from "@/domains/chat/utils/document-conversation";
import { resolvePostError } from "@/domains/chat/utils/send-message-utils";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { findConversation } from "@/utils/conversation-cache";
import { useConversationStore } from "@/stores/conversation-store";
import { resolveEditChatDraftConversationId } from "@/utils/edit-chat-session";
import { supportsServerMintedConversation } from "@/lib/backwards-compat/server-minted-conversation";
import { useTranslation } from "@/i18n";

export type DocumentComposerSendStatus = "idle" | "sending" | "sent" | "error";

export interface UseDocumentComposerSubmitParams {
  assistantId: string | null;
  doc: DocumentConversationRef | null;
}

export interface DocumentComposerSubmitResult {
  /** Drives the composer's disabled state and the inline "Sent" micro-state. */
  status: DocumentComposerSendStatus;
  /** Sends whatever is currently in the `"document"` composer slot. */
  submit: () => Promise<void>;
}

/**
 * Who the shared `"document"` composer slot belongs to. Both halves matter:
 * the draft is dropped when the open document changes and when the active
 * assistant does, so a send only owns the slot it left behind if neither has
 * moved since.
 */
interface DocumentSlotOwner {
  assistantId: string | null;
  surfaceId: string | null;
}

/** How long the inline "Sent" micro-state stays up before fading, mirroring
 *  the autosave "saved" pattern in `document-viewer-container.tsx`. */
const SENT_STATUS_MS = 1500;

export function useDocumentComposerSubmit({
  assistantId,
  doc,
}: UseDocumentComposerSubmitParams): DocumentComposerSubmitResult {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<DocumentComposerSendStatus>("idle");

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Who the `"document"` slot belongs to right now, and the state of the
  // attempt in flight: its idempotency nonce, and the conversation it already
  // put on the reply watcher's list. A send reads all three as it resolves,
  // by which point the hook may point at another document or another
  // assistant. The nonce survives a thrown send so the retry carries the same
  // id, which lets the daemon dedupe the case where it accepted the message
  // and only the response was lost. The nonce is tied to the exact
  // content/attachment snapshot it was minted for: a retry only reuses it when
  // the payload is unchanged, since the daemon dedupes on
  // `(conversation, clientMessageId)` back to the ORIGINAL payload, and
  // reusing it against an edited draft would have the daemon answer the old
  // message while the hook cleared the new edits.
  const surfaceId = doc?.surfaceId ?? null;
  const currentOwnerRef = useRef<DocumentSlotOwner>({ assistantId, surfaceId });
  const pendingClientMessageRef = useRef<{
    clientMessageId: string;
    snapshot: string;
  } | null>(null);
  const armedReplyConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    currentOwnerRef.current = { assistantId, surfaceId };
    // The draft is cleared when either half of the owner changes, so the next
    // send is a different message: its own nonce, its own wait. A wait an
    // earlier attempt armed stays up, since that message may still be on its
    // way to a reply.
    pendingClientMessageRef.current = null;
    armedReplyConversationIdRef.current = null;
    // The composer on screen belongs to the incoming owner and has sent
    // nothing, so it starts enabled instead of inheriting the outgoing
    // attempt's "sending".
    setStatus("idle");
  }, [assistantId, surfaceId]);

  /** Take back down the wait this attempt raised, if it raised one. */
  const disarmReplyWaiter = useCallback(() => {
    const armed = armedReplyConversationIdRef.current;
    if (armed === null) {
      return;
    }
    useDocumentComposerReplyStore.getState().stopAwaitingReply(armed);
    armedReplyConversationIdRef.current = null;
  }, []);

  // Put `conversationId` on the reply watcher's list for the attempt in
  // flight, moving the wait when that attempt turns out to target a different
  // conversation. The wait carries the nonce the attempt is sending under, so
  // the watcher can tell stream events that echo it apart from events about
  // any other message in the conversation. A retry that resolves the same
  // conversation rides the wait the first attempt raised instead of raising a
  // second one, and a conversation already being waited on keeps the wait it
  // has: the list is a set, so an earlier send's entry covers this one too and
  // is not this attempt's to take back down.
  const armReplyWaiter = useCallback(
    (conversationId: string, clientMessageId: string) => {
      if (armedReplyConversationIdRef.current === conversationId) {
        return;
      }
      disarmReplyWaiter();
      const replyStore = useDocumentComposerReplyStore.getState();
      if (replyStore.awaitingReplyConversationIds.has(conversationId)) {
        return;
      }
      replyStore.startAwaitingReply(conversationId, clientMessageId);
      armedReplyConversationIdRef.current = conversationId;
    },
    [disarmReplyWaiter],
  );

  // Auto-fade the "Sent" micro-state.
  useEffect(() => {
    if (status !== "sent") {
      return;
    }
    const id = setTimeout(() => setStatus("idle"), SENT_STATUS_MS);
    return () => clearTimeout(id);
  }, [status]);

  const submit = useCallback(async () => {
    if (!assistantId || !doc) {
      return;
    }
    const owner: DocumentSlotOwner = { assistantId, surfaceId: doc.surfaceId };
    // Every gate that frames the send reads the version of whichever
    // assistant is active when it runs (`supportsServerMintedConversation`
    // here, `pickConversationIdWireField` inside `postChatMessage`), so an
    // attempt that outlives a switch to another assistant would be framed
    // against the wrong one. Switching also clears the draft, hands the
    // shared slot to the incoming assistant, and resets this attempt's nonce
    // and wait, so an attempt that finds the assistant changed has nothing
    // left to send, to take back down, or to say on a composer that is not
    // the one it started on.
    const assistantChanged = () =>
      currentOwnerRef.current.assistantId !== owner.assistantId;
    const ownsSlotNow = () =>
      !assistantChanged() &&
      currentOwnerRef.current.surfaceId === owner.surfaceId;

    const { documentInput, documentAttachments } = useComposerStore.getState();
    const content = documentInput.trim();
    const attachmentIds = selectUploadedIds(documentAttachments);
    // Mirrors `useComposerSubmit`'s empty-content guard (minus staged
    // quotes/channel reference, which have no equivalent on this surface: see
    // `chat-composer.tsx`'s `slot === "main"` gate on those two stores).
    if (!content && attachmentIds.length === 0) {
      return;
    }
    if (selectUploadingCount(documentAttachments) > 0) {
      return;
    }

    setStatus("sending");
    try {
      const resolvedId = resolveDocumentConversationId(doc, assistantId);
      // A fresh client-minted id (never sent to the server) can't be sent as
      // a strict-lookup `conversationId` on assistants >= 0.8.6, which 404s
      // on an id it has never minted, so those assistants mint the row for
      // this send instead. A reused cached id is not fresh (it was already
      // resolved, and either sent successfully before or is the document's
      // own id), so it always takes the direct path regardless of assistant
      // support.
      const isFreshDraft =
        useConversationStore.getState().draftConversationIds.has(resolvedId);
      // Read before the first await, so both gates below are framed against
      // the assistant this attempt started under.
      const requireLink = supportsServerMintedConversation();
      const useServerMint = isFreshDraft && requireLink;

      // The daemon starts the turn inside the send and prompt assembly reads
      // the document's conversation link, so the row is minted and linked
      // before the message goes out. Letting the send mint the row instead
      // would run the first turn without the document or its comments.
      let targetConversationId = resolvedId;
      if (useServerMint) {
        const minted = await conversationsPost({
          path: { assistant_id: assistantId },
          // No key, so the daemon mints the id; no title, so the auto-titler
          // still names the conversation once messages arrive.
          body: {},
          throwOnError: true,
        });
        targetConversationId = minted.data.id;
        // The session cache answers "which row to reuse" and a document's
        // `conversationId` answers "which row it is linked to", so the minted
        // id goes into the cache whether or not the link below lands: a retry
        // reuses this row instead of minting a second one, and still has to
        // link it before anything goes out.
        persistDocumentConversationId(doc, assistantId, targetConversationId);
        if (targetConversationId !== resolvedId) {
          resolveEditChatDraftConversationId(resolvedId, targetConversationId);
        }
      }
      if (assistantChanged()) {
        return;
      }

      // On the mint path `doc` still carries the id the document was opened
      // against rather than the minted one, so this is a real request.
      const linked = await linkDocumentConversationIfNeeded(
        doc,
        assistantId,
        targetConversationId,
      );
      // Nothing has gone out yet, and no await stands between here and the
      // POST, so this is the last point the send can still be dropped whole.
      // It comes ahead of the writes the link leads to because those are
      // keyed by surface id alone: the incoming assistant can have the same
      // document open, and pointing it at this send's conversation would hand
      // the next send a row belonging to the assistant the user left.
      if (assistantChanged()) {
        return;
      }
      if (linked) {
        // The mint left the draft id behind for a row under another id, so
        // the mark comes off only once the document is linked to that row and
        // nothing resolves the draft any more. While the link is missing the
        // mark is what makes `resolveDocumentConversationId` hand a document
        // still open against the draft the minted row instead.
        if (useServerMint) {
          useConversationStore.getState().clearDraftConversationId(resolvedId);
        }
        // The document open in the viewer may be this one, still on a draft
        // id: with the link in place it can carry the id a later submit
        // resolves (see `resolveDocumentConversationId`'s fallback order).
        markOpenedDocumentLinked(doc.surfaceId, targetConversationId);
      }
      if (requireLink && !linked) {
        // An assistant that mints conversations also has the link route, so a
        // failure there is the daemon refusing rather than a route that isn't
        // there: sending now would run the turn without the document. The
        // rule holds for every attempt, not just the one that minted, since a
        // retry resolves the cached row and is no longer a fresh draft. On an
        // assistant without minting the route may not exist at all, so the
        // link stays best-effort and the send goes out either way.
        if (ownsSlotNow()) {
          setStatus("error");
        }
        toast.error(t("documentComposer.sendFailed"));
        return;
      }

      // The current `latestAssistantMessageAt` snapshot, seeded the same way
      // `use-send-message.ts` seeds it: without a snapshot, the graduation
      // sweep that clears the sidebar's processing indicator would compare a
      // real timestamp against `undefined` and graduate the key on its very
      // next pass, before the assistant has actually replied. `undefined` for
      // a conversation the client doesn't know about yet (a fresh draft),
      // same as the main send path.
      const snapshot = findConversation(queryClient, assistantId, resolvedId)
        ?.latestAssistantMessageAt;

      // The nonce is only valid for the exact payload it was minted for. If an
      // earlier attempt failed ambiguously (the daemon may have accepted the
      // message and only the response was lost), the user may have edited the
      // draft since; reusing the old id would have the daemon dedupe the retry
      // back to the ORIGINAL payload and this send resolve as the old message,
      // silently discarding the edits. So a retry only carries the id when the
      // content/attachment snapshot is unchanged, minting a fresh one (and thus
      // sending the new payload) whenever the draft moved on. Attachment ids
      // are stable upload-row ids, so the snapshot is exact for that set.
      const payloadSnapshot = `${content}\u0000${attachmentIds.join("\u0000")}`;
      let clientMessageId: string;
      if (
        pendingClientMessageRef.current?.snapshot === payloadSnapshot &&
        pendingClientMessageRef.current.clientMessageId
      ) {
        clientMessageId = pendingClientMessageRef.current.clientMessageId;
      } else {
        clientMessageId = crypto.randomUUID();
      }
      pendingClientMessageRef.current = {
        clientMessageId,
        snapshot: payloadSnapshot,
      };

      // Armed before the POST, not off its response. The daemon dedupes a
      // retry on `(conversation, clientMessageId)` and answers a duplicate
      // exactly as it answers a fresh accept, so arming off the response
      // would raise a wait for a turn that already finished and the next
      // unrelated completion would fire the reply toast.
      armReplyWaiter(targetConversationId, clientMessageId);
      // The sidebar's processing mark goes up with the wait, for the same
      // reason: the daemon can broadcast `message_queued`, run the turn ahead
      // of it and finish this message before the POST answers, and the
      // watcher takes this mark down with the wait it ends. Raised off the
      // response instead, it would go up after the watcher had already tried
      // to remove it and stand until an unrelated reconciliation.
      useConversationStore
        .getState()
        .addProcessingConversationId(targetConversationId, snapshot);

      const result = await postChatMessage(
        assistantId,
        targetConversationId,
        content,
        { attachmentIds, clientMessageId },
      );

      if (!result.ok) {
        // The daemon answered and refused the message: nothing is persisted
        // and no turn will run, so the wait this attempt raised and the mark
        // that went up with it both come back down, and the next attempt goes
        // out as a fresh send rather than a duplicate the daemon would dedupe
        // against nothing.
        disarmReplyWaiter();
        useConversationStore
          .getState()
          .removeProcessingConversationId(targetConversationId);
        pendingClientMessageRef.current = null;
        if (ownsSlotNow()) {
          setStatus("error");
        }
        toast.error(
          resolvePostError(
            result.error.code,
            result.error.detail,
            t("documentComposer.sendFailed"),
          ),
        );
        return;
      }

      // The daemon holds the message, queued or not, so the nonce has done
      // its job and the next send is a new message.
      pendingClientMessageRef.current = null;

      const conversationId = result.conversationId;
      // A reply wait and a processing mark both watch the assistant's own SSE
      // connection, which a switch to another assistant replaced: moving
      // either onto the row the daemon answered with would leave it on a
      // connection nothing is listening to. A move to another document moves
      // both, since the reply toast is meant to outlive closing the document.
      const sameAssistant = !assistantChanged();
      if (sameAssistant) {
        if (conversationId !== targetConversationId) {
          // The mark follows the wait onto the answered row, and only while
          // that wait is still up: one the watcher has already ended took the
          // mark down with it, and a turn that is over must not come back as
          // processing under another id.
          const waiting = useDocumentComposerReplyStore
            .getState()
            .awaitingReplyConversationIds.has(targetConversationId);
          if (waiting) {
            useConversationStore
              .getState()
              .transferProcessingConversationId(
                targetConversationId,
                conversationId,
              );
          }
        }
        // The assistant is the source of truth for the id: a legacy
        // `conversationKey` send for a fresh draft comes back with the row
        // the daemon minted rather than the key that went out, so the wait
        // moves onto it, under the same nonce. Whether the daemon parked this
        // message behind a turn already running is not read off this response:
        // the watcher learns that from the `message_queued` stream event,
        // which arrives in order against the terminal events it has to
        // outrank.
        armReplyWaiter(conversationId, clientMessageId);
        // The watcher owns the wait from here; the next send arms its own.
        armedReplyConversationIdRef.current = null;
      }

      if (isFreshDraft && !useServerMint) {
        // The legacy conversationKey create-or-lookup materialized the row, so
        // the client-side draft mark no longer applies.
        useConversationStore.getState().clearDraftConversationId(resolvedId);
      }
      persistDocumentConversationId(doc, assistantId, conversationId);

      // Only the document and assistant this send started under own the
      // shared `"document"` slot. Switching either one mid-flight, on any
      // host, hands the slot to the next draft, and a late completion
      // clearing it would wipe text the user typed for a message this send
      // never carried. "Sent" is that composer's micro-state for the same
      // reason: on anyone else's composer this send is over without a trace.
      const ownsSlot = isMountedRef.current && ownsSlotNow();
      if (ownsSlot) {
        useComposerStore.getState().setInput("", "document");
        useComposerStore.getState().resetAttachments("document");
      }
      setStatus(ownsSlot ? "sent" : "idle");
      toast.info(t("documentComposer.messageSentToast"), {
        action: {
          label: t("documentComposer.viewConversation"),
          onClick: () => navigateToConversation(navigate, conversationId),
        },
      });
    } catch {
      // Ambiguous, unlike an answered rejection: the daemon may have accepted
      // the message and only the response was lost. The nonce and the armed
      // wait both stay put, so the retry is a duplicate the daemon can dedupe
      // and the reply it may already be generating still raises the toast.
      if (ownsSlotNow()) {
        setStatus("error");
      }
      toast.error(t("documentComposer.sendFailed"));
    }
  }, [
    armReplyWaiter,
    assistantId,
    disarmReplyWaiter,
    doc,
    navigate,
    queryClient,
    t,
  ]);

  return { status, submit };
}
