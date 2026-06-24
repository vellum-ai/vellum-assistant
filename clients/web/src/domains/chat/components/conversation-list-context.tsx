/**
 * Shared context for the assistant sidebar's conversation rows.
 *
 * Every conversation row (in Pinned, Recents, a channel section, a custom
 * group, or the collapsed-rail flyout) needs the same ~12 action callbacks
 * plus the active/processing/attention state and the drag-reorder
 * controller. Providing them through context lets {@link ConversationRow}
 * read what it needs directly, so the row, list, and section components
 * don't each take a dozen props.
 */

import { createContext, useContext } from "react";

import type { UseDragReorderResult } from "@/domains/chat/hooks/use-drag-reorder";
import type { Conversation } from "@/types/conversation-types";

export interface ConversationListContextValue {
  activeConversationId?: string;
  /** Whether the *active* conversation is mid-turn (its row shows a spinner). */
  activeConversationProcessing?: boolean;
  /** Conversation ids currently processing (non-active rows). */
  processingConversationIds?: Set<string>;
  /** Conversation ids that need attention (unseen assistant message). */
  attentionConversationIds?: Set<string>;

  /** Select a conversation (and close the overlay sidebar on mobile). */
  onSelect: (conversationId: string) => void;

  onPin?: (conversation: Conversation) => void;
  onRename?: (conversation: Conversation) => void;
  onArchive?: (conversation: Conversation) => void;
  onUnarchive?: (conversation: Conversation) => void;
  onMarkRead?: (conversation: Conversation) => void;
  onMarkUnread?: (conversation: Conversation) => void;
  onAnalyze?: (conversation: Conversation) => void;
  onOpenInNewWindow?: (conversation: Conversation) => void;
  onShareFeedback?: () => void;
  onInspect?: (conversation: Conversation) => void;

  /** Drag-reorder controller; rows derive their own drag props from it. */
  dragReorder: UseDragReorderResult<Conversation>;
  /** True when reordering is wired (an `onReorder` handler exists). */
  canReorder: boolean;
}

const ConversationListContext =
  createContext<ConversationListContextValue | null>(null);

export const ConversationListProvider = ConversationListContext.Provider;

export function useConversationListContext(): ConversationListContextValue {
  const ctx = useContext(ConversationListContext);
  if (!ctx) {
    throw new Error(
      "useConversationListContext must be used within a ConversationListProvider",
    );
  }
  return ctx;
}
