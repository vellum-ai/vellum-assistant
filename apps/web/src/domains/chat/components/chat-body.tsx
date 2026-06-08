import { type DragEventHandler, type ReactNode } from "react";

import { Eye, Paperclip, Square } from "lucide-react";

import { ChatComposer, type ChatComposerProps } from "@/domains/chat/components/chat-composer/chat-composer";
import { QuestionPromptSlot } from "@/domains/chat/components/question-prompt-slot";
import { ChatScrollArea, type ChatScrollAreaProps } from "@/domains/chat/components/chat-scroll-area";
import { ScrollToLatestButton } from "@/domains/chat/components/scroll-to-latest-button";
import {
    RefreshFeedbackPill,
    type RefreshFeedback,
} from "@/domains/chat/refresh-feedback-pill";
import { Button, Notice } from "@vellumai/design-library";

/**
 * Single composition of a chat panel: a scrollable messages/empty-state
 * area on top, and a composer stack underneath.
 *
 * **Empty‑state centering (LUM-1566):** When the empty state is visible,
 * the outer container switches to `justify-content: safe center` +
 * `overflow-y-auto` and the scroll area drops its `flex-1`. This lets
 * the greeting, composer, and conversation-starter chips center as a
 * single visual group — matching the original centered layout — while
 * the composer **stays at the same position in the React tree** so its
 * state (focus, draft text, attachments) is preserved across the
 * empty→active transition. `safe center` falls back to start-alignment
 * when the group overflows (e.g. iOS with the soft keyboard open).
 *
 * See [React — Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state)
 * and [MDN — `justify-content: safe center`](https://developer.mozilla.org/en-US/docs/Web/CSS/justify-content).
 *
 * Both the main chat path and the app-editing side panel render this
 * exact component. Differences between the two — mobile-app nudge
 * banners, the queued-messages drawer, container variant — are passed in
 * as optional slot props or a `variant` enum, so the composer itself is
 * a single mounted instance across both paths (LUM-1516).
 *
 * The component is purely presentational: all state, handlers, and
 * derived flags are owned by the parent page. This keeps the chat-body
 * surface framework-agnostic and free of routing or page-level
 * concerns.
 */
export interface ChatBodyDragHandlers {
  onDragEnter: DragEventHandler<HTMLDivElement>;
  onDragOver: DragEventHandler<HTMLDivElement>;
  onDragLeave: DragEventHandler<HTMLDivElement>;
  onDrop: DragEventHandler<HTMLDivElement>;
}

export interface ChatBodyProps {
  /**
   * `"main"` — main chat panel; outer container uses `flex-1` so the
   * panel grows to fill the available height.
   * `"side-panel"` — used inside a resizable side pane (e.g. the
   * app-editing layout); outer container uses `h-full` so the panel
   * fills the resizable pane's height.
   */
  variant: "main" | "side-panel";

  /** Props forwarded to {@link ChatScrollArea}. */
  scrollAreaProps: ChatScrollAreaProps;

  /** Props forwarded to {@link ChatComposer}. */
  composerProps: ChatComposerProps;

  /** Drag handlers attached to the outer container for attachment drag-and-drop. */
  dragHandlers: ChatBodyDragHandlers;
  /** True when an attachment drag is active; shows a drop-target overlay. */
  isAttachmentDragOver: boolean;

  /** True when the "Go to Newest" pill should be shown above the composer. */
  showScrollToLatest: boolean;
  /** Click handler for the "Go to Newest" pill. */
  onScrollToLatest: () => void;
  /** True when an assistant response is currently streaming — drives the
   *  animated dots indicator inside the "Go to Newest" pill. */
  isStreaming?: boolean;

  /** Active refresh-feedback pill, or `null` when no pill is shown. */
  refreshFeedback: RefreshFeedback | null;
  /** Dismiss handler for {@link refreshFeedback}. */
  onDismissRefreshFeedback: () => void;
  /** Retry handler for {@link refreshFeedback}. */
  onRetryRefresh: () => void;

  /** Generic chat error rendered above the composer, or `null` when none. */
  genericChatError: { message: string; actions?: ReactNode } | null;

  /** When true, a read-only banner replaces the composer entirely. */
  isChannelReadonly: boolean;
  /**
   * True when the read-only banner should expose the active turn
   * cancellation control.
   */
  canStopGenerating?: boolean;

  /**
   * Optional pre-rendered banner stack (mobile-app nudge / GitHub / Discord)
   * rendered alongside the scroll-to-latest button in the absolute-positioned
   * overlay above the composer. Omitted by the app-editing side panel.
   */
  bannerSlot?: ReactNode;

  /**
   * Optional pre-rendered queued-messages drawer rendered inside the
   * max-width wrapper above the composer. Omitted by the app-editing
   * side panel.
   */
  queuedDrawerSlot?: ReactNode;

  /**
   * Optional pre-rendered footer rendered inside the max-width wrapper
   * immediately above the composer or read-only banner.
   */
  channelFooterSlot?: ReactNode;

  /**
   * Optional replacement for the generic read-only banner. Used by channel
   * surfaces that can provide a native "open there" action.
   */
  readonlyBannerSlot?: ReactNode;

  /**
   * Optional conversation-starter chip grid rendered inside the max-width
   * wrapper directly below the composer. Visible only on the empty state;
   * the parent passes `undefined` once messages arrive. Rendered as a
   * slot (like {@link bannerSlot}) so `ChatBody` stays agnostic of the
   * starter data model.
   */
  startersSlot?: ReactNode;
}

/**
 * Read-only composer replacement shown when the active conversation is
 * bound to an external channel (Slack, Telegram, voice/phone, etc.).
 * Mirrors the macOS read-only banner in `ChatView.swift`.
 */
function ChatReadonlyBanner({
  canStopGenerating = false,
  onStopGenerating,
}: {
  canStopGenerating?: boolean;
  onStopGenerating: () => void;
}) {
  return (
    <div className="flex items-center justify-center gap-3 py-4 text-body-small-default text-[var(--content-tertiary)]">
      <div className="flex items-center gap-2">
        <Eye size={14} />
        <span>Read-only conversation</span>
      </div>
      {canStopGenerating && (
        <Button
          variant="primary"
          iconOnly={<Square className="h-3 w-3" fill="currentColor" />}
          onClick={onStopGenerating}
          aria-label="Stop generating"
          title="Stop generation"
        />
      )}
    </div>
  );
}

export function ChatBody({
  variant,
  scrollAreaProps,
  composerProps,
  dragHandlers,
  isAttachmentDragOver,
  showScrollToLatest,
  onScrollToLatest,
  isStreaming = false,
  refreshFeedback,
  onDismissRefreshFeedback,
  onRetryRefresh,
  genericChatError,
  isChannelReadonly,
  canStopGenerating,
  bannerSlot,
  queuedDrawerSlot,
  channelFooterSlot,
  readonlyBannerSlot,
  startersSlot,
}: ChatBodyProps) {
  const isEmptyState = scrollAreaProps.showEmptyState;

  // When the empty state is visible, center greeting + composer + starters
  // as one group. `safe center` falls back to start-alignment when the
  // content overflows the container (e.g. iOS soft keyboard open).
  // `overflow-y-auto` enables scrolling in that overflow case.
  const baseClass =
    variant === "main"
      ? "relative flex min-h-0 flex-1 flex-col"
      : "relative flex h-full min-h-0 flex-col";

  const outerClass = isEmptyState
    ? `${baseClass} overflow-y-auto [justify-content:safe_center]`
    : baseClass;

  // Suppress the absolutely-positioned overlay on the empty state: its
  // `bottom-full` positioning would overlap the greeting when the outer
  // container centers greeting + composer + starters as a group.
  // Banners (app-download nudge, GitHub star, Discord) show once the
  // user sends a message and the empty state clears. `showScrollToLatest`
  // is already false on the empty state (gated on `messages.length > 0`
  // at the call site), so this only affects `bannerSlot`.
  const hasOverlay =
    !isEmptyState && (showScrollToLatest || Boolean(bannerSlot));

  return (
    <div
      className={outerClass}
      onDragEnter={dragHandlers.onDragEnter}
      onDragOver={dragHandlers.onDragOver}
      onDragLeave={dragHandlers.onDragLeave}
      onDrop={dragHandlers.onDrop}
    >
      <ChatScrollArea {...scrollAreaProps} />

      {/* Composer stack — stays at the same tree position across the
          empty→active transition so React preserves its state (focus,
          draft text, attachments) and iOS Safari does not blur the input
          on first send (LUM-1506 / LUM-1516). */}
      <div
        className="relative px-3 pt-2 pb-2 sm:px-6 sm:pb-0"
      >
        {refreshFeedback && (
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-10 flex justify-center pb-2">
            <RefreshFeedbackPill
              feedback={refreshFeedback}
              onDismiss={onDismissRefreshFeedback}
              onRetry={onRetryRefresh}
            />
          </div>
        )}
        {hasOverlay && (
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-10 flex flex-col items-center">
            {showScrollToLatest && (
              <div className="pointer-events-auto pb-2.5">
                <ScrollToLatestButton
                  onClick={onScrollToLatest}
                  isStreaming={isStreaming}
                />
              </div>
            )}
            {bannerSlot}
          </div>
        )}
        <div className="mx-auto max-w-[var(--chat-max-width)]">
          {genericChatError && (
            <div className="mb-2">
              <Notice tone="error" actions={genericChatError.actions}>{genericChatError.message}</Notice>
            </div>
          )}
          {queuedDrawerSlot}
          <QuestionPromptSlot />
          {channelFooterSlot}
          {isChannelReadonly ? (
            readonlyBannerSlot ? (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">{readonlyBannerSlot}</div>
                {canStopGenerating ? (
                  <Button
                    variant="primary"
                    iconOnly={<Square className="h-3 w-3" fill="currentColor" />}
                    onClick={composerProps.onStopGenerating}
                    aria-label="Stop generating"
                    title="Stop generation"
                  />
                ) : null}
              </div>
            ) : (
              <ChatReadonlyBanner
                canStopGenerating={canStopGenerating}
                onStopGenerating={composerProps.onStopGenerating}
              />
            )
          ) : (
            <ChatComposer {...composerProps} />
          )}
          {startersSlot}
        </div>
      </div>
      {isAttachmentDragOver && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[10px] border-2 border-dashed border-[var(--ring)] bg-[var(--surface-lift)]/80 backdrop-blur-sm"
        >
          <div className="flex flex-col items-center gap-2 text-[var(--content-default)]">
            <Paperclip className="h-6 w-6" />
            <span className="text-body-medium-default">Drop files to attach</span>
          </div>
        </div>
      )}
    </div>
  );
}
