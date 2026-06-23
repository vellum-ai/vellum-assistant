/**
 * Floating popover that appears when the user selects text inside an
 * assistant message bubble. Offers a single reply action for the selected
 * passage.
 *
 * Desktop-only — `isPointerCoarse()` gates the entire listener so touch
 * devices never see the popover (OS text selection UX conflicts).
 */

import { MessageSquareQuote } from "lucide-react";
import { type RefObject, useCallback, useEffect, useState } from "react";

import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import { isPointerCoarse } from "@/utils/pointer";
import { Button, Popover } from "@vellumai/design-library";

/**
 * Selector: the transcript container ref whose descendants contain
 * assistant message text. The popover listens for `mouseup` on this
 * container and checks whether the selection falls inside an assistant
 * message element (identified by `data-message-id` + `data-message-role`).
 */
interface TextSelectionPopoverProps {
  containerRef: RefObject<HTMLElement | null>;
}

export function TextSelectionPopover({ containerRef }: TextSelectionPopoverProps) {
  const [popover, setPopover] = useState<{
    text: string;
    messageId: string;
    top: number;
    left: number;
  } | null>(null);

  const openReplyBubble = useQuoteReplyStore.use.openReplyBubble();

  const handleMouseUp = useCallback(() => {
    if (isPointerCoarse()) {
      return;
    }

    // Defer to next microtask so the browser has finalized the selection.
    requestAnimationFrame(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        return;
      }

      const text = selection.toString().trim();
      if (!text) {
        return;
      }

      // Walk up from the selection anchor to find the message wrapper.
      const anchorNode = selection.anchorNode;
      if (!anchorNode) {
        return;
      }

      const messageEl = findMessageElement(anchorNode);
      if (!messageEl) {
        return;
      }

      const role = messageEl.getAttribute("data-message-role");
      if (role !== "assistant") {
        return;
      }

      const messageId = messageEl.getAttribute("data-message-id");
      if (!messageId) {
        return;
      }

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      setPopover({
        text,
        messageId,
        top: rect.top,
        left: rect.left + rect.width / 2,
      });
    });
  }, []);

  // Dismiss the popover when the selection is cleared.
  useEffect(() => {
    if (!popover) {
      return;
    }

    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setPopover(null);
      }
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [popover]);

  // Listen for mouseup on the document and validate the selection target is
  // within the transcript container. Using document-level listeners avoids
  // the stale-ref problem where containerRef.current is null on initial
  // mount (before the Transcript element renders).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const target = e.target as Node | null;
      if (target && container.contains(target)) {
        handleMouseUp();
      }
    };

    document.addEventListener("mouseup", handler);
    return () => {
      document.removeEventListener("mouseup", handler);
    };
  }, [containerRef, handleMouseUp]);

  if (!popover) {
    return null;
  }

  const handleQuoteReply = () => {
    openReplyBubble({
      quotedText: popover.text,
      sourceMessageId: popover.messageId,
      anchorRect: {
        top: popover.top,
        left: popover.left,
        width: 0,
        height: 0,
      },
    });
    window.getSelection()?.removeAllRanges();
    setPopover(null);
  };

  return (
    <Popover.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          setPopover(null);
        }
      }}
    >
      <Popover.Anchor asChild>
        <span
          aria-hidden="true"
          className="fixed h-0 w-0"
          style={{
            top: popover.top,
            left: popover.left,
          }}
        />
      </Popover.Anchor>
      <Popover.Content
        side="top"
        align="center"
        sideOffset={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="rounded-md bg-transparent p-0 shadow-none"
      >
        <Button
          variant="outlined"
          size="regular"
          onClick={handleQuoteReply}
          leftIcon={<MessageSquareQuote />}
          className="bg-[var(--surface-base)] shadow-md"
        >
          Reply
        </Button>
      </Popover.Content>
    </Popover.Root>
  );
}

/**
 * Walk from a DOM node upward to find the closest element with
 * `data-message-id` — the transcript row wrapper.
 */
function findMessageElement(node: Node): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (
      current instanceof HTMLElement &&
      current.hasAttribute("data-message-id")
    ) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}
