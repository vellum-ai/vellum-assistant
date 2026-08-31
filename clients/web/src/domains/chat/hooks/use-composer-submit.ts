/**
 * Composer submit logic — assembles attachments, clears draft state,
 * triggers haptic feedback, and sends the message.
 *
 * Exposes `submitMessage` (plain function) and `handleFormSubmit`
 * (FormEvent wrapper) so callers like `handleSelectStarter` don't need
 * to fabricate a fake `FormEvent`.
 *
 * Owns `shouldFocusInputRef` and the effect that focuses the input
 * after a successful send.
 *
 * Callers may pass an optional `beforeSend` gate that sees the assembled
 * outgoing content before anything is cleared; returning `false` cancels
 * the send losslessly (used by the composer secret guard).
 */

import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import {
  selectPathReferencePaths,
  selectUploadedIds,
  selectUploadingCount,
  useComposerStore,
} from "@/domains/chat/composer-store";
import { prependChannelReference } from "@/domains/chat/channel-sidecar/channel-reference";
import { useChannelReferenceStore } from "@/domains/chat/channel-sidecar/channel-reference-store";
import { isLocallyHandledCommand } from "@/domains/chat/components/chat-composer/slash-command-catalog";
import { uploadSightFrameAttachment } from "@/domains/chat/sight/sight-attachment";
import { isAsyncChatScopeCurrent } from "@/domains/chat/utils/conversation-scope";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  useQuoteReplyStore,
  type StagedQuote,
} from "@/domains/chat/quote-reply-store";
import { conversationsByIdUndoPost } from "@/generated/daemon/sdk.gen";
import { haptic } from "@/utils/haptics";
import { isPointerCoarse } from "@/utils/pointer";
import type { DisplayAttachment } from "@/domains/chat/types/types";

// ---------------------------------------------------------------------------
// Params & return type
// ---------------------------------------------------------------------------

export interface UseComposerSubmitParams {
  sendMessage: (
    content: string,
    attachments?: DisplayAttachment[],
    opts?: { bypassSecretCheck?: boolean },
  ) => Promise<void>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  scrollToLatest: (opts?: { behavior?: "auto" | "smooth" }) => void;
  isEditing: boolean;
  editingMessageId: string | null;
  cancelEditing: () => void;
  /** True only when the active conversation is proven native; gates the edit/undo path that would otherwise delete imported channel history. */
  canUndoEdit: boolean;
  sendDisabled: boolean;
  typingDisabled: boolean;
  assistantId: string | null;
  activeConversationId: string | null;
  /**
   * Pre-send gate, invoked with the fully assembled outgoing content
   * (quotes, a staged channel reference, and path references included)
   * before any composer state is cleared. Return `false` to block the send:
   * the draft, attachments, staged quotes, and the staged channel reference
   * are left fully intact. Omitted = always proceed.
   */
  beforeSend?: (content: string) => boolean;
  /**
   * Whether an image attached to this message would survive the turn: the same
   * gate the drop/pick path applies, resolved once by the caller and passed in
   * so the two cannot answer differently. False on an assistant older than the
   * image-fallback plugin whose active profile has no vision, where the
   * provider rejects the image and fails the whole turn.
   *
   * Only the Eyes frame consults it here; attachments the user picked were
   * already filtered on the way in. Defaults to true, which is what a caller
   * that attaches no images of its own means.
   */
  imageAttachmentsAllowed?: boolean;
}

export interface ComposerSubmitResult {
  /**
   * Send a message without requiring a FormEvent.
   *
   * `opts.bypassSecretCheck` forwards the daemon's single-use
   * secret-ingress override on this send's POST. It is reserved for the
   * composer secret guard's "Send anyway" handler — the only path where
   * the user has explicitly confirmed a blocked send — and must never be
   * set by any other caller. The `beforeSend` gate still runs first, so a
   * draft edited since the block is re-scanned and re-blocked before the
   * override could reach the wire.
   */
  submitMessage: (
    inputOverride?: string,
    opts?: { bypassSecretCheck?: boolean },
  ) => Promise<void>;
  /** FormEvent wrapper — calls `e.preventDefault()` then `submitMessage()`. */
  handleFormSubmit: (e: FormEvent) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useComposerSubmit({
  sendMessage,
  inputRef,
  scrollToLatest,
  isEditing,
  editingMessageId,
  cancelEditing,
  canUndoEdit,
  sendDisabled,
  typingDisabled,
  assistantId,
  activeConversationId,
  beforeSend,
  imageAttachmentsAllowed = true,
}: UseComposerSubmitParams): ComposerSubmitResult {
  const shouldFocusInputRef = useRef(false);
  /**
   * Tail of the delivery chain, so submits reach the send in the order they
   * were made. See where it is advanced in `submitMessage`.
   */
  const sendChainRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * The vision gate as it stands right now, not as it stood when the submit
   * began (the ref-backed fresh-closure pattern, as in `use-transcript-scroll`).
   *
   * A delivery can sit for as long as a capture and an upload take, and the
   * user is free to switch model profiles inside that window. Switching
   * re-renders the chat route, which recomputes the gate and re-renders this
   * hook, so the ref carries the newly resolved answer by the time any queued
   * delivery reaches its frame. Synced in a layout effect so it lands before
   * the browser paints the new profile rather than after.
   */
  const imageAttachmentsAllowedRef = useRef(imageAttachmentsAllowed);
  useLayoutEffect(() => {
    imageAttachmentsAllowedRef.current = imageAttachmentsAllowed;
  }, [imageAttachmentsAllowed]);

  // --- Focus effect -------------------------------------------------------
  useEffect(() => {
    if (!typingDisabled && !sendDisabled && shouldFocusInputRef.current) {
      shouldFocusInputRef.current = false;
      inputRef.current?.focus();
    }
  }, [typingDisabled, sendDisabled, inputRef]);

  // --- Submit logic -------------------------------------------------------
  const submitMessage = useCallback(
    async (inputOverride?: string, opts?: { bypassSecretCheck?: boolean }) => {
      const input = useComposerStore.getState().input;
      const chatAttachments = useComposerStore.getState().attachments;
      const uploadingCount = selectUploadingCount(chatAttachments);
      const uploadedIds = selectUploadedIds(chatAttachments);
      const pathReferences = selectPathReferencePaths(chatAttachments);

      const stagedQuotes = useQuoteReplyStore.getState().stagedQuotes;
      const channelReference = useChannelReferenceStore.getState().reference;
      const trimmed = (inputOverride ?? input).trim();
      if (sendDisabled) {
        return;
      }
      // A staged channel reference is content in its own right: "look at this
      // message" is a complete instruction, so it makes an otherwise empty
      // composer sendable exactly as a staged quote does.
      if (
        !trimmed &&
        uploadedIds.length === 0 &&
        pathReferences.length === 0 &&
        stagedQuotes.length === 0 &&
        channelReference === null
      ) {
        return;
      }
      if (uploadingCount > 0) {
        return;
      }

      // Assemble the outgoing content before touching any state so the gate
      // below can veto the send with the draft/attachments/quotes intact.
      const contentWithQuotes = buildContentWithQuotes(stagedQuotes, trimmed);
      // The channel reference leads the message: it is the thing being talked
      // about, and everything the user typed is their remark on it.
      const contentWithReference = prependChannelReference(
        contentWithQuotes,
        channelReference,
      );
      const finalContent = appendPathReferences(
        contentWithReference,
        pathReferences,
      );
      if (beforeSend && !beforeSend(finalContent)) {
        return;
      }

      const attachmentsToSend: DisplayAttachment[] = chatAttachments
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

      useComposerStore.getState().setInput("");
      if (activeConversationId) {
        useComposerStore.getState().clearDraft(activeConversationId);
      }
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }
      useComposerStore.getState().resetAttachments();
      useQuoteReplyStore.getState().clearStagedQuotes();
      useChannelReferenceStore.getState().clearReference();

      if (!isPointerCoarse()) {
        shouldFocusInputRef.current = true;
      }
      haptic.medium();

      // Engage the auto-pin window so the new turn lands at the bottom.
      scrollToLatest({ behavior: "auto" });

      if (
        isEditing &&
        editingMessageId &&
        assistantId &&
        activeConversationId &&
        canUndoEdit
      ) {
        cancelEditing();
        try {
          await conversationsByIdUndoPost({
            path: { assistant_id: assistantId, id: activeConversationId },
          });
        } catch {
          // If undo fails, still send the message as a new one
        }
      }
      // While the Eyes camera is up, the frame it is holding rides along as an
      // attachment so the assistant answers about what it can see. Best effort:
      // the helper swallows its own failures and a message with no frame still
      // goes.
      //
      // Not for a command the send resolves by itself. `/status` and its
      // siblings never become a chat message, so a frame captured for one is an
      // image uploaded and persisted for nothing, and the round trip is latency
      // a local command pays with no one waiting on an assistant. The frame is
      // left where it is rather than consumed, so the next real message still
      // carries it.
      //
      // Nor where an image would not survive the turn. The toggle is hidden in
      // that case, so this is the backstop for a profile switched under a
      // camera already running: attaching the frame anyway would fail the turn
      // on the provider's image rejection, which costs the user their message.
      // The gate belongs to this send's thread, not to the rendered route. The
      // live ref follows whatever conversation is open, so once the user
      // navigates away it answers for somebody else's profile: reading it then
      // could drop a frame this thread can carry, or attach one it cannot. The
      // send prefers the live answer while its own thread is on screen (a
      // profile switch there re-renders through the ref) and otherwise falls
      // back to the answer standing when the submit began, which is the last
      // one its thread gave.
      const gateAtSubmit = imageAttachmentsAllowedRef.current;
      const sightGateAllows = () =>
        assistantId !== null &&
        activeConversationId !== null &&
        isAsyncChatScopeCurrent({
          currentAssistantId:
            useResolvedAssistantsStore.getState().activeAssistantId,
          currentConversationId:
            useConversationStore.getState().activeConversationId,
          requestAssistantId: assistantId,
          requestConversationId: activeConversationId,
        })
          ? imageAttachmentsAllowedRef.current
          : gateAtSubmit;

      const deliver = async () => {
        if (sightGateAllows() && !isLocallyHandledCommand(finalContent)) {
          const sightAttachment = await uploadSightFrameAttachment(assistantId);
          // Asked again on the way out: the upload itself is a window, and a
          // profile switched to one without vision while the frame was in
          // flight must not have it attached. The uploaded blob is left
          // behind, like any failed send's.
          if (sightAttachment && sightGateAllows()) {
            attachmentsToSend.push(sightAttachment);
          }
        }

        // Forward the secret-check override only when this send explicitly
        // carries it (the Send-anyway path); ordinary sends never set it.
        await sendMessage(
          finalContent,
          attachmentsToSend,
          opts?.bypassSecretCheck === true
            ? { bypassSecretCheck: true }
            : undefined,
        );
      };

      // Deliveries run one after another, in the order they were submitted.
      //
      // The composer is cleared and re-enabled above, ahead of the frame upload
      // `deliver` runs, so a second message can be written and sent while the
      // first is still resolving its frame. Whichever upload finishes first
      // would otherwise reach the send first, and the send treats a message
      // arriving while a turn is starting as one to queue behind it: the two
      // land in the assistant's history the wrong way round.
      //
      // The link runs whether the previous one resolved or rejected, and the
      // chain is advanced with a continuation that cannot reject, so one failed
      // send does not wedge every send after it. An Eyes-off submit awaits an
      // already-resolved promise, which costs it a microtask.
      const link = sendChainRef.current.then(deliver, deliver);
      sendChainRef.current = link.then(
        () => {},
        () => {},
      );
      await link;
    },
    [
      sendDisabled,
      beforeSend,
      activeConversationId,
      inputRef,
      scrollToLatest,
      isEditing,
      editingMessageId,
      assistantId,
      cancelEditing,
      canUndoEdit,
      sendMessage,
    ],
  );

  const handleFormSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void submitMessage();
    },
    [submitMessage],
  );

  return { submitMessage, handleFormSubmit };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats staged quotes and the user's freeform text into a single message
 * string. Each quote is rendered as a markdown blockquote followed by the
 * user's reply. The ordering is:
 *   quote1 → reply1 → quote2 → reply2 → … → freeform text
 */
function buildContentWithQuotes(
  quotes: StagedQuote[],
  freeformText: string,
): string {
  const parts: string[] = [];
  for (const quote of quotes) {
    const blockquote = quote.quotedText
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    parts.push(`${blockquote}\n\n${quote.replyText}`);
  }
  if (freeformText) {
    parts.push(freeformText);
  }
  return parts.join("\n\n");
}

/**
 * Appends folder/file path references to the outgoing message so the assistant
 * receives them as text context. Paths render inline as code so the assistant
 * can lift them verbatim without whitespace or Markdown surprises.
 */
function appendPathReferences(content: string, paths: string[]): string {
  if (paths.length === 0) {
    return content;
  }
  const label = paths.length === 1 ? "Path" : "Paths";
  const lines = paths.map((path) => `- \`${path}\``).join("\n");
  const block = `${label}:\n${lines}`;
  return content ? `${content}\n\n${block}` : block;
}
