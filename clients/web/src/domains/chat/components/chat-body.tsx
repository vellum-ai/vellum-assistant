import {
  useLayoutEffect,
  useRef,
  useState,
  type DragEventHandler,
  type ReactNode,
} from "react";

import { Eye, Paperclip, Square, X } from "lucide-react";

import { QuestionPromptSlot } from "@/domains/chat/components/question-prompt-slot";
import { StagedQuotesStrip } from "@/domains/chat/components/staged-quotes-strip";
import {
  ChatScrollArea,
  type ChatScrollAreaProps,
} from "@/domains/chat/components/chat-scroll-area";
import { ScrollToLatestButton } from "@/domains/chat/components/scroll-to-latest-button";
import {
  RefreshFeedbackPill,
  type RefreshFeedback,
} from "@/domains/chat/refresh-feedback-pill";
import { Button, Notice, type NoticeTone } from "@vellumai/design-library";

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

  /**
   * The composer element to render below the scroll area. The orchestrator
   * builds `<ChatComposer …/>` with explicit props and passes it as a node;
   * `ChatBody` only positions it (and swaps it for the read-only banner).
   */
  composerSlot: ReactNode;
  /**
   * Stop-generation handler for the read-only banner's cancel control. In
   * read-only conversations the composer is replaced by the banner, so this is
   * passed alongside {@link composerSlot} rather than read off it.
   */
  onStopGenerating: () => void;

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

  /** Generic chat notice rendered above the composer, or `null` when none. */
  genericChatError: {
    message: string;
    actions?: ReactNode;
    tone?: NoticeTone;
  } | null;
  /**
   * Dismiss handler for {@link genericChatError}. When provided, the
   * banner renders a "Dismiss" button as a second action next to the
   * existing actions (typically "Go to Doctor").
   */
  onDismissChatError?: () => void;

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

  /**
   * Below-the-fold content rendered after the first viewport on the empty
   * state. Only used when {@link dockStartersToBottom} is true (the
   * suggestions-library layout); holds the categorized suggestion groups.
   */
  belowFoldSlot?: ReactNode;

  /**
   * When true (and on the empty state), the greeting + composer are centered
   * in the first viewport, {@link startersSlot} is docked to the bottom of
   * that viewport, and {@link belowFoldSlot} is placed below the fold. Used by
   * the new-thread suggestions library. When false, the empty state keeps the
   * default layout where the starters sit directly below the composer.
   */
  dockStartersToBottom?: boolean;

  /**
   * Top-center floating row of active background-process overlays (subagents,
   * ACP runs, workflows, background tasks), shown independent of scroll
   * position. The caller builds this from the process registry and passes it
   * only when at least one process is active; each overlay self-gates on its
   * own active ids. Omitting it (or passing `undefined`) keeps the row from
   * mounting.
   */
  activeProcessOverlaysSlot?: ReactNode;
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
  composerSlot,
  onStopGenerating,
  dragHandlers,
  isAttachmentDragOver,
  showScrollToLatest,
  onScrollToLatest,
  isStreaming = false,
  refreshFeedback,
  onDismissRefreshFeedback,
  onRetryRefresh,
  genericChatError,
  onDismissChatError,
  isChannelReadonly,
  canStopGenerating,
  bannerSlot,
  queuedDrawerSlot,
  channelFooterSlot,
  readonlyBannerSlot,
  startersSlot,
  belowFoldSlot,
  dockStartersToBottom = false,
  activeProcessOverlaysSlot,
}: ChatBodyProps) {
  const isEmptyState = scrollAreaProps.showEmptyState;
  const bottomBannerOverlayRef = useRef<HTMLDivElement | null>(null);
  const [bottomBannerOverlayHeight, setBottomBannerOverlayHeight] = useState(0);

  useLayoutEffect(() => {
    if (isEmptyState || !bannerSlot) {
      setBottomBannerOverlayHeight(0);
      return;
    }

    const el = bottomBannerOverlayRef.current;
    if (!el) return;

    const updateHeight = () => {
      const nextHeight = Math.ceil(el.getBoundingClientRect().height);
      setBottomBannerOverlayHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bannerSlot, isEmptyState]);

  // When the empty state is visible, center greeting + composer + starters
  // as one group. `safe center` falls back to start-alignment when the
  // content overflows the container (e.g. iOS soft keyboard open).
  // `overflow-y-auto` enables scrolling in that overflow case.
  const baseClass =
    variant === "main"
      ? "relative flex min-h-0 flex-1 flex-col"
      : "relative flex h-full min-h-0 flex-col";

  // The docked (suggestions-library) empty state owns its own vertical layout
  // — a full-height first screen that centers the greeting + composer and
  // pins the featured row to the bottom — so it does not use `safe center`.
  const outerClass = isEmptyState
    ? dockStartersToBottom
      ? `${baseClass} overflow-y-auto`
      : `${baseClass} overflow-y-auto [justify-content:safe_center]`
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
  const bottomOverlayReservePx =
    !isEmptyState && bannerSlot && bottomBannerOverlayHeight > 0
      ? bottomBannerOverlayHeight
      : undefined;

  // Composer stack — stays at the same tree position across the empty→active
  // transition so React preserves its state (focus, draft text, attachments)
  // and iOS Safari does not blur the input on first send (LUM-1506 / LUM-1516).
  // `trailingStarters` lets the docked layout render the starters elsewhere
  // (its own bottom dock) instead of directly below the composer.
  const renderComposerStack = (trailingStarters: ReactNode) => (
    <div className="relative px-3 pt-2 pb-2 sm:px-6 sm:pb-0">
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
          {bannerSlot && (
            <div ref={bottomBannerOverlayRef} className="w-full">
              {bannerSlot}
            </div>
          )}
        </div>
      )}
      <div className="mx-auto max-w-[var(--chat-max-width)]">
        {genericChatError && (
          <div className="mb-2">
            <Notice
              tone={genericChatError.tone ?? "error"}
              actions={
                <>
                  {genericChatError.actions}
                  {onDismissChatError ? (
                    <Button
                      variant="outlined"
                      size="compact"
                      leftIcon={
                        <X
                          className="h-3.5 w-3.5"
                          strokeWidth={2}
                          aria-hidden="true"
                        />
                      }
                      onClick={onDismissChatError}
                    >
                      Dismiss
                    </Button>
                  ) : null}
                </>
              }
            >
              {genericChatError.message}
            </Notice>
          </div>
        )}
        {queuedDrawerSlot}
        <QuestionPromptSlot />
        {channelFooterSlot}
        <StagedQuotesStrip />
        {isChannelReadonly ? (
          readonlyBannerSlot ? (
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">{readonlyBannerSlot}</div>
              {canStopGenerating ? (
                <Button
                  variant="primary"
                  iconOnly={<Square className="h-3 w-3" fill="currentColor" />}
                  onClick={onStopGenerating}
                  aria-label="Stop generating"
                  title="Stop generation"
                />
              ) : null}
            </div>
          ) : (
            <ChatReadonlyBanner
              canStopGenerating={canStopGenerating}
              onStopGenerating={onStopGenerating}
            />
          )
        ) : (
          composerSlot
        )}
        {trailingStarters}
      </div>
    </div>
  );

  const dragOverlay = isAttachmentDragOver && (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[10px] border-2 border-dashed border-[var(--ring)] bg-[var(--surface-lift)]/80 backdrop-blur-sm"
    >
      <div className="flex flex-col items-center gap-2 text-[var(--content-default)]">
        <Paperclip className="h-6 w-6" />
        <span className="text-body-medium-default">Drop files to attach</span>
      </div>
    </div>
  );

  // Docked (suggestions-library) empty state: the first screen fills the
  // viewport with the greeting + composer centered and the featured row
  // pinned to its bottom; the categorized groups sit below the fold.
  if (isEmptyState && dockStartersToBottom) {
    return (
      <div
        className={outerClass}
        onDragEnter={dragHandlers.onDragEnter}
        onDragOver={dragHandlers.onDragOver}
        onDragLeave={dragHandlers.onDragLeave}
        onDrop={dragHandlers.onDrop}
      >
        <div className="flex min-h-full flex-col">
          <div className="flex flex-1 flex-col [justify-content:safe_center]">
            <ChatScrollArea
              {...scrollAreaProps}
              bottomOverlayReservePx={bottomOverlayReservePx}
            />
            {renderComposerStack(null)}
          </div>
          {startersSlot && (
            <div className="px-3 pb-3 sm:px-6">
              <div className="mx-auto max-w-[var(--chat-max-width)]">
                {startersSlot}
              </div>
            </div>
          )}
        </div>
        {belowFoldSlot && (
          <div className="px-3 pt-2 pb-8 sm:px-6">
            <div className="mx-auto max-w-[var(--chat-max-width)]">
              {belowFoldSlot}
            </div>
          </div>
        )}
        {dragOverlay}
      </div>
    );
  }

  return (
    <div
      className={outerClass}
      onDragEnter={dragHandlers.onDragEnter}
      onDragOver={dragHandlers.onDragOver}
      onDragLeave={dragHandlers.onDragLeave}
      onDrop={dragHandlers.onDrop}
    >
      <ChatScrollArea
        {...scrollAreaProps}
        bottomOverlayReservePx={bottomOverlayReservePx}
      />

      {!isEmptyState && activeProcessOverlaysSlot && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center gap-2 px-3 pt-2">
          {/* Registry-driven row of active background-process overlays. Order is
              owned by PROCESS_KINDS (subagents, acp runs, workflows, background
              tasks); each overlay self-gates on its own active ids. */}
          {activeProcessOverlaysSlot}
        </div>
      )}

      {renderComposerStack(startersSlot)}
      {dragOverlay}
    </div>
  );
}
