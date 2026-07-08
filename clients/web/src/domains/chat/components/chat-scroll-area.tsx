import { type ForwardedRef } from "react";

import {
  Transcript,
  type TranscriptHandle,
  type TranscriptProps,
} from "@/domains/chat/transcript/transcript";
import { MaintenanceRecoveryCard } from "@/domains/chat/components/maintenance-recovery-card";
import { ChatEmptyState } from "@/domains/chat/components/chat-empty-state";
import type { ChatEmptyStateProps } from "@/domains/chat/components/chat-empty-state";
import { ChatSkeleton } from "@/domains/chat/components/chat-skeleton";

/**
 * Renders the scrollable content of a chat panel — the single source of
 * truth for "what fills the area between the chat header and the
 * composer." Picks one of four mutually-exclusive states based on its
 * props:
 *
 * 1. `<ChatSkeleton>` — initial history load, no messages yet.
 * 2. `<MaintenanceRecoveryCard>` — assistant is in maintenance mode (no
 *    messages).
 * 3. `<ChatEmptyState>` — fresh conversation, no messages, not loading,
 *    not in maintenance. Renders avatar + greeting at natural height;
 *    the parent `ChatBody` handles vertical centering of the entire
 *    greeting → composer → starters group (see LUM-1566).
 * 4. `<Transcript>` — there's at least one message.
 *
 * The composer itself is rendered separately by the parent in a
 * bottom-anchored block; the same composer instance is reused across all
 * four states so iOS Safari does not blur the input on the empty→active
 * transition (LUM-1516). Both the main chat path and the app-editing
 * side panel use this component identically — the only difference is
 * that `showMaintenanceRecoveryCard` is wired only by the main path
 * (app editing is not reachable while the assistant is in maintenance).
 */
export interface ChatScrollAreaProps {
  /** True while the first page of history is loading. */
  isLoadingHistory: boolean;
  /** Number of merged display messages currently visible. */
  messageCount: number;
  /**
   * When `true`, the assistant is in maintenance mode and the recovery
   * card is shown in place of the empty state. Only the main chat path
   * passes `true`; the app-editing side panel always passes `false`.
   */
  showMaintenanceRecoveryCard: boolean;
  /**
   * Whether to render the {@link ChatEmptyState} hero. The caller derives
   * this from its own composite state (typically:
   * `!isLoadingHistory && messageCount === 0 && !maintenanceMode`) so
   * the empty-state branch's exact precondition stays in the parent.
   */
  showEmptyState: boolean;
  /** {@link ChatEmptyStateProps} forwarded to {@link ChatEmptyState}. */
  emptyStateProps: ChatEmptyStateProps;
  /** Ref forwarded to the underlying {@link Transcript}. */
  transcriptRef: ForwardedRef<TranscriptHandle>;
  /** {@link TranscriptProps} forwarded to {@link Transcript}. */
  transcriptProps: TranscriptProps;
  /** Space reserved below the scrollable transcript for bottom floating UI. */
  bottomOverlayReservePx?: number;
}

export function ChatScrollArea({
  isLoadingHistory,
  messageCount,
  showMaintenanceRecoveryCard,
  showEmptyState,
  emptyStateProps,
  transcriptRef,
  transcriptProps,
  bottomOverlayReservePx,
}: ChatScrollAreaProps) {
  // When the empty state is shown, this wrapper must NOT take `flex-1` so
  // the parent `ChatBody` can center it together with the composer +
  // starters as a single group. In all other states (skeleton, maintenance,
  // transcript), `flex-1` lets the content fill the available height.
  const wrapperClass = showEmptyState
    ? "relative flex min-h-0 flex-col"
    : "relative flex min-h-0 flex-1 flex-col";
  const wrapperStyle = bottomOverlayReservePx
    ? { paddingBottom: bottomOverlayReservePx }
    : undefined;

  return (
    <div className={wrapperClass} style={wrapperStyle}>
      {isLoadingHistory && messageCount === 0 && <ChatSkeleton />}
      {showMaintenanceRecoveryCard && <MaintenanceRecoveryCard />}
      {showEmptyState && <ChatEmptyState {...emptyStateProps} />}
      {messageCount > 0 && <Transcript ref={transcriptRef} {...transcriptProps} />}
    </div>
  );
}
