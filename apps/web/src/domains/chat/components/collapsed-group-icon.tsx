import { useCallback, useState, type ReactNode } from "react";

import type { LucideIcon } from "lucide-react";

import type { Conversation } from "@/types/conversation-types";
import { Popover, Tooltip } from "@vellumai/design-library";

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
   * Called when the popover opens or closes. Lets callers react to the user
   * revealing the group (e.g. trigger a lazy fetch on first open).
   */
  onOpenChange?: (open: boolean) => void;
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
  onOpenChange,
  children,
}: CollapsedGroupIconProps) {
  const [open, setOpen] = useState(false);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const close = useCallback(() => setOpen(false), []);

  if (disabled) {
    // Empty group: a muted, non-interactive icon. The tooltip explains why it
    // does nothing rather than repeating the group name the icon already
    // conveys. No popover and nothing to click, so the plain convenience
    // `Tooltip` (matching the active path) is all we need.
    return (
      <Tooltip content="No conversations" side="right">
        <div
          aria-label={label}
          className="relative flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--content-disabled)]"
        >
          <Icon size={14} />
        </div>
      </Tooltip>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Tooltip content={label} side="right">
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-haspopup="dialog"
            className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-[6px] text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)] aria-[expanded=true]:bg-[var(--surface-active)] aria-[expanded=true]:text-[var(--content-emphasised)]"
          >
            <Icon size={14} />
            {indicatorState != null ? (
              <span
                aria-hidden
                className={`absolute right-0 top-0 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface-base)] ${INDICATOR_CLASS[indicatorState]}`}
              />
            ) : null}
          </button>
        </Popover.Trigger>
      </Tooltip>
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
