
import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { partitionLatestTurn } from "@/domains/chat/transcript/partition-latest-turn";
import type { TranscriptItem } from "@/domains/chat/transcript/types";

import { LatestTurnRow } from "@/domains/chat/transcript/latest-turn-row";
import { PullRefreshSpinner } from "@/domains/chat/transcript/pull-refresh-spinner";
import { TranscriptRow } from "@/domains/chat/transcript/transcript-row";
import { PULL_THRESHOLD_PX } from "@/domains/chat/transcript/pull-to-refresh-utils";
import { usePullToRefresh } from "@/domains/chat/transcript/use-pull-to-refresh";
import { useViewportMinHeight } from "@/domains/chat/transcript/use-viewport-min-height";
import type { ConfirmationDecision } from "@/types/event-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

/** Distance from the bottom (in px) at or below which the transcript is
 *  considered pinned to the latest message. Surfaced through
 *  `TranscriptHandle.getScrollState()` for the debug API. Kept in sync
 *  with the same threshold inside `useTranscriptScroll`. */
const PINNED_THRESHOLD_PX = 64;

/** Outcome of a pull-to-refresh, returned by the consumer's
 *  `onPullRefresh` handler so the page can render the right feedback
 *  pill. */
export type RefreshOutcome =
  | { kind: "no-change" }
  | { kind: "new-messages"; count: number }
  | { kind: "error"; message?: string };

export interface TranscriptProps {
  items: TranscriptItem[];
  conversationId: string | null;
  assistantDisplayName?: string | null;
  onSurfaceAction: (
    surfaceId: string,
    action: string,
    input?: unknown,
  ) => void;
  /** Callback for "Fork from here" from a message's hover actions. */
  onForkConversation?: (messageId: string) => void;
  /** Callback for "Summarize up to here" from a message's hover actions. */
  onSummarizeUpToHere?: (messageId: string) => void;
  /** Callback for "Inspect" from a message's hover actions. */
  onInspectMessage?: (messageId: string) => void;

  /** Render-prop for `kind: "onboardingChoice"` items. Onboarding depends
   *  on props from the parent (sendMessage, didOnboarding, etc.) and has a
   *  different lifecycle than interaction prompts, so it stays as a
   *  render-prop for now. */
  renderOnboardingChoice?: () => ReactNode;
  /** Click handler on a tool-call risk badge — opens the rule editor. The
   *  ToolCallChip forwards the active tool-call's metadata so the modal can
   *  pre-fill its fields. */
  onOpenRuleEditor?: (context: {
    toolName: string;
    riskLevel?: string;
    riskReason?: string;
    input?: Record<string, unknown>;
    allowlistOptions: import("@/types/interaction-ui-types").AllowlistOption[];
    scopeOptions: import("@/types/interaction-ui-types").ScopeOption[];
    directoryScopeOptions: import("@/types/interaction-ui-types").DirectoryScopeOption[];
  }) => void;
  /** Set of tool-call ids that should display the "command not recognized"
   *  nudge below their chip. */
  unknownNudgeToolCallIds?: Set<string>;
  /** Dismiss handler for an unknown-nudge entry. */
  onDismissUnknownNudge?: (toolCallId: string) => void;
  /** Callback when the user clicks Allow or Deny on an inline confirmation. */
  onConfirmationSubmit?: (
    decision: ConfirmationDecision,
    toolCall: ChatMessageToolCall,
  ) => void | Promise<void>;
  /** Callback when the user picks "Allow & Create Rule" from the split button. */
  onAllowAndCreateRule?: (toolCall: ChatMessageToolCall) => void | Promise<void>;
  onOpenApp?: (appId: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  /** Forwarded to inline app surfaces so they can render live preview iframes. */
  assistantId?: string | null;
  /** Click handler when the user clicks the "open timeline" button on an
   *  inline subagent progress card. */
  onSubagentClick?: (subagentId: string) => void;
  /** Callback to abort/stop a running subagent from an inline card. */
  onStopSubagent?: (subagentId: string) => void;
  /** Click handler when the user opens the workflow detail panel from an
   *  inline workflow run card. */
  onWorkflowClick?: (runId: string) => void;
  /** Callback to abort/stop a running workflow from an inline card. */
  onStopWorkflow?: (runId: string) => void;
  /** Optional render-prop that produces the chat avatar element to mount
   *  at the bottom of the conversation. Rendered inside the latest-edge
   *  region so the avatar pins to the bottom of the viewport while the
   *  anchor user message pins to the top — regardless of whether the
   *  latest turn has an anchor message at all. A function — rather than
   *  a `ReactNode` — lets callers compute lazily and gives them a stable
   *  identity via `useCallback`. Called once per render inside
   *  `Transcript`. */
  renderAvatar?: () => ReactNode;
  /** Optional async refresh hook. When provided AND
   *  `pullRefreshEnabled` is `true`, mounts a pull-to-refresh
   *  gesture on the scroll container. The gesture only triggers when
   *  the user is at the visual bottom (latest message) on a touch
   *  device. Resolve with the outcome so the caller can render
   *  appropriate feedback. */
  onPullRefresh?: () => Promise<RefreshOutcome>;
  /** Whether the pull-to-refresh gesture is enabled (feature-flag
   *  gated). When `false`, no spinner element renders and no touch
   *  listeners attach. */
  pullRefreshEnabled?: boolean;
  /** Scroll coordinator state snapshot for debug API inspection. Optional —
   *  when omitted, getScrollState() falls back to defaults. `isPinned`
   *  is derived from scroll geometry inside `getScrollState()` rather
   *  than passed in. */
  scrollCoordinatorState?: {
    showScrollToLatest: boolean;
    shouldLoadOlder: boolean;
  };
}

export interface TranscriptHandle {
  scrollToLatest(opts?: { behavior?: "auto" | "smooth" }): void;
  /** Scroll a message into view by id and briefly highlight it. Returns
   *  `false` when no element with that message id is currently rendered (e.g.
   *  the message lives in an older history page not yet loaded). */
  scrollToMessage(messageId: string): boolean;
  getScrollElement(): HTMLDivElement | null;
  /** Inner wrapper that surrounds all rendered children. Sized to the
   *  scroll content; observable via `ResizeObserver` to detect when
   *  scroll content height changes (e.g. async min-height settling,
   *  late image loads, streaming growth). */
  getContentElement(): HTMLDivElement | null;
  getViewportHeight(): number;
  /** Debug API: snapshot of the current scroll state (distance from bottom,
   *  pinned-to-latest flag, button visibility, older-page load flag). */
  getScrollState(): {
    distanceFromBottom: number;
    isPinned: boolean;
    showScrollToLatest: boolean;
    shouldLoadOlder: boolean;
  };
}

export const Transcript = forwardRef<TranscriptHandle, TranscriptProps>(
  function Transcript(props, ref) {
    const { items, conversationId, onPullRefresh, pullRefreshEnabled, ...rest } =
      props;
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    // Pending removal of the transient deep-link highlight class.
    const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportMinHeight = useViewportMinHeight(scrollRef);

    useEffect(() => {
      return () => {
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      };
    }, []);

    const pullEnabled = !!pullRefreshEnabled && !!onPullRefresh;
    const handlePullRefresh = useCallback(async () => {
      if (!onPullRefresh) return;
      await onPullRefresh();
    }, [onPullRefresh]);
    const pull = usePullToRefresh({
      scrollRef,
      onRefresh: handlePullRefresh,
      enabled: pullEnabled,
    });


    const partition = useMemo(() => partitionLatestTurn(items), [items]);

    useImperativeHandle(
      ref,
      (): TranscriptHandle => ({
        scrollToLatest(opts) {
          const el = scrollRef.current;
          if (!el) return;
          el.scrollTo({
            top: el.scrollHeight - el.clientHeight,
            behavior: opts?.behavior ?? "auto",
          });
        },
        scrollToMessage(messageId) {
          const target = document.getElementById(`msg-${messageId}`);
          if (!target) return false;
          target.scrollIntoView({ block: "center", behavior: "smooth" });
          target.classList.add("message-highlighted");
          if (highlightTimerRef.current) {
            clearTimeout(highlightTimerRef.current);
          }
          highlightTimerRef.current = setTimeout(() => {
            target.classList.remove("message-highlighted");
            highlightTimerRef.current = null;
          }, 2000);
          return true;
        },
        getScrollElement() {
          return scrollRef.current;
        },
        getContentElement() {
          return contentRef.current;
        },
        getViewportHeight() {
          return scrollRef.current?.clientHeight ?? 0;
        },
        getScrollState() {
          const el = scrollRef.current;
          if (!el) {
            return {
              distanceFromBottom: 0,
              isPinned: true,
              showScrollToLatest: false,
              shouldLoadOlder: false,
            };
          }
          const distanceFromBottom = Math.max(
            0,
            el.scrollHeight - el.clientHeight - el.scrollTop,
          );
          return {
            distanceFromBottom,
            isPinned: distanceFromBottom <= PINNED_THRESHOLD_PX,
            showScrollToLatest: rest.scrollCoordinatorState?.showScrollToLatest ?? false,
            shouldLoadOlder: rest.scrollCoordinatorState?.shouldLoadOlder ?? false,
          };
        },
      }),
      [rest.scrollCoordinatorState],
    );

    const rowProps = {
      conversationId,
      onSurfaceAction: rest.onSurfaceAction,
      onForkConversation: rest.onForkConversation,
      onSummarizeUpToHere: rest.onSummarizeUpToHere,
      onInspectMessage: rest.onInspectMessage,
      renderOnboardingChoice: rest.renderOnboardingChoice,
      assistantDisplayName: rest.assistantDisplayName,
      onOpenRuleEditor: rest.onOpenRuleEditor,
      unknownNudgeToolCallIds: rest.unknownNudgeToolCallIds,
      onDismissUnknownNudge: rest.onDismissUnknownNudge,
      onConfirmationSubmit: rest.onConfirmationSubmit,
      onAllowAndCreateRule: rest.onAllowAndCreateRule,
      onOpenApp: rest.onOpenApp,
      onOpenDocument: rest.onOpenDocument,
      assistantId: rest.assistantId,
      onSubagentClick: rest.onSubagentClick,
      onStopSubagent: rest.onStopSubagent,
      onWorkflowClick: rest.onWorkflowClick,
      onStopWorkflow: rest.onStopWorkflow,
    };

    return (
      <div
        key={conversationId}
        ref={scrollRef}
        data-testid="transcript-scroll-container"
        className="flex h-full w-full flex-col overflow-y-auto overscroll-none [overflow-anchor:none]"
      >
        {/* Inner content wrapper — observed by the scroll coordinator's
         *  ResizeObserver so we can re-pin to bottom when scroll content
         *  height changes (async min-height settle, late image loads,
         *  streaming growth). Wrapping all rows in a single observed
         *  element is cheaper than observing each row individually. */}
        <div ref={contentRef} className="flex w-full flex-col">
          {/* History items in chronological order — oldest at top. */}
          {partition.historyItems.map((item) => (
            <Fragment key={item.key}>
              <div className="mx-auto w-full max-w-[var(--chat-max-width)] contain-content px-4 sm:px-6">
                <TranscriptRow item={item} {...rowProps} />
              </div>
            </Fragment>
          ))}
          {/* Latest-edge region: contains the latest-turn cluster and the
           *  assistant avatar. Two layout modes:
           *
           *  1. Anchor present — `minHeight: viewportMinHeight` pins the
           *     anchor user message to the viewport top. The avatar
           *     renders directly below the response items so it follows
           *     the conversation flow visually. The `flex-1` spacer then
           *     fills the remaining vertical space so the latest-edge
           *     sentinel sits at the bottom of the viewport (preserving
           *     the bottom-pin scroll target).
           *  2. No anchor (assistant-only history, e.g. recovered
           *     conversation or first paint before a submit) — neither
           *     the viewport-height min-height NOR the flex-1 spacer
           *     render. The avatar appears inline directly below the
           *     last history item.
           *
           *  Key invariant: the avatar always sits directly below the
           *  most recent assistant content. No giant empty gap between
           *  the response and the avatar. The spacer is purely a layout
           *  device to keep the latest-edge sentinel at the viewport
           *  bottom for the anchor-pinning UX — it must NOT push the
           *  avatar away from its content.
           *
           *  The avatar is intentionally decoupled from `partition.anchorMessage`
           *  so it persists across the user-send → response gap AND across the
           *  "no user message yet" case. The wrapper renders whenever either
           *  the anchor or avatar slot is active; DOM identity (and ChatAvatar
           *  entrance-spring state) is preserved across the no-anchor → anchor
           *  transition because React's reconciler tracks `fiber.index` (see
           *  the `transcript.test.tsx` regression test). */}
          {(partition.anchorMessage || rest.renderAvatar) && (
            <div
              className="mx-auto flex w-full max-w-[var(--chat-max-width)] flex-col contain-content px-4 sm:px-6"
              style={
                partition.anchorMessage
                  ? { minHeight: viewportMinHeight }
                  : undefined
              }
            >
              {partition.anchorMessage && (
                <LatestTurnRow
                  anchorMessage={partition.anchorMessage}
                  responseItems={partition.responseItems}
                  {...rowProps}
                />
              )}
              {rest.renderAvatar && (
                <div
                  data-latest-assistant-avatar="true"
                  className="flex justify-start pl-1 pt-3 pb-2"
                >
                  {rest.renderAvatar()}
                </div>
              )}
              {partition.anchorMessage && (
                <div data-latest-edge-spacer="true" className="flex-1" />
              )}
              <div aria-hidden data-latest-edge="true" />
            </div>
          )}
          {/* Spinner last = visual bottom in flex-col. Only rendered when
           *  the gesture is feature-flag-enabled so the flag-off path has
           *  zero DOM impact. */}
          {pullEnabled && (
            <PullRefreshSpinner
              height={pull.pullDistance}
              progress={pull.pullDistance / PULL_THRESHOLD_PX}
              phase={pull.phase}
            />
          )}
        </div>
      </div>
    );
  },
);
