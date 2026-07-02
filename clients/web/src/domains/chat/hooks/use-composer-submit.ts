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
 */

import { type FormEvent, type RefObject, useCallback, useEffect, useRef } from "react";

import {
  selectPathReferencePaths,
  selectUploadedIds,
  selectUploadingCount,
  useComposerStore,
} from "@/domains/chat/composer-store";
import { useQuoteReplyStore, type StagedQuote } from "@/domains/chat/quote-reply-store";
import { conversationsByIdUndoPost } from "@/generated/daemon/sdk.gen";
import { haptic } from "@/utils/haptics";
import { isPointerCoarse } from "@/utils/pointer";
import type { DisplayAttachment } from "@/domains/chat/types/types";

// ---------------------------------------------------------------------------
// Params & return type
// ---------------------------------------------------------------------------

export interface UseComposerSubmitParams {
  sendMessage: (content: string, attachments?: DisplayAttachment[]) => Promise<void>;
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
}

export interface ComposerSubmitResult {
  /** Send a message without requiring a FormEvent. */
  submitMessage: (inputOverride?: string) => Promise<void>;
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
}: UseComposerSubmitParams): ComposerSubmitResult {
  const shouldFocusInputRef = useRef(false);

  // --- Focus effect -------------------------------------------------------
  useEffect(() => {
    if (!typingDisabled && !sendDisabled && shouldFocusInputRef.current) {
      shouldFocusInputRef.current = false;
      inputRef.current?.focus();
    }
  }, [typingDisabled, sendDisabled, inputRef]);

  // --- Submit logic -------------------------------------------------------
  const submitMessage = useCallback(async (inputOverride?: string) => {
    const input = useComposerStore.getState().input;
    const chatAttachments = useComposerStore.getState().attachments;
    const uploadingCount = selectUploadingCount(chatAttachments);
    const uploadedIds = selectUploadedIds(chatAttachments);
    const pathReferences = selectPathReferencePaths(chatAttachments);

    const stagedQuotes = useQuoteReplyStore.getState().stagedQuotes;
    const trimmed = (inputOverride ?? input).trim();
    if (sendDisabled) return;
    if (
      !trimmed &&
      uploadedIds.length === 0 &&
      pathReferences.length === 0 &&
      stagedQuotes.length === 0
    ) {
      return;
    }
    if (uploadingCount > 0) return;

    const attachmentsToSend: DisplayAttachment[] = chatAttachments
      .filter(
        (att): att is Extract<typeof att, { kind: "uploaded" }> => att.kind === "uploaded",
      )
      .map((att) => ({
        id: att.id,
        filename: att.filename,
        mimeType: att.mimeType,
        sizeBytes: att.sizeBytes,
        previewUrl: att.previewUrl ?? null,
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

    if (!isPointerCoarse()) {
      shouldFocusInputRef.current = true;
    }
    haptic.medium();

    // Engage the auto-pin window so the new turn lands at the bottom.
    scrollToLatest({ behavior: "auto" });

    if (isEditing && editingMessageId && assistantId && activeConversationId && canUndoEdit) {
      cancelEditing();
      try {
        await conversationsByIdUndoPost({
          path: { assistant_id: assistantId, id: activeConversationId },
        });
      } catch {
        // If undo fails, still send the message as a new one
      }
    }
    const contentWithQuotes = buildContentWithQuotes(stagedQuotes, trimmed);
    const finalContent = appendPathReferences(contentWithQuotes, pathReferences);
    await sendMessage(finalContent, attachmentsToSend);
  }, [sendDisabled, activeConversationId, inputRef, scrollToLatest, isEditing, editingMessageId, assistantId, cancelEditing, canUndoEdit, sendMessage]);

  const handleFormSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    void submitMessage();
  }, [submitMessage]);

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
