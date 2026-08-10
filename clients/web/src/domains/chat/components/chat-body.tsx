import { useLayoutEffect, type DragEventHandler, type ReactNode } from "react";

import { Paperclip } from "lucide-react";

import { useKeyboardOpen } from "@/hooks/use-keyboard-open";
import { useBannerVisibilityStore } from "@/stores/banner-visibility-store";
import { ChatColumn } from "@/domains/chat/components/chat-column";
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
import { Notice, type NoticeTone } from "@vellumai/design-library";

/**
 * Single composition of a chat panel: a scrollable messages/empty-state
 * area on top, and a composer stack underneath.
 *
 * **Empty‑state centering (LUM-1566):** When the empty state is visible,
 * the outer container becomes a plain `overflow-y-auto` scroll container,
 * an inner `min-h-full` wrapper carries `justify-content: safe center`,
 * and the scroll area drops its `flex-1`. This lets
 * the greeting, composer, and conversation-starter chips center as a
 * single visual group — matching the original centered layout — while
 * the composer **stays at the same position in the React tree** so its
 * state (focus, draft text, attachments) is preserved across the
 * empty→active transition. `safe center` falls back to start-alignment
 * when the group overflows; while the soft keyboard is open the empty
 * state bottom-anchors the group instead so the composer docks to the
 * keyboard edge.
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
 * The component is presentational: all state, handlers, and derived
 * flags are owned by the parent page (its one side effect reports
 * mounted-banner visibility to the shared banner-visibility store).
 * This keeps the chat-body surface framework-agnostic and free of
 * routing or page-level concerns.
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
   * `ChatBody` only positions it.
   */
  composerSlot: ReactNode;

  /**
   * Optional CSS length reserved at the bottom of the panel (applied as
   * `padding-bottom` on the outer container). Used on mobile while the app
   * overlay is minimized to its strip: the strip overlays the bottom of the
   * chat, so the composer lifts above it instead of hiding underneath.
   */
  bottomInset?: string;

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
  isAssistantBusy?: boolean;

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
   * Dismiss handler for {@link genericChatError}. When provided, the banner
   * renders the notice's own dismiss control, leaving the actions row to the
   * error's own actions (typically "Go to Doctor").
   */
  onDismissChatError?: () => void;

  /**
   * Optional pre-rendered banner stack (mobile-app nudge / GitHub / Discord)
   * rendered in flow directly above the composer, so the flex column sizes
   * the transcript around it. Omitted by the app-editing side panel.
   * While mounted (non-empty state), visibility is mirrored into the shared
   * banner-visibility store so tip surfaces can stay mutually exclusive.
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
   * immediately above the composer.
   */
  channelFooterSlot?: ReactNode;

  /**
   * Optional conversation-starter chip grid rendered inside the max-width
   * wrapper directly below the composer. Visible only on the empty state;
   * the parent passes `undefined` once messages arrive. Rendered as a
   * slot (like {@link bannerSlot}) so `ChatBody` stays agnostic of the
   * starter data model.
   */
  startersSlot?: ReactNode;

  /**
   * Optional per-chat plugin-selection pills rendered inside the max-width
   * wrapper directly below the composer and above {@link startersSlot}.
   * Visible only on the empty state; the parent passes `undefined` once
   * messages arrive. Rendered as a slot (like {@link startersSlot}) so
   * `ChatBody` stays agnostic of the plugin data model. While the soft
   * keyboard is open the row fades out and collapses its reserved height
   * (kept mounted) so the composer, not the plugin row, docks to the
   * keyboard edge.
   */
  pluginPillsSlot?: ReactNode;

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
   * While the soft keyboard is open the greeting + composer anchor to the
   * bottom edge and the dock fades out and collapses its reserved height
   * (kept mounted so dismissing the keyboard restores it without a remount).
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

export function ChatBody({
  variant,
  scrollAreaProps,
  composerSlot,
  bottomInset,
  dragHandlers,
  isAttachmentDragOver,
  showScrollToLatest,
  onScrollToLatest,
  isAssistantBusy = false,
  refreshFeedback,
  onDismissRefreshFeedback,
  onRetryRefresh,
  genericChatError,
  onDismissChatError,
  bannerSlot,
  queuedDrawerSlot,
  channelFooterSlot,
  startersSlot,
  pluginPillsSlot,
  belowFoldSlot,
  dockStartersToBottom = false,
  activeProcessOverlaysSlot,
}: ChatBodyProps) {
  const isEmptyState = scrollAreaProps.showEmptyState;
  const keyboardOpen = useKeyboardOpen();
  // Banners (app-download nudge, GitHub star, Discord) show once the user
  // sends a message and the empty state clears. They stay out of the empty
  // state, where the outer container centers greeting + composer + starters
  // as one group and a banner above the composer would split it.
  const bannerRendered = !isEmptyState && Boolean(bannerSlot);

  // When the empty state is visible, center greeting + composer + starters
  // as one group. `safe center` falls back to start-alignment when the
  // content overflows the container. `overflow-y-auto` enables scrolling
  // in that overflow case.
  const baseClass =
    variant === "main"
      ? "relative flex min-h-0 flex-1 flex-col"
      : "relative flex h-full min-h-0 flex-col";

  // While the soft keyboard is open and nothing renders below the composer
  // (`startersSlot` absent: starters have not arrived yet), the plain
  // non-docked empty state bottom-anchors instead of centering so the
  // composer docks to the keyboard edge, and the flip to the docked branch
  // when starters arrive keeps that alignment instead of jumping
  // mid-typing. The app-editing side panel always passes inline starters,
  // so it keeps its centered layout regardless of keyboard state.
  const nonDockedAlignmentClass =
    keyboardOpen && startersSlot == null
      ? "justify-end"
      : "[justify-content:safe_center]";

  // On the empty state the outer container is a plain scroll container.
  // Group alignment lives on an inner `min-h-full` wrapper (the docked
  // branch builds its own): alignment directly on the scroll container
  // would make end-aligned content taller than the viewport overflow past
  // the START edge, where scrolling cannot reach, leaving the greeting
  // unreachable on short viewports while the keyboard is open.
  const outerClass = isEmptyState ? `${baseClass} overflow-y-auto` : baseClass;

  // Inner wrapper for the non-docked layout. On the empty state it fills
  // the first viewport (`min-h-full`) and carries the group alignment; on
  // the active state it is a plain fill wrapper (`min-h-0 flex-1`) so the
  // transcript keeps its height chain. It exists in both states so the
  // composer keeps its tree position across the empty→active transition.
  const nonDockedInnerClass = isEmptyState
    ? `flex min-h-full flex-col ${nonDockedAlignmentClass}`
    : "flex min-h-0 flex-1 flex-col";

  // Mirror the mounted banner — not the candidate slot — into the shared
  // store so tip surfaces stay mutually exclusive with nudge banners.
  // Register/unregister (a count) tolerates concurrent instances (main +
  // side panel) without a last-write-wins race. Layout effect so consumers
  // see the update before paint and never render a frame over the banner.
  const registerVisibleBanner =
    useBannerVisibilityStore.use.registerVisibleBanner();
  const unregisterVisibleBanner =
    useBannerVisibilityStore.use.unregisterVisibleBanner();
  useLayoutEffect(() => {
    if (!bannerRendered) {
      return;
    }
    registerVisibleBanner();
    return unregisterVisibleBanner;
  }, [bannerRendered, registerVisibleBanner, unregisterVisibleBanner]);

  // Shared treatment for the below-composer extras (the starters dock and
  // the plugin pills) while the soft keyboard is open: fade out and collapse
  // the reserved height so the bottom-anchored composer reaches the keyboard
  // edge. Each stays mounted so dismissing the keyboard restores it without
  // a remount, and `inert` removes it from the tab order and the
  // accessibility tree. The inner div clips only while the keyboard is
  // open: the collapse needs the clip, but at rest it would shave the
  // keyboard-focus rings that paint outside the cards and buttons inside
  // the slot.
  const renderKeyboardCollapse = (dataSlot: string, children: ReactNode) => (
    <div
      data-slot={dataSlot}
      inert={keyboardOpen || undefined}
      className={`grid transition-[grid-template-rows,opacity] duration-150${keyboardOpen ? " pointer-events-none opacity-0" : ""}`}
      style={{ gridTemplateRows: keyboardOpen ? "0fr" : "1fr" }}
    >
      <div className={`min-h-0${keyboardOpen ? " overflow-hidden" : ""}`}>
        {children}
      </div>
    </div>
  );

  // Composer stack — stays at the same tree position across the empty→active
  // transition so React preserves its state (focus, draft text, attachments)
  // and iOS Safari does not blur the input on first send (LUM-1506 / LUM-1516).
  // `trailingStarters` lets the docked layout render the starters elsewhere
  // (its own bottom dock) instead of directly below the composer.
  const renderComposerStack = (trailingStarters: ReactNode) => (
    // The banner is a flow child here because it is an opaque full-width
    // card that always occupies its own height: the `flex-1` scroll area
    // then gives back exactly that height at every viewport size, with
    // nothing measured. The pill is the opposite and floats, so it anchors
    // to the top of this group to clear the banner.
    <div className="relative">
      {showScrollToLatest && !isEmptyState && (
        <div className="pointer-events-none absolute inset-x-0 bottom-full z-10 flex justify-center">
          <div className="pointer-events-auto pb-2.5">
            <ScrollToLatestButton
              onClick={onScrollToLatest}
              isAssistantBusy={isAssistantBusy}
            />
          </div>
        </div>
      )}
      {bannerRendered && bannerSlot}
      <ChatColumn
        className="relative pt-1 pb-2 sm:pb-0"
        overlay={
          refreshFeedback && (
            <div className="pointer-events-none absolute inset-x-0 bottom-full z-10 flex justify-center pb-2">
              <RefreshFeedbackPill
                feedback={refreshFeedback}
                onDismiss={onDismissRefreshFeedback}
                onRetry={onRetryRefresh}
              />
            </div>
          )
        }
      >
        {genericChatError && (
          <div className="mb-2">
            <Notice
              tone={genericChatError.tone ?? "error"}
              onDismiss={onDismissChatError}
              actions={genericChatError.actions}
            >
              {genericChatError.message}
            </Notice>
          </div>
        )}
        {queuedDrawerSlot}
        <QuestionPromptSlot />
        {channelFooterSlot}
        <StagedQuotesStrip />
        {composerSlot}
        {pluginPillsSlot &&
          renderKeyboardCollapse(
            "new-chat-plugins",
            <div className="mt-4">{pluginPillsSlot}</div>,
          )}
        {trailingStarters}
      </ChatColumn>
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
        style={bottomInset ? { paddingBottom: bottomInset } : undefined}
        onDragEnter={dragHandlers.onDragEnter}
        onDragOver={dragHandlers.onDragOver}
        onDragLeave={dragHandlers.onDragLeave}
        onDrop={dragHandlers.onDrop}
      >
        <div className="flex min-h-full flex-col">
          {/* While the keyboard is open the group anchors to the bottom edge
              (the shell bottom is the keyboard top), matching the transcript
              layout; otherwise it centers in the first screen. */}
          <div
            className={`flex flex-1 flex-col ${keyboardOpen ? "justify-end" : "[justify-content:safe_center]"}`}
          >
            <ChatScrollArea {...scrollAreaProps} />
            {renderComposerStack(null)}
          </div>
          {startersSlot &&
            renderKeyboardCollapse(
              "docked-starters",
              <ChatColumn className="pb-3">{startersSlot}</ChatColumn>,
            )}
        </div>
        {belowFoldSlot && (
          <ChatColumn className="pt-2 pb-8">{belowFoldSlot}</ChatColumn>
        )}
        {dragOverlay}
      </div>
    );
  }

  return (
    <div
      className={outerClass}
      style={bottomInset ? { paddingBottom: bottomInset } : undefined}
      onDragEnter={dragHandlers.onDragEnter}
      onDragOver={dragHandlers.onDragOver}
      onDragLeave={dragHandlers.onDragLeave}
      onDrop={dragHandlers.onDrop}
    >
      <div className={nonDockedInnerClass}>
        <ChatScrollArea {...scrollAreaProps} />

        {!isEmptyState && activeProcessOverlaysSlot && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center gap-2 px-3 pt-2">
            {/* Registry-driven row of active background-process overlays. The
                caller owns which kinds it covers and their order; each overlay
                self-gates on its own active ids. */}
            {activeProcessOverlaysSlot}
          </div>
        )}

        {renderComposerStack(startersSlot)}
      </div>
      {dragOverlay}
    </div>
  );
}
