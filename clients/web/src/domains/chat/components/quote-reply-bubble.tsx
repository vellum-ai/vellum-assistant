/**
 * Overlay bubble that appears after the user starts a reply from a text
 * selection. Displays the quoted passage and a text input for the user's
 * reply, with two actions:
 *
 * - **Cancel** — dismisses the bubble without staging anything.
 * - **Add to Chat** — stages the quote+reply for inclusion in the next
 *   message the user sends from the composer.
 *
 * On touch-mobile the bubble docks full-width just above the composer instead
 * of floating at the selection, so it stays reachable next to the soft
 * keyboard; on desktop it stays a popover anchored to the selection.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Button,
  Card,
  Popover,
  Textarea,
  Typography,
} from "@vellumai/design-library";
import {
  quoteBlockquoteAccentClassName,
  quoteBlockquoteClassName,
  quoteBlockquoteContentClassName,
} from "@vellumai/design-library/components/markdown-message";

import { useTouchMobile } from "@/hooks/use-touch-mobile";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";

interface QuoteReplyBubbleProps {
  onAddToChat?: () => void;
}

// Gap between the docked bubble and the top of the composer on touch-mobile.
const COMPOSER_DOCK_GAP_PX = 8;

/**
 * Distance from the viewport bottom to the top of the composer, so the docked
 * bubble can sit just above it. Tracks composer resizes (soft keyboard,
 * attachment strip, multi-line input) and viewport changes. `0` until the
 * composer is measured or when disabled.
 */
function useComposerTopOffset(enabled: boolean): number {
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const composer = document.querySelector<HTMLElement>(
      '[data-slot="chat-composer"]',
    );
    if (!composer) {
      return;
    }
    const measure = () => {
      const rect = composer.getBoundingClientRect();
      setOffset(window.innerHeight - rect.top);
    };
    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(composer);
    window.visualViewport?.addEventListener("resize", measure);
    // iOS shifts layout via visualViewport scroll (keyboard offsetTop change)
    // with no resize event; the root shell moves on this same signal, so the
    // dock must remeasure here too or it drifts from the composer.
    window.visualViewport?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver.disconnect();
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [enabled]);

  return offset;
}

export function QuoteReplyBubble({ onAddToChat }: QuoteReplyBubbleProps) {
  const replyBubble = useQuoteReplyStore.use.replyBubble();
  const closeReplyBubble = useQuoteReplyStore.use.closeReplyBubble();
  const addStagedQuote = useQuoteReplyStore.use.addStagedQuote();

  const [replyText, setReplyText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isTouchMobile = useTouchMobile();
  const composerTopOffset = useComposerTopOffset(
    isTouchMobile && replyBubble != null,
  );

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

  const card: ReactNode = (
    <Card.Root
      padding="sm"
      bordered
      elevated
      className="bg-[var(--surface-base)] shadow-lg"
    >
      <Card.Body padding="sm" className="flex flex-col gap-3">
        <Typography
          as="div"
          variant="body-small-default"
          className={`${quoteBlockquoteClassName} mb-0`}
        >
          <span aria-hidden="true" className={quoteBlockquoteAccentClassName} />
          <span className={`${quoteBlockquoteContentClassName} italic`}>
            {truncatedQuote}
          </span>
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

        <div className="flex items-center justify-between gap-2">
          <Button variant="outlined" size="compact" onClick={closeReplyBubble}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={handleAddToChat}
            disabled={!replyText.trim()}
          >
            Add to Chat
          </Button>
        </div>
      </Card.Body>
    </Card.Root>
  );

  // Touch-mobile: dock full-width above the composer (12px side margins)
  // rather than floating at the selection, keeping it beside the soft keyboard.
  if (isTouchMobile) {
    return createPortal(
      <div
        role="dialog"
        aria-label="Quote and reply"
        className="fixed inset-x-3 z-50"
        style={{ bottom: composerTopOffset + COMPOSER_DOCK_GAP_PX }}
      >
        {card}
      </div>,
      document.body,
    );
  }

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
        collisionPadding={12}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-[360px] rounded-xl bg-transparent p-0 shadow-none"
      >
        {card}
      </Popover.Content>
    </Popover.Root>
  );
}
