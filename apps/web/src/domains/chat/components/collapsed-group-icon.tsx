import { useCallback, useState, type ReactNode } from "react";

import type { LucideIcon } from "lucide-react";

import { Popover } from "@vellum/design-library";
import type { Conversation } from "@/domains/chat/api/conversations";

// ---------------------------------------------------------------------------
// Indicator state
// ---------------------------------------------------------------------------

export type GroupIndicatorState = "attention" | "processing" | "unread" | null;

/**
 * Derive the highest-priority indicator state for a group of conversations.
 *
 * Priority: attention > processing > unread > null.
 */
export function getGroupIndicatorState(
  conversations: Conversation[],
  processingConversationIds: Set<string> | undefined,
  attentionConversationIds: Set<string> | undefined,
): GroupIndicatorState {
  let hasProcessing = false;
  let hasUnread = false;

  for (const c of conversations) {
    if (attentionConversationIds?.has(c.conversationId)) {
      return "attention";
    }
    if (!hasProcessing && processingConversationIds?.has(c.conversationId)) {
      hasProcessing = true;
    }
    if (!hasUnread && c.hasUnseenLatestAssistantMessage) {
      hasUnread = true;
    }
  }

  if (hasProcessing) return "processing";
  if (hasUnread) return "unread";
  return null;
}

// ---------------------------------------------------------------------------
// Indicator dot color
// ---------------------------------------------------------------------------

const INDICATOR_CLASS: Record<Exclude<GroupIndicatorState, null>, string> = {
  attention: "bg-[var(--system-mid-strong)]",
  processing: "bg-[var(--primary-base)] animate-pulse",
  unread: "bg-[var(--system-mid-strong)]",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface CollapsedGroupIconProps {
  /** The group's Lucide icon (Pin, Clock, etc.). */
  icon: LucideIcon;
  /** Accessible label for the button (e.g. "Pinned", "Recents"). */
  label: string;
  /** Drives the indicator dot overlay. */
  indicatorState: GroupIndicatorState;
  /** When true, the group has no conversations — renders a muted icon with no popover. */
  disabled?: boolean;
  /**
   * Popover content. Accepts a render function that receives a `close` callback
   * to programmatically dismiss the popover (e.g. after selecting a conversation).
   */
  children?: ReactNode | ((close: () => void) => ReactNode);
}

export function CollapsedGroupIcon({
  icon: Icon,
  label,
  indicatorState,
  disabled = false,
  children,
}: CollapsedGroupIconProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (disabled) {
    return (
      <div
        aria-label={label}
        title="No conversations"
        className="relative flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--content-disabled)]"
      >
        <Icon size={18} />
      </div>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-[6px] text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)] aria-[expanded=true]:bg-[var(--surface-active)] aria-[expanded=true]:text-[var(--content-emphasised)]"
        >
          <Icon size={18} />
          {indicatorState != null ? (
            <span
              aria-hidden
              className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface-base)] ${INDICATOR_CLASS[indicatorState]}`}
            />
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Content
        side="right"
        align="start"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="max-h-[500px] w-72 overflow-y-auto rounded-lg py-2 px-0"
      >
        {typeof children === "function" ? children(close) : children}
      </Popover.Content>
    </Popover.Root>
  );
}
