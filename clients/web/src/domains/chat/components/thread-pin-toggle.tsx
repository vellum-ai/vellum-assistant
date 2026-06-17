import {
    CircleAlert,
    Pin,
    PinOff,
} from "lucide-react";
import type { ReactNode } from "react";

import { isConversationPinned } from "@/domains/chat/utils/group-conversations";
import type { Conversation } from "@/types/conversation-types";
import { cn } from "@vellumai/design-library";

// ---------------------------------------------------------------------------
// ThreadPinToggle — leading pin icon for thread rows
// ---------------------------------------------------------------------------

export interface ThreadPinToggleProps {
  conversation: Conversation;
  onPinToggle?: () => void;
  isProcessing?: boolean;
  needsAttention?: boolean;
}

const SLOT_BASE = cn(
  "relative inline-flex size-[14px] shrink-0 items-center justify-center",
  "text-[var(--content-tertiary)]",
);

const HOVER_REVEAL =
  "absolute inset-0 m-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100";

const IDLE_FADE = cn(
  "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
);

/**
 * Idle-state indicator that fades out on hover, paired with a pin/unpin
 * glyph that fades in. The two occupy the same slot via absolute positioning
 * so the swap is layout-shift-free.
 */
function IdleAndHoverGlyphs({
  idle,
  isPinned,
}: {
  idle: ReactNode;
  isPinned: boolean;
}) {
  const HoverIcon = isPinned ? PinOff : Pin;
  return (
    <>
      {idle}
      <HoverIcon size={14} aria-hidden className={HOVER_REVEAL} />
    </>
  );
}

/**
 * Leading-slot button for a thread row. State machine (priority order):
 *
 *   Needs attention   → Exclamation circle (warning color, no pulse).
 *   Processing + idle → Pulsing dot (animate-pulse, primary-base).
 *   Unread + idle     → Static dot (system-mid-strong).
 *   Pinned + idle     → Pin glyph (PinOff appears on hover).
 *   Unpinned + idle   → Pin glyph at 0 opacity (hidden; label aligns).
 *   Any + hover       → Pin/PinOff toggle (overrides dot).
 *
 * Clicking fires `onPinToggle` with event propagation stopped so the
 * row's own `onSelect` doesn't also fire.
 */
export function ThreadPinToggle({ conversation, onPinToggle, isProcessing, needsAttention }: ThreadPinToggleProps) {
  const isPinned = isConversationPinned(conversation);
  const showUnreadDot = conversation.hasUnseenLatestAssistantMessage === true;

  let glyphs: ReactNode;

  if (needsAttention) {
    glyphs = (
      <IdleAndHoverGlyphs
        isPinned={isPinned}
        idle={
          <CircleAlert
            size={14}
            aria-hidden
            className={cn("absolute inset-0 m-auto text-[var(--system-mid-strong)]", IDLE_FADE)}
          />
        }
      />
    );
  } else if (isProcessing) {
    glyphs = (
      <IdleAndHoverGlyphs
        isPinned={isPinned}
        idle={
          <span
            aria-hidden
            className={cn(
              "absolute inset-0 m-auto h-2 w-2 rounded-full bg-[var(--primary-base)] animate-pulse",
              IDLE_FADE,
            )}
          />
        }
      />
    );
  } else if (showUnreadDot) {
    glyphs = (
      <IdleAndHoverGlyphs
        isPinned={isPinned}
        idle={
          <span
            aria-hidden
            className={cn(
              "absolute inset-0 m-auto h-2 w-2 rounded-full bg-[var(--system-mid-strong)]",
              IDLE_FADE,
            )}
          />
        }
      />
    );
  } else if (isPinned) {
    glyphs = (
      <IdleAndHoverGlyphs
        isPinned
        idle={
          <Pin
            size={14}
            aria-hidden
            className={IDLE_FADE}
          />
        }
      />
    );
  } else {
    glyphs = (
      <Pin
        size={14}
        aria-hidden
        className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      />
    );
  }

  if (!onPinToggle) {
    return (
      <span aria-hidden className={SLOT_BASE}>
        {glyphs}
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={isPinned ? "Unpin conversation" : "Pin conversation"}
      onClick={(event) => {
        event.stopPropagation();
        onPinToggle();
      }}
      className={cn(
        SLOT_BASE,
        "cursor-pointer hover:text-[var(--content-secondary)]",
        "rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
      )}
    >
      {glyphs}
    </button>
  );
}
