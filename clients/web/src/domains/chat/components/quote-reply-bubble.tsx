/**
 * Overlay bubble that appears after the user starts a reply from a text
 * selection. Displays the quoted passage and a text input for the user's
 * reply, with one action:
 *
 * - **Add to Chat** — stages the quote+reply for inclusion in the next
 *   message the user sends from the composer.
 */

import { MessageSquareQuote, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import {
  Button,
  Card,
  Popover,
  Textarea,
  Typography,
} from "@vellumai/design-library";

interface QuoteReplyBubbleProps {
  onAddToChat?: () => void;
}

export function QuoteReplyBubble({ onAddToChat }: QuoteReplyBubbleProps) {
  const replyBubble = useQuoteReplyStore.use.replyBubble();
  const closeReplyBubble = useQuoteReplyStore.use.closeReplyBubble();
  const addStagedQuote = useQuoteReplyStore.use.addStagedQuote();

  const [replyText, setReplyText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Reset reply text when the bubble opens with new content.
  useEffect(() => {
    if (replyBubble) {
      setReplyText("");
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [replyBubble]);

  const handleAddToChat = useCallback(() => {
    if (!replyBubble || !replyText.trim()) {
      return;
    }
    addStagedQuote({
      quotedText: replyBubble.quotedText,
      replyText: replyText.trim(),
      sourceMessageId: replyBubble.sourceMessageId,
    });
    onAddToChat?.();
    closeReplyBubble();
  }, [replyBubble, replyText, addStagedQuote, onAddToChat, closeReplyBubble]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleAddToChat();
      }
    },
    [handleAddToChat],
  );

  if (!replyBubble) {
    return null;
  }

  const truncatedQuote =
    replyBubble.quotedText.length > 200
      ? `${replyBubble.quotedText.slice(0, 200)}…`
      : replyBubble.quotedText;

  return (
    <Popover.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          closeReplyBubble();
        }
      }}
    >
      <Popover.Anchor asChild>
        <span
          aria-hidden="true"
          className="fixed h-0 w-0"
          style={{
            top: replyBubble.anchorRect.top,
            left: replyBubble.anchorRect.left,
          }}
        />
      </Popover.Anchor>
      <Popover.Content
        side="top"
        align="center"
        sideOffset={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-[360px] rounded-xl bg-transparent p-0 shadow-none"
      >
        <Card.Root
          padding="sm"
          bordered
          elevated
          className="bg-[var(--surface-base)] shadow-lg"
        >
          <Card.Body padding="sm" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <Typography
                as="div"
                variant="body-small-default"
                className="flex min-w-0 items-center gap-1.5 text-[var(--content-tertiary)]"
              >
                <MessageSquareQuote className="h-3.5 w-3.5 shrink-0" />
                <span>Quote &amp; Reply</span>
              </Typography>
              <Popover.Close asChild>
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly={<X />}
                  expandOnMobile={false}
                  aria-label="Close reply"
                />
              </Popover.Close>
            </div>

            <Typography
              as="div"
              variant="body-small-default"
              className="rounded-md border-l-2 border-[var(--content-tertiary)] bg-[var(--surface-sunken)] px-3 py-1.5 text-[var(--content-secondary)] [&_p]:mb-0"
            >
              {truncatedQuote}
            </Typography>

            <Textarea
              ref={textareaRef}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your reply…"
              rows={2}
              fullWidth
              className="min-h-[64px] resize-none text-body-small-default"
            />

            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outlined"
                size="compact"
                onClick={handleAddToChat}
                disabled={!replyText.trim()}
              >
                Add to Chat
              </Button>
            </div>
          </Card.Body>
        </Card.Root>
      </Popover.Content>
    </Popover.Root>
  );
}
