import { useCallback, useState, type ReactNode } from "react";

import type { LucideIcon } from "lucide-react";

import type { Conversation } from "@/types/conversation-types";
import { Popover, SideMenu } from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";
import { useTranslation } from "@/i18n";

// ---------------------------------------------------------------------------
// Indicator state
// ---------------------------------------------------------------------------

export type GroupIndicatorState = "attention" | "processing" | "unread" | null;

/**
 * Derive the highest-priority indicator state for a group of conversations.
 *
 * Priority: attention > processing > unread > null.
 *
 * `indexUnread` is the section's unread count per the daemon's section
 * index. When defined it decides the unread bit outright, in both
 * directions: the index counts the whole section while `conversations` is
 * only what the client has loaded, so a scan can miss unread rows beyond
 * the loaded window and can keep counting a row the server already settled.
 * Attention and processing are client-only state and always scan.
 */
export function getGroupIndicatorState(
  conversations: Conversation[],
  processingConversationIds: Set<string> | undefined,
  attentionConversationIds: Set<string> | undefined,
  indexUnread?: number,
): GroupIndicatorState {
  let hasProcessing = false;
  let hasUnread = indexUnread !== undefined && indexUnread > 0;

  for (const c of conversations) {
    if (attentionConversationIds?.has(c.conversationId)) {
      return "attention";
    }
    if (!hasProcessing && processingConversationIds?.has(c.conversationId)) {
      hasProcessing = true;
    }
    if (
      indexUnread === undefined &&
      !hasUnread &&
      c.hasUnseenLatestAssistantMessage
    ) {
      hasUnread = true;
    }
  }

  if (hasProcessing) {
    return "processing";
  }
  if (hasUnread) {
    return "unread";
  }
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

/**
 * The colored activity dot for a group of conversations. Renders nothing when
 * there's no activity. Callers position it — the collapsed rail overlays it on
 * the icon corner; the expanded section header renders it inline.
 */
export function GroupIndicatorDot({
  state,
  className,
}: {
  state: GroupIndicatorState;
  className?: string;
}) {
  if (state == null) {
    return null;
  }
  return (
    <span
      aria-hidden
      data-slot="group-indicator-dot"
      className={cn(
        "h-2.5 w-2.5 rounded-full",
        INDICATOR_CLASS[state],
        className,
      )}
    />
  );
}

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
  /**
   * Popover body. Receives a close callback and the popover's own scrollport,
   * so a long list can window against it rather than opening a second one.
   */
  children?:
    | ReactNode
    | ((close: () => void, scrollParent: HTMLElement | null) => ReactNode);
}

export function CollapsedGroupIcon({
  icon: Icon,
  label,
  indicatorState,
  disabled = false,
  onOpenChange,
  children,
}: CollapsedGroupIconProps) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [contentEl, setContentEl] = useState<HTMLElement | null>(null);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const close = useCallback(() => setOpen(false), []);

  if (disabled) {
    // Empty group: the same tile, minus the popover it would open. Its
    // tooltip explains why it does nothing rather than repeating the group
    // name the icon already conveys, so `tooltip` diverges from `label`
    // (which still names the tile for assistive tech).
    return (
      <SideMenu.Item
        icon={Icon}
        label={label}
        tooltip={t("collapsedGroupIcon.noConversations")}
        shape="tile"
        disabled
      />
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <SideMenu.Item
          icon={Icon}
          label={label}
          showCollapsedTooltip
          shape="tile"
          active={open}
          // `active` is the open-flyout surface here, not a location. This
          // tile opens a popover over the rail rather than navigating, so it
          // drops the `aria-current="page"` that a real destination row sets.
          aria-current={undefined}
          aria-haspopup="dialog"
          indicator={
            <GroupIndicatorDot
              state={indicatorState}
              className="absolute right-0 top-0 border-2 border-[var(--surface-overlay)]"
            />
          }
        />
      </Popover.Trigger>
      <Popover.Content
        ref={setContentEl}
        side="right"
        align="start"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="max-h-[500px] w-72 overflow-y-auto rounded-lg py-2 px-0"
      >
        {typeof children === "function" ? children(close, contentEl) : children}
      </Popover.Content>
    </Popover.Root>
  );
}
