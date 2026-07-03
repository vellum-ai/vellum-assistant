/**
 * Floating popover that appears when the user selects text inside an
 * assistant message bubble. Offers a single reply action for the selected
 * passage.
 *
 * On coarse pointers the chip renders below the selected text when there is
 * room, so native selection menus have space above the cursor.
 */

import { MessageSquareQuote } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Button, Popover } from "@vellumai/design-library";

import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import { isPointerCoarse } from "@/utils/pointer";

const COARSE_SELECTION_SETTLE_MS = 120;
const POPOVER_SIDE_OFFSET = 8;
const ESTIMATED_POPOVER_HEIGHT = 44;

/**
 * Selector: the transcript container ref whose descendants contain
 * assistant message text. The popover checks whether the active selection
 * falls inside an assistant message element, identified by
 * `data-message-id` + `data-message-role`.
 */
interface TextSelectionPopoverProps {
  containerRef: RefObject<HTMLElement | null>;
}

export function TextSelectionPopover({ containerRef }: TextSelectionPopoverProps) {
  const coarseSelectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [popover, setPopover] = useState<{
    text: string;
    messageId: string;
    top: number;
    left: number;
    placement: "top" | "bottom";
  } | null>(null);

  const openReplyBubble = useQuoteReplyStore.use.openReplyBubble();

  const clearCoarseSelectionTimer = useCallback(() => {
    if (coarseSelectionTimerRef.current) {
      clearTimeout(coarseSelectionTimerRef.current);
      coarseSelectionTimerRef.current = null;
    }
  }, []);

  const updatePopoverFromSelection = useCallback(() => {
    const coarsePointer = isPointerCoarse();
    requestAnimationFrame(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        setPopover(null);
        return;
      }

      const text = selection.toString().trim();
      if (!text) {
        setPopover(null);
        return;
      }

      // Walk up from the selection anchor to find the message wrapper.
      const anchorNode = selection.anchorNode;
      if (!anchorNode) {
        setPopover(null);
        return;
      }

      const messageEl = findMessageElement(anchorNode);
      if (!messageEl) {
        setPopover(null);
        return;
      }
      const container = containerRef.current;
      if (!container || !container.contains(messageEl)) {
        setPopover(null);
        return;
      }

      const role = messageEl.getAttribute("data-message-role");
      if (role !== "assistant") {
        setPopover(null);
        return;
      }

      const messageId = messageEl.getAttribute("data-message-id");
      if (!messageId) {
        setPopover(null);
        return;
      }

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const placement = getSelectionPopoverPlacement(rect, coarsePointer);

      setPopover({
        text,
        messageId,
        top: placement === "bottom" ? rect.bottom : rect.top,
        left: rect.left + rect.width / 2,
        placement,
      });
    });
  }, [containerRef]);

  useEffect(() => clearCoarseSelectionTimer, [clearCoarseSelectionTimer]);

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

  useEffect(() => {
    const handler = () => {
      if (!isPointerCoarse()) {
        return;
      }

      clearCoarseSelectionTimer();
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        setPopover(null);
        return;
      }

      coarseSelectionTimerRef.current = setTimeout(() => {
        coarseSelectionTimerRef.current = null;
        updatePopoverFromSelection();
      }, COARSE_SELECTION_SETTLE_MS);
    };

    document.addEventListener("selectionchange", handler);
    return () => {
      document.removeEventListener("selectionchange", handler);
    };
  }, [clearCoarseSelectionTimer, updatePopoverFromSelection]);

  // Listen for mouseup on the document and validate the selection target is
  // within the transcript container. Using document-level listeners avoids
  // the stale-ref problem where containerRef.current is null on initial
  // mount (before the Transcript element renders).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (isPointerCoarse()) {
        return;
      }

      const container = containerRef.current;
      if (!container) {
        return;
      }
      const target = e.target as Node | null;
      if (target && container.contains(target)) {
        updatePopoverFromSelection();
      }
    };

    document.addEventListener("mouseup", handler);
    return () => {
      document.removeEventListener("mouseup", handler);
    };
  }, [containerRef, updatePopoverFromSelection]);

  if (!popover) {
    return null;
  }

  const handleQuoteReply = () => {
    clearCoarseSelectionTimer();
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
        side={popover.placement}
        align="center"
        sideOffset={8}
        data-selection-placement={popover.placement}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="rounded-lg p-0"
      >
        <Button
          variant="ghost"
          size="compact"
          onClick={handleQuoteReply}
          leftIcon={<MessageSquareQuote className="h-3 w-3" />}
          tintColor="var(--content-default)"
          className="rounded-lg px-2.5"
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

function getSelectionPopoverPlacement(
  rect: DOMRect,
  coarsePointer: boolean,
): "top" | "bottom" {
  if (!coarsePointer) {
    return "top";
  }

  const hasRoomBelow =
    rect.bottom + POPOVER_SIDE_OFFSET + ESTIMATED_POPOVER_HEIGHT <=
    window.innerHeight;
  return hasRoomBelow ? "bottom" : "top";
}
