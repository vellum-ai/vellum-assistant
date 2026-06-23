/**
 * Overlay bubble that appears after the user clicks "Quote & Reply" on a
 * text selection. Displays the quoted passage and a text input for the
 * user's reply, with two actions:
 *
 * - **Add to Chat** — stages the quote+reply for inclusion in the next
 *   message the user sends from the composer.
 * - **Send Now** — immediately sends only the quote+reply as a new message.
 */

import { MessageSquareQuote, Send, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import { Button } from "@vellumai/design-library";

interface QuoteReplyBubbleProps {
  onSendNow: (quotedText: string, replyText: string) => void;
}

export function QuoteReplyBubble({ onSendNow }: QuoteReplyBubbleProps) {
  const replyBubble = useQuoteReplyStore.use.replyBubble();
  const closeReplyBubble = useQuoteReplyStore.use.closeReplyBubble();
  const addStagedQuote = useQuoteReplyStore.use.addStagedQuote();

  const [replyText, setReplyText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  // Reset reply text when the bubble opens with new content.
  useEffect(() => {
    if (replyBubble) {
      setReplyText("");
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [replyBubble]);

  // Dismiss on click outside the bubble.
  useEffect(() => {
    if (!replyBubble) {
      return;
    }

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && bubbleRef.current && !bubbleRef.current.contains(target)) {
        closeReplyBubble();
      }
    };

    // Dismiss on Escape.
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        closeReplyBubble();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [replyBubble, closeReplyBubble]);

  const handleAddToChat = useCallback(() => {
    if (!replyBubble || !replyText.trim()) {
      return;
    }
    addStagedQuote({
      quotedText: replyBubble.quotedText,
      replyText: replyText.trim(),
      sourceMessageId: replyBubble.sourceMessageId,
    });
  }, [replyBubble, replyText, addStagedQuote]);

  const handleSendNow = useCallback(() => {
    if (!replyBubble || !replyText.trim()) {
      return;
    }
    onSendNow(replyBubble.quotedText, replyText.trim());
    closeReplyBubble();
  }, [replyBubble, replyText, onSendNow, closeReplyBubble]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleAddToChat();
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSendNow();
      }
    },
    [handleAddToChat, handleSendNow],
  );

  if (!replyBubble) {
    return null;
  }

  const truncatedQuote =
    replyBubble.quotedText.length > 200
      ? `${replyBubble.quotedText.slice(0, 200)}…`
      : replyBubble.quotedText;

  return (
    <div
      ref={bubbleRef}
      className="fixed z-50 w-[360px] -translate-x-1/2 animate-in fade-in zoom-in-95 duration-150"
      style={{
        top: replyBubble.anchorRect.top - 8,
        left: replyBubble.anchorRect.left,
        transform: "translate(-50%, -100%)",
      }}
    >
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-base)] p-3 shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)]">
            <MessageSquareQuote className="h-3.5 w-3.5" />
            <span>Quote &amp; Reply</span>
          </div>
          <button
            type="button"
            onClick={closeReplyBubble}
            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-default)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Quoted text */}
        <div className="rounded-lg border-l-2 border-[var(--border-active)] bg-[var(--surface-lift)] px-3 py-2 text-body-small-default text-[var(--content-secondary)]">
          {truncatedQuote}
        </div>

        {/* Reply input */}
        <textarea
          ref={textareaRef}
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your reply…"
          rows={2}
          className="w-full resize-none rounded-lg border border-[var(--border-default)] bg-[var(--surface-base)] px-3 py-2 text-body-small-default text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] focus:border-[var(--border-active)] focus:outline-none"
        />

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outlined"
            size="compact"
            onClick={handleAddToChat}
            disabled={!replyText.trim()}
          >
            Add to Chat
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={handleSendNow}
            disabled={!replyText.trim()}
            rightIcon={<Send className="h-3 w-3" />}
          >
            Send Now
          </Button>
        </div>
      </div>
    </div>
  );
}
