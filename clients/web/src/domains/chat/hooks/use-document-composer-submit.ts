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
 * reply that arrives afterward. This hook only lists the send as awaiting a
 * reply, via `document-composer-reply-store.ts`; the always-mounted
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
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { resolveEditChatDraftConversationId } from "@/utils/edit-chat-session";
import { supportsServerMintedConversation } from "@/lib/backwards-compat/server-minted-conversation";
import { pickConversationIdWireField } from "@/lib/backwards-compat/conversation-id-wire-field";
import { whenAssistantVersionKnownFor } from "@/lib/backwards-compat/utils";
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

/** How long the inline "Sent" micro-state stays up before fading, mirroring
 *  the autosave "saved" pattern in `document-viewer-container.tsx`. */
const SENT_STATUS_MS = 1500;

/**
 * A send that has listed itself among a conversation's pending sends: the
 * nonce it carries, the payload that nonce is valid for, the conversation it
 * went toward, and whether its POST is still out.
 */
interface DocumentComposerAttempt {
  clientMessageId: string;
  snapshot: string;
  targetConversationId: string;
  inFlight: boolean;
}

/**
 * Take `attempt`'s entry off the pending list, and the conversation's
 * processing mark with it when nothing else is pending there. Nothing can
 * settle an entry the daemon never spoke for once no attempt can retry it,
 * and its mark would stand until an assistant switch. An acknowledged entry
 * stays, because its reply is still coming.
 */
function abandonAttempt(
  attempt: Pick<
    DocumentComposerAttempt,
    "clientMessageId" | "targetConversationId"
  >,
): void {
  const dropped = useDocumentComposerReplyStore
    .getState()
    .dropUnacknowledgedReply(
      attempt.targetConversationId,
      attempt.clientMessageId,
    );
  if (
    dropped &&
    !useDocumentComposerReplyStore
      .getState()
      .pendingReplies.has(attempt.targetConversationId)
  ) {
    useConversationStore
      .getState()
      .removeProcessingConversationId(attempt.targetConversationId);
  }
}

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

  // Who the `"document"` slot belongs to right now, and the idempotency nonce
  // of the attempt in flight. A send reads both as it resolves, by which point
  // the hook may point at another document or another assistant. Ownership is
  // a count rather than the (assistant, surface) pair it stands for, because
  // every transition drops the draft and hands the slot to a fresh one: an A
  // to B to A round trip leaves a different owner in place even though the
  // pair matches the one an earlier send captured. The nonce survives a thrown
  // send so the retry carries the same id, which lets the daemon dedupe the
  // case where it accepted the message and only the response was lost. The
  // nonce is tied to the exact content/attachment snapshot it was minted for:
  // a retry only reuses it when the payload is unchanged, since the daemon
  // dedupes on `(conversation, clientMessageId)` back to the ORIGINAL payload,
  // and reusing it against an edited draft would have the daemon answer the
  // old message while the hook cleared the new edits. The nonce also carries
  // the conversation the message went toward, so a retry the daemon dedupes
  // does not list itself a second time for a turn that may already be over.
  // Which pending send is this message's is not mirrored here at all: the
  // reply store lists every send under the nonce it went out with, and an
  // attempt only takes down the entry carrying its own.
  const surfaceId = doc?.surfaceId ?? null;
  const ownerGenerationRef = useRef(0);
  const currentAssistantIdRef = useRef(assistantId);
  const pendingClientMessageRef = useRef<DocumentComposerAttempt | null>(null);
  useEffect(() => {
    currentAssistantIdRef.current = assistantId;
    ownerGenerationRef.current += 1;
    // The composer on screen belongs to the incoming owner and has sent
    // nothing, so it starts enabled instead of inheriting the outgoing
    // attempt's "sending".
    setStatus("idle");
    // The outgoing owner takes its draft with it, and an unmounted hook has no
    // draft at all, so the next send is a different message with a nonce of
    // its own. An entry an earlier attempt listed stays listed while its POST
    // is out, or once the daemon has taken the message in; one the daemon
    // never took in and no attempt can retry comes off.
    return () => {
      const previous = pendingClientMessageRef.current;
      if (previous && !previous.inFlight) {
        abandonAttempt(previous);
      }
      pendingClientMessageRef.current = null;
    };
  }, [assistantId, surfaceId]);

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
    const ownerGeneration = ownerGenerationRef.current;
    // Every gate that frames the send reads the version of whichever
    // assistant is active when it runs (`supportsServerMintedConversation`
    // here, `pickConversationIdWireField` inside `postChatMessage`), so an
    // attempt that outlives a switch to another assistant would be framed
    // against the wrong one. Switching also clears the draft, hands the
    // shared slot to the incoming assistant, and resets this attempt's
    // nonce, so an attempt that finds the assistant changed has nothing left
    // to send, or to say on a composer that is not the one it started on.
    const assistantChanged = () =>
      currentAssistantIdRef.current !== assistantId;
    const ownsSlotNow = () => ownerGenerationRef.current === ownerGeneration;

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

    // This attempt's own handle, set once it lists itself before the POST.
    // The ref may have been nulled or replaced by then, so a throw reads the
    // attempt it has to answer for from here.
    let attempt: DocumentComposerAttempt | null = null;

    setStatus("sending");
    try {
      // Both gates below read `false` while the identity store has no version
      // yet, and the legacy branch that answers then sends a client-minted id
      // the daemon has never seen. Waiting for a resolved version keeps a cold
      // start from framing the send that way. Scoped to `assistantId`, so a
      // switch in progress waits for the incoming assistant's identity rather
      // than settling for the outgoing one's.
      await whenAssistantVersionKnownFor(assistantId);
      if (assistantChanged()) {
        return;
      }
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
      // Unscoped, matching the read `postChatMessage` makes when it picks its
      // own wire field: the two have to agree on one version, and that read
      // has no owner to scope to.
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

      // `requireLink` decided whether a row was minted for this send, and
      // `postChatMessage` picks its own wire field off the same store the
      // moment it runs. Both reads are synchronous against one snapshot, so
      // this is the one point that can guarantee the POST goes out under the
      // frame the row was minted (or not minted) under. Only a version that
      // flips after the bounded wait above reaches here, and a clean failure
      // beats a strict lookup of an id the daemon never minted.
      const expectedWireField = requireLink
        ? "conversationId"
        : "conversationKey";
      if (pickConversationIdWireField() !== expectedWireField) {
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
      const sameMessage =
        pendingClientMessageRef.current?.snapshot === payloadSnapshot &&
        pendingClientMessageRef.current.clientMessageId
          ? pendingClientMessageRef.current
          : null;
      const clientMessageId = sameMessage
        ? sameMessage.clientMessageId
        : crypto.randomUUID();
      // A retry of a message that already went toward this conversation rides
      // whatever entry that earlier attempt listed, even one the watcher has
      // since settled: the daemon dedupes the retry back to the message it
      // already holds, so a second entry would stand for a turn that is over
      // and the next unrelated completion would fire the reply toast.
      const retryOfSameTarget =
        sameMessage?.targetConversationId === targetConversationId;
      // The attempt whose nonce is replaced here threw, and the fresh nonce
      // is the only handle a retry could have carried back to it.
      if (pendingClientMessageRef.current && !sameMessage) {
        abandonAttempt(pendingClientMessageRef.current);
      }
      attempt = {
        clientMessageId,
        snapshot: payloadSnapshot,
        targetConversationId,
        inFlight: true,
      };
      pendingClientMessageRef.current = attempt;

      /** Give the nonce back, unless the slot has moved on to another one. */
      const releaseClientMessageId = () => {
        if (
          ownsSlotNow() &&
          pendingClientMessageRef.current?.clientMessageId === clientMessageId
        ) {
          pendingClientMessageRef.current = null;
        }
      };

      // List this send among `conversationId`'s pending sends, under the nonce
      // it is carrying, so the watcher can tell stream events that echo it
      // apart from events about any other message in the conversation. A send
      // lists itself unacknowledged: nothing settles it until the daemon has
      // taken it in on the stream or answered the POST.
      const raiseReplyWait = (conversationId: string) => {
        useDocumentComposerReplyStore
          .getState()
          .startAwaitingReply(conversationId, clientMessageId);
      };
      // Whether one of `conversationId`'s pending sends is this message's:
      // listed under its nonce, by this attempt or an earlier one. Every other
      // entry there is another message's, and not this attempt's to take down.
      const ownsReplyWait = (conversationId: string) => {
        const pending = useDocumentComposerReplyStore
          .getState()
          .pendingReplies.get(conversationId);
        return (
          pending?.some((p) => p.clientMessageId === clientMessageId) ?? false
        );
      };

      // Raised before the POST, not off its response. The daemon dedupes a
      // retry on `(conversation, clientMessageId)` and answers a duplicate
      // exactly as it answers a fresh accept, so raising off the response
      // would put up a wait for a turn that already finished and the next
      // unrelated completion would fire the reply toast.
      if (!retryOfSameTarget) {
        raiseReplyWait(targetConversationId);
      }
      // The sidebar's processing mark goes up with the wait, for the same
      // reason: the daemon can broadcast `message_queued`, run the turn ahead
      // of it and finish this message before the POST answers, and the
      // watcher takes this mark down with the wait it ends. Raised off the
      // response instead, it would go up after the watcher had already tried
      // to remove it and stand until an unrelated reconciliation. It goes up
      // only while this message still has an entry to take it down with: a
      // retry of a message the watcher has already settled is deduped by the
      // daemon without another terminal, so a mark raised for it would stand
      // the same way.
      if (ownsReplyWait(targetConversationId)) {
        useConversationStore
          .getState()
          .addProcessingConversationId(targetConversationId, snapshot);
      }

      const result = await postChatMessage(
        assistantId,
        targetConversationId,
        content,
        { attachmentIds, clientMessageId },
      );

      if (!result.ok) {
        // The daemon answered and refused the message: nothing is persisted
        // and no turn will run, so this attempt's entry comes off the list and
        // the next attempt goes out as a fresh send rather than a duplicate
        // the daemon would dedupe against nothing. Only the entry carrying
        // this nonce goes, and it goes even on a composer the slot has moved
        // past, since a refused message can never be replied to.
        useDocumentComposerReplyStore
          .getState()
          .stopAwaitingReply(targetConversationId, clientMessageId);
        // The mark stands for every send still running in the conversation, so
        // it comes down only once this one was the last pending there.
        if (
          !useDocumentComposerReplyStore
            .getState()
            .pendingReplies.has(targetConversationId)
        ) {
          useConversationStore
            .getState()
            .removeProcessingConversationId(targetConversationId);
        }
        releaseClientMessageId();
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
      releaseClientMessageId();

      const conversationId = result.conversationId;
      // A reply wait and a processing mark both watch the assistant's own SSE
      // connection, which a switch to another assistant replaced: moving
      // either onto the row the daemon answered with would leave it on a
      // connection nothing is listening to. A move to another document moves
      // both, since the reply toast is meant to outlive closing the document.
      const sameAssistant = !assistantChanged();
      // The assistant is the source of truth for the id: a legacy
      // `conversationKey` send for a fresh draft comes back with the row the
      // daemon minted rather than the key that went out, so the wait moves
      // onto it, under the same nonce. An id that did not move leaves the wait
      // raised before the POST exactly as it stands, the watcher's to end.
      if (sameAssistant && conversationId !== targetConversationId) {
        // The mark follows the wait onto the answered row, and only while
        // something is still pending on the row it went up for: a conversation
        // the watcher has emptied took the mark down with it, and a turn that
        // is over must not come back as processing under another id.
        const waiting = useDocumentComposerReplyStore
          .getState()
          .pendingReplies.has(targetConversationId);
        if (ownsReplyWait(targetConversationId)) {
          useDocumentComposerReplyStore
            .getState()
            .stopAwaitingReply(targetConversationId, clientMessageId);
        }
        raiseReplyWait(conversationId);
        if (waiting) {
          useConversationStore
            .getState()
            .transferProcessingConversationId(
              targetConversationId,
              conversationId,
            );
        }
      }
      if (sameAssistant) {
        // The stream is what acknowledges a send and says whether it runs or
        // waits, ordered against the terminals it has to outrank. The
        // response reaches the client on its own schedule, possibly after the
        // stream has already moved the send along, so it acknowledges only a
        // send the stream has not spoken for, and says queued or running as
        // the daemon answered. It addresses the row the daemon answered with,
        // where the entry lives once the id has moved. A switch to another
        // assistant dropped every entry, so there is nothing left there to
        // acknowledge.
        useDocumentComposerReplyStore
          .getState()
          .acknowledgeReply(
            conversationId,
            clientMessageId,
            result.queued === true,
          );
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
      // reason, and a send that no longer owns the slot leaves `status`
      // untouched rather than reporting idle: the owner may have a send of
      // its own in flight, and idle would re-enable its composer mid-send.
      const ownsSlot = isMountedRef.current && ownsSlotNow();
      if (ownsSlot) {
        useComposerStore.getState().setInput("", "document");
        // Nothing renders a sent bubble for this slot, so its preview blob
        // URLs have no reader once the message is away: the full reset clears
        // the slot and revokes exactly the URLs it created, leaving the main
        // slot's alive.
        useComposerStore.getState().fullReset("document");
        setStatus("sent");
      }
      toast.info(t("documentComposer.messageSentToast"), {
        action: {
          label: t("documentComposer.viewConversation"),
          onClick: () => {
            // The row belongs to the assistant this send went out under, and
            // the toast outlives a switch away from it. Selecting the
            // conversation under another assistant would point the chat at a
            // row that assistant has never seen, so the action goes quiet
            // instead.
            const activeAssistantId =
              useResolvedAssistantsStore.getState().activeAssistantId;
            if (activeAssistantId !== assistantId) {
              return;
            }
            navigateToConversation(navigate, conversationId);
          },
        },
      });
    } catch {
      // Ambiguous, unlike an answered rejection: the daemon may have accepted
      // the message and only the response was lost. The nonce and the entry
      // both stay put while a retry is possible, so the retry is a duplicate
      // the daemon can dedupe and the reply it may already be generating
      // still raises the toast. An attempt the slot has moved past, or that
      // outlived the hook, cannot be retried, so its entry goes unless the
      // daemon has taken the message in.
      if (attempt) {
        attempt.inFlight = false;
        if (!(isMountedRef.current && ownsSlotNow())) {
          abandonAttempt(attempt);
        }
      }
      if (ownsSlotNow()) {
        setStatus("error");
      }
      toast.error(t("documentComposer.sendFailed"));
    }
  }, [assistantId, doc, navigate, queryClient, t]);

  return { status, submit };
}
