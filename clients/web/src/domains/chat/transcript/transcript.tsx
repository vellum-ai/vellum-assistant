import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type ReactNode,
} from "react";

import { writeSelectionClipboard } from "@vellumai/design-library";

import { partitionLatestTurn } from "@/domains/chat/transcript/partition-latest-turn";
import { resolveResponseArtifacts } from "@/domains/chat/transcript/resolve-response-artifacts";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";

import { keepFocusedFieldVisible } from "@/domains/chat/transcript/focused-field";
import { LatestTurnRow } from "@/domains/chat/transcript/latest-turn-row";
import { PullRefreshSpinner } from "@/domains/chat/transcript/pull-refresh-spinner";
import { TranscriptColumn } from "@/domains/chat/transcript/transcript-column";
import { TranscriptRow } from "@/domains/chat/transcript/transcript-row";
import { useAcpConnectInlineToolUseId } from "@/domains/chat/hooks/use-acp-connect-placement";
import { PULL_THRESHOLD_PX } from "@/domains/chat/transcript/pull-to-refresh-utils";
import { usePullToRefresh } from "@/domains/chat/transcript/use-pull-to-refresh";
import { useContentAboveViewport } from "@/domains/chat/transcript/use-content-above-viewport";
import { useHideIdleScrollbar } from "@/domains/chat/transcript/use-hide-idle-scrollbar";
import { useViewportMinHeight } from "@/domains/chat/transcript/use-viewport-min-height";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { ConfirmationDecision } from "@/types/event-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ModeSessionDescriptor } from "@vellumai/assistant-api";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import {
  groupSessionItems,
  sameSessionGroupIdentity,
  type SessionGroupedTranscriptItem,
  type SessionGroupSegment,
  type SessionGroupIdentity,
} from "@/domains/chat/transcript/group-session-items";
import {
  useSessionDisclosureState,
  type SessionDisclosureState,
} from "@/domains/chat/transcript/use-session-disclosure-state";
import { useSessionDurationClock } from "@/domains/chat/transcript/use-session-duration-clock";
import {
  SessionGroupRow,
  SessionGroupContinuation,
  type SessionGroupMode,
} from "@/domains/chat/transcript/session-group-row";
import type { SessionGroupSummaryInput } from "@/domains/chat/transcript/session-group-summary";
import { LatestTurnResponse } from "@/domains/chat/transcript/latest-turn-response";
import { isActivityLive } from "@/domains/chat/turn-store";
import { messageItemIdentityIds } from "@/domains/chat/transcript/transcript-message-identity";

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
  modeSessionDescriptors?: ModeSessionDescriptor[];
  sessionDisclosureState?: SessionDisclosureState;
  /** Deterministic story/test override. Production reads the assistant flag. */
  sessionGroupsEnabled?: boolean;
  sessionClockConnected?: boolean;
  /** Deterministic story/test override for live summary time. */
  sessionClockNow?: number;
  onBeforeSessionDisclosureToggle?: () => void;
  assistantDisplayName?: string | null;
  onSurfaceAction: (surfaceId: string, action: string, input?: unknown) => void;
  /** Callback for "Fork from here" from a message's hover actions. */
  onForkConversation?: (messageId: string) => void;
  /** Callback for "Summarize up to here" from a message's hover actions. */
  onSummarizeUpToHere?: (messageId: string) => void;
  /** Callback for "Retry" from the latest assistant message's hover actions. */
  onRetryLatestTurn?: () => void;
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
  onAllowAndCreateRule?: (
    toolCall: ChatMessageToolCall,
  ) => void | Promise<void>;
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

const MODE_PRESENTATION: Record<
  SessionGroupSegment["modeSession"]["mode"],
  SessionGroupMode
> = {
  computer_use: "computerUse",
  browser: "browser",
  live_vision: "liveVision",
  ambient: "ambient",
};

interface SegmentHistory {
  conversationId: string | null;
  segments: SessionGroupIdentity[];
}

function sameSegmentHistory(
  left: readonly SessionGroupIdentity[],
  right: readonly SessionGroupIdentity[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) =>
      sameSessionGroupIdentity(segment, right[index]!),
    )
  );
}

function segmentSummaryInput(
  segment: SessionGroupSegment,
  descriptor: ModeSessionDescriptor,
  now: number | null,
  connected: boolean,
): SessionGroupSummaryInput {
  const { summary, runtimeState } = descriptor;
  const isTail = segment.containsLastBoundary;
  let state: SessionGroupSummaryInput["state"];
  if (!isTail) {
    state = "settledSegment";
  } else if (summary.status !== "active") {
    state = summary.status;
  } else {
    state = connected ? (runtimeState ?? "working") : "disconnected";
  }
  return {
    state,
    startedAt: segment.containsFirstBoundary
      ? (summary.firstIncludedAt ?? segment.firstActivityAt)
      : segment.firstActivityAt,
    lastActivityAt: isTail ? summary.lastActivityAt : segment.lastActivityAt,
    endedAt: isTail ? summary.endedAt : segment.lastActivityAt,
    now,
  };
}

function segmentLiveState(
  segment: SessionGroupSegment | undefined,
  descriptor: ModeSessionDescriptor | undefined,
) {
  return segment?.containsLastBoundary &&
    descriptor?.summary.status === "active"
    ? (descriptor.runtimeState ?? "working")
    : null;
}

function isClockEligible(
  segment: SessionGroupSegment | undefined,
  descriptor: ModeSessionDescriptor | undefined,
) {
  const state = segmentLiveState(segment, descriptor);
  return state === "working" || state === "waiting";
}

function SessionSegment({
  segment,
  descriptor,
  disclosure,
  children,
  onBeforeToggle,
  clockConnected = true,
  clockNow,
  continuationId,
  spaceBefore,
}: {
  segment?: SessionGroupSegment;
  descriptor?: ModeSessionDescriptor;
  disclosure: SessionDisclosureState;
  children: ReactNode;
  onBeforeToggle?: () => void;
  clockConnected?: boolean;
  clockNow?: number;
  continuationId?: string;
  spaceBefore?: boolean;
}) {
  const open = segment
    ? disclosure.isSessionOpen(segment.modeSession.id)
    : true;
  const clockEligible = isClockEligible(segment, descriptor);
  const tickingNow = useSessionDurationClock(
    clockNow === undefined && clockConnected && clockEligible,
  );
  const now = clockNow ?? tickingNow;
  return (
    <SessionGroupRow
      mode={
        segment ? MODE_PRESENTATION[segment.modeSession.mode] : "computerUse"
      }
      summary={
        segment && descriptor
          ? segmentSummaryInput(
              segment,
              descriptor,
              clockConnected ? now : null,
              clockConnected,
            )
          : { state: "unavailable" }
      }
      open={open}
      onOpenChange={(nextOpen) => {
        if (!segment) {
          return;
        }
        onBeforeToggle?.();
        disclosure.setSessionOpen(segment.modeSession.id, nextOpen);
      }}
      headerVisible={Boolean(segment && descriptor)}
      continuationId={continuationId}
      spaceBefore={spaceBefore}
    >
      {children}
    </SessionGroupRow>
  );
}

export interface TranscriptHandle {
  scrollToLatest(opts?: { behavior?: "auto" | "smooth" }): void;
  /** Scroll a message into view by id and briefly highlight it. Returns
   *  `false` when no element with that message id is currently rendered (e.g.
   *  the message lives in an older history page not yet loaded). */
  scrollToMessage(messageId: string): boolean;
  /** Reveal a loaded message hidden by a default-closed session, then invoke
   * the callback after the open state commits. Explicit user closes win. */
  revealMessage?(messageId: string, onRevealed: () => void): boolean;
  /** If a text field inside the transcript holds focus, scroll it just far
   *  enough to stay visible and report `true`, so a caller can skip a pin that
   *  would scroll past it. Reports `false` when focus is anywhere else. */
  keepFocusedFieldVisible(): boolean;
  getScrollElement(): HTMLDivElement | null;
  /** Inner wrapper that surrounds all rendered children. Sized to the
   *  scroll content; observable via `ResizeObserver` to detect when
   *  scroll content height changes (e.g. async min-height settling,
   *  late image loads, streaming growth). */
  getContentElement(): HTMLDivElement | null;
  getViewportHeight(): number;
  getRenderedMessageIds?(): string[];
  /** Debug API: snapshot of the current scroll state (distance from bottom,
   *  pinned-to-latest flag, button visibility, older-page load flag). */
  getScrollState(): {
    distanceFromBottom: number;
    isPinned: boolean;
    showScrollToLatest: boolean;
    shouldLoadOlder: boolean;
  };
}

/**
 * Copy the selected transcript as semantic HTML and markdown.
 *
 * The browser's own `text/html` flavor inlines the computed style of every
 * selected node, so a transcript copied out of the app pastes into Gmail or
 * Outlook carrying the chat's own background color, text color, and font
 * size. Its `text/plain` flavor is a flat dump that drops every marker the
 * reader could see.
 *
 * The handler sits on the scroll container rather than on each message
 * because one assistant turn is several sibling blocks (prose, diagrams,
 * tool cards) and a drag over "the message" routinely covers more than the
 * rendered markdown. `MarkdownMessage` keeps its own handler for the
 * selection that stays inside one message; whichever runs first wins, and
 * both write the same flavors.
 */
function handleTranscriptCopy(event: ReactClipboardEvent<HTMLDivElement>) {
  if (
    !event.defaultPrevented &&
    event.clipboardData &&
    writeSelectionClipboard(event.clipboardData, event.currentTarget)
  ) {
    event.preventDefault();
  }
}

export const Transcript = forwardRef<TranscriptHandle, TranscriptProps>(
  function Transcript(props, ref) {
    const {
      items,
      conversationId,
      modeSessionDescriptors = [],
      sessionDisclosureState,
      sessionGroupsEnabled,
      onPullRefresh,
      pullRefreshEnabled,
      ...rest
    } = props;
    const configuredSessionGroups =
      useAssistantFeatureFlagStore.use.sessionGroups();
    const sessionGroupsOn = sessionGroupsEnabled ?? configuredSessionGroups;
    const fallbackDisclosure = useSessionDisclosureState(
      conversationId,
      sessionGroupsOn,
    );
    const disclosure = sessionDisclosureState ?? fallbackDisclosure;
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const latestEdgeSpacerRef = useRef<HTMLDivElement | null>(null);
    const sessionContinuationId = useId();
    // Pending removal of the transient deep-link highlight class.
    const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const pendingRevealRef = useRef<{
      sessionId: string;
      onRevealed: () => void;
    } | null>(null);
    const viewportMinHeight = useViewportMinHeight(scrollRef);
    const hideIdleScrollbar = useHideIdleScrollbar(
      scrollRef,
      contentRef,
      latestEdgeSpacerRef,
    );
    // Phone layouts give the transcript the whole screen, with the header
    // directly over its top edge and no gutter between the two. Whatever the
    // keyboard and the composer push past that edge would otherwise be cut mid
    // line, so on mobile the edge fades instead. Desktop frames the panel in
    // its own padding and needs none of it.
    const isMobile = useIsMobile();
    const showTopFade = useContentAboveViewport(
      scrollRef,
      isMobile,
      conversationId,
    );

    useEffect(() => {
      return () => {
        if (highlightTimerRef.current) {
          clearTimeout(highlightTimerRef.current);
        }
      };
    }, []);

    const pullEnabled = !!pullRefreshEnabled && !!onPullRefresh;
    const handlePullRefresh = useCallback(async () => {
      if (!onPullRefresh) {
        return;
      }
      await onPullRefresh();
    }, [onPullRefresh]);
    const pull = usePullToRefresh({
      scrollRef,
      onRefresh: handlePullRefresh,
      enabled: pullEnabled,
    });

    const partition = useMemo(() => partitionLatestTurn(items), [items]);
    const descriptorsById = useMemo(() => {
      if (!sessionGroupsOn) {
        return new Map<string, ModeSessionDescriptor>();
      }
      return new Map(
        modeSessionDescriptors.map((descriptor) => [
          descriptor.summary.id,
          descriptor,
        ]),
      );
    }, [modeSessionDescriptors, sessionGroupsOn]);
    const summariesById = useMemo(() => {
      if (!sessionGroupsOn) {
        return new Map();
      }
      return new Map(
        modeSessionDescriptors.map((descriptor) => [
          descriptor.summary.id,
          descriptor.summary,
        ]),
      );
    }, [modeSessionDescriptors, sessionGroupsOn]);
    const [segmentHistory, setSegmentHistory] = useState<SegmentHistory>({
      conversationId,
      segments: [],
    });
    const previousSegments = useMemo(
      () =>
        segmentHistory.conversationId === conversationId
          ? segmentHistory.segments
          : [],
      [conversationId, segmentHistory],
    );
    const grouped = useMemo(() => {
      if (!sessionGroupsOn || !conversationId) {
        return {
          history: partition.historyItems as SessionGroupedTranscriptItem[],
          latest: [
            ...(partition.anchorMessage ? [partition.anchorMessage] : []),
            ...partition.responseItems,
          ] as SessionGroupedTranscriptItem[],
        };
      }
      const getModeSession = (message: DisplayMessage) => message.modeSession;
      const getActivityBounds = (message: DisplayMessage) => ({
        firstActivityAt:
          message.modeSessionActivity?.firstAt ?? message.timestamp ?? null,
        lastActivityAt:
          message.modeSessionActivity?.lastAt ?? message.timestamp ?? null,
      });
      const projected = groupSessionItems({
        items,
        conversationId,
        summariesById,
        getModeSession,
        getActivityBounds,
        previousSegments,
      });
      const anchor = partition.anchorMessage;
      const latestIndex = anchor
        ? projected.findIndex((item) =>
            item.kind === "sessionGroup"
              ? item.items.includes(anchor)
              : item === anchor,
          )
        : -1;
      return latestIndex === -1
        ? { history: projected, latest: [] }
        : {
            history: projected.slice(0, latestIndex),
            latest: projected.slice(latestIndex),
          };
    }, [
      conversationId,
      items,
      partition,
      previousSegments,
      sessionGroupsOn,
      summariesById,
    ]);
    const firstLatest = grouped.latest[0];
    const anchorGroup =
      firstLatest?.kind === "sessionGroup" &&
      firstLatest.items.includes(partition.anchorMessage!)
        ? firstLatest
        : null;
    const anchorGroupIndex = anchorGroup
      ? anchorGroup.items.indexOf(partition.anchorMessage!)
      : -1;
    const anchorVisible =
      partition.anchorMessage &&
      (!anchorGroup || disclosure.isSessionOpen(anchorGroup.modeSession.id));
    const avatarFollowsSession =
      sessionGroupsOn &&
      (grouped.latest.length > 0 ? grouped.latest : grouped.history).findLast(
        (item) => item.kind !== "thinking" || item.active,
      )?.kind === "sessionGroup";
    useEffect(() => {
      const segments = sessionGroupsOn
        ? [...grouped.history, ...grouped.latest]
            .filter(
              (item): item is SessionGroupSegment =>
                item.kind === "sessionGroup",
            )
            .map(
              ({
                key,
                modeSession,
                rawMemberMessageIds,
                memberMessageIds,
              }) => ({
                key,
                modeSession,
                rawMemberMessageIds,
                memberMessageIds,
              }),
            )
        : [];
      setSegmentHistory((current) => {
        if (
          current.conversationId === conversationId &&
          sameSegmentHistory(current.segments, segments)
        ) {
          return current;
        }
        return { conversationId, segments };
      });
    }, [conversationId, grouped, sessionGroupsOn]);
    const sessionByMemberId = useMemo(() => {
      const result = new Map<string, string>();
      if (!sessionGroupsOn) {
        return result;
      }
      for (const item of [...grouped.history, ...grouped.latest]) {
        if (item.kind !== "sessionGroup") {
          continue;
        }
        for (const memberId of item.memberMessageIds) {
          result.set(memberId, item.modeSession.id);
        }
      }
      return result;
    }, [grouped, sessionGroupsOn]);
    const domMessageIdByIdentity = useMemo(() => {
      const result = new Map<string, string>();
      if (!sessionGroupsOn) {
        return result;
      }
      for (const item of items) {
        if (item.kind !== "message") {
          continue;
        }
        for (const identity of messageItemIdentityIds(item)) {
          result.set(identity, item.message.id);
        }
      }
      return result;
    }, [items, sessionGroupsOn]);
    useLayoutEffect(() => {
      const pending = pendingRevealRef.current;
      if (!pending || !disclosure.isSessionOpen(pending.sessionId)) {
        return;
      }
      pendingRevealRef.current = null;
      pending.onRevealed();
    }, [disclosure, grouped]);
    const latestHistoryMessage = partition.anchorMessage
      ? undefined
      : partition.historyItems.findLast((item) => item.kind === "message");

    // A document the thread changed earns one reopen link, at the end of the
    // response that first reached it. Not one per message that wrote to it,
    // and not another one each time a later response writes to it again.
    // Resolved here because this is where the flat item list is read as turns;
    // the in-flight response is withheld until the turn settles,
    // `awaiting_user_input` included, so a paused turn never reads as finished.
    const turnPhase = useTurnStore.use.phase();
    const turnActive = isSending(turnPhase);
    const responseArtifactsByKey = useMemo(
      () => resolveResponseArtifacts(items, { turnActive, conversationId }),
      [items, turnActive, conversationId],
    );

    useImperativeHandle(
      ref,
      (): TranscriptHandle => ({
        scrollToLatest(opts) {
          const el = scrollRef.current;
          if (!el) {
            return;
          }
          el.scrollTo({
            top: el.scrollHeight - el.clientHeight,
            behavior: opts?.behavior ?? "auto",
          });
        },
        scrollToMessage(messageId) {
          const target = document.getElementById(
            `msg-${domMessageIdByIdentity.get(messageId) ?? messageId}`,
          );
          if (!target) {
            const sessionId = sessionByMemberId.get(messageId);
            if (sessionId) {
              disclosure.setSessionOpen(sessionId, true);
            }
            return false;
          }
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
        revealMessage(messageId, onRevealed) {
          const sessionId = sessionByMemberId.get(messageId);
          if (
            !sessionId ||
            disclosure.isSessionOpen(sessionId) ||
            disclosure.isSessionExplicitlyClosed?.(sessionId)
          ) {
            return false;
          }
          pendingRevealRef.current = { sessionId, onRevealed };
          disclosure.setSessionOpen(sessionId, true);
          return true;
        },
        keepFocusedFieldVisible() {
          return keepFocusedFieldVisible(scrollRef.current);
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
        getRenderedMessageIds() {
          const content = contentRef.current;
          if (!content) {
            return [];
          }
          return [...content.querySelectorAll<HTMLElement>("[data-message-id]")]
            .map((element) => element.dataset.messageId)
            .filter((id): id is string => Boolean(id));
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
            showScrollToLatest:
              rest.scrollCoordinatorState?.showScrollToLatest ?? false,
            shouldLoadOlder:
              rest.scrollCoordinatorState?.shouldLoadOlder ?? false,
          };
        },
      }),
      [
        disclosure,
        domMessageIdByIdentity,
        rest.scrollCoordinatorState,
        sessionByMemberId,
      ],
    );

    // One read for the whole transcript; rows take the answer as a prop.
    const acpConnectInlineToolUseId = useAcpConnectInlineToolUseId();

    const rowProps = {
      conversationId,
      acpConnectInlineToolUseId,
      onSurfaceAction: rest.onSurfaceAction,
      onForkConversation: rest.onForkConversation,
      onSummarizeUpToHere: rest.onSummarizeUpToHere,
      onRetryLatestTurn: rest.onRetryLatestTurn,
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
    const renderHistoryRows = (rows: SessionGroupSegment["items"]) =>
      rows.map((item) => (
        <TranscriptRow
          key={item.key}
          item={item}
          {...rowProps}
          responseArtifacts={responseArtifactsByKey.get(item.key)}
          isLatestMessage={item === latestHistoryMessage}
        />
      ));
    const renderGroupedHistoryItem = (
      item: SessionGroupedTranscriptItem,
      index: number,
    ) => {
      if (item.kind === "sessionGroup") {
        const descriptor = descriptorsById.get(item.modeSession.id);
        if (descriptor) {
          return (
            <TranscriptColumn key={item.key}>
              <SessionSegment
                segment={item}
                spaceBefore={
                  grouped.history[index - 1]?.kind !== "sessionGroup"
                }
                descriptor={descriptor}
                disclosure={disclosure}
                onBeforeToggle={rest.onBeforeSessionDisclosureToggle}
                clockConnected={rest.sessionClockConnected}
                clockNow={rest.sessionClockNow}
                continuationId={
                  item === anchorGroup ? sessionContinuationId : undefined
                }
              >
                {renderHistoryRows(
                  item === anchorGroup
                    ? item.items.slice(0, anchorGroupIndex)
                    : item.items,
                )}
              </SessionSegment>
            </TranscriptColumn>
          );
        }
        return (
          <TranscriptColumn key={item.key}>
            {renderHistoryRows(item.items)}
          </TranscriptColumn>
        );
      }
      return (
        <TranscriptColumn key={item.key}>
          <TranscriptRow
            item={item}
            {...rowProps}
            responseArtifacts={responseArtifactsByKey.get(item.key)}
            isLatestMessage={item === latestHistoryMessage}
          />
        </TranscriptColumn>
      );
    };
    const latestMessageItem = [
      ...(partition.anchorMessage ? [partition.anchorMessage] : []),
      ...partition.responseItems,
    ].findLast((item) => item.kind === "message");
    const latestStreaming = isActivityLive(turnPhase);
    const renderLatestRows = (rows: SessionGroupSegment["items"]) => {
      const anchorIndex = rows.indexOf(partition.anchorMessage!);
      return rows.map((item, index) => (
        <TranscriptRow
          key={item.key}
          item={item}
          {...rowProps}
          responseArtifacts={responseArtifactsByKey.get(item.key)}
          isStreaming={latestStreaming && index > anchorIndex}
          isLatestMessage={item === latestMessageItem}
        />
      ));
    };
    const renderGroupedLatest = () => {
      const hasSegment = grouped.latest.some(
        (item) => item.kind === "sessionGroup",
      );
      if (!hasSegment && partition.anchorMessage) {
        return (
          <>
            <TranscriptRow
              item={partition.anchorMessage}
              {...rowProps}
              isLatestMessage={!latestMessageItem}
            />
            <SessionSegment
              key="latest-session-shell"
              disclosure={disclosure}
              clockConnected={rest.sessionClockConnected}
              clockNow={rest.sessionClockNow}
            >
              <LatestTurnResponse
                responseItems={partition.responseItems}
                {...rowProps}
                responseArtifactsByKey={responseArtifactsByKey}
                isStreaming={latestStreaming}
              />
            </SessionSegment>
          </>
        );
      }
      return grouped.latest.map((item, index) => {
        if (item.kind === "sessionGroup") {
          if (item === anchorGroup) {
            return (
              <SessionGroupContinuation
                key={item.key}
                id={sessionContinuationId}
                mode={MODE_PRESENTATION[item.modeSession.mode]}
                open={disclosure.isSessionOpen(item.modeSession.id)}
              >
                {renderLatestRows(item.items.slice(anchorGroupIndex))}
              </SessionGroupContinuation>
            );
          }
          const descriptor = descriptorsById.get(item.modeSession.id);
          if (descriptor) {
            const preservesLatestResponse =
              !item.items.includes(partition.anchorMessage!) &&
              item.items.length === partition.responseItems.length &&
              item.items.every(
                (row, index) => row === partition.responseItems[index],
              );
            return (
              <SessionSegment
                key={
                  preservesLatestResponse ? "latest-session-shell" : item.key
                }
                segment={item}
                spaceBefore={
                  (grouped.latest[index - 1] ?? grouped.history.at(-1))
                    ?.kind !== "sessionGroup"
                }
                descriptor={descriptor}
                disclosure={disclosure}
                onBeforeToggle={rest.onBeforeSessionDisclosureToggle}
                clockConnected={rest.sessionClockConnected}
                clockNow={rest.sessionClockNow}
              >
                {preservesLatestResponse ? (
                  <LatestTurnResponse
                    responseItems={partition.responseItems}
                    {...rowProps}
                    responseArtifactsByKey={responseArtifactsByKey}
                    isStreaming={latestStreaming}
                  />
                ) : (
                  renderLatestRows(item.items)
                )}
              </SessionSegment>
            );
          }
          return (
            <Fragment key={item.key}>{renderLatestRows(item.items)}</Fragment>
          );
        }
        return (
          <TranscriptRow
            key={item.key}
            item={item}
            {...rowProps}
            responseArtifacts={responseArtifactsByKey.get(item.key)}
            isStreaming={latestStreaming}
            isLatestMessage={item === latestMessageItem}
          />
        );
      });
    };

    return (
      <div
        key={conversationId}
        ref={scrollRef}
        data-testid="transcript-scroll-container"
        onCopy={handleTranscriptCopy}
        className={`flex h-full w-full flex-col overflow-y-auto overscroll-none [overflow-anchor:none] ${
          hideIdleScrollbar
            ? "[&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
            : ""
        }`}
      >
        {/* Inner content wrapper — observed by the scroll coordinator's
         *  ResizeObserver so we can re-pin to bottom when scroll content
         *  height changes (async min-height settle, late image loads,
         *  streaming growth). Wrapping all rows in a single observed
         *  element is cheaper than observing each row individually. */}
        <div ref={contentRef} className="flex w-full flex-col">
          {showTopFade && (
            /* One line's worth of the canvas over the top edge, so the lines
             * leaving through it fade rather than end. Sticky keeps it on the
             * edge while the transcript scrolls under it, and the negative
             * margin keeps it out of the content height the scroll coordinator
             * measures. Out of the way of anything aimed at the message it
             * covers, and out of the accessibility tree. */
            <div
              aria-hidden
              data-slot="transcript-top-fade"
              className="pointer-events-none sticky top-0 z-10 -mb-7 h-7 w-full shrink-0 bg-gradient-to-b from-[var(--surface-base)] to-transparent"
            />
          )}
          {/* History items in chronological order — oldest at top. In the
           *  no-anchor mode (assistant-only history, e.g. recovered
           *  conversation) the avatar renders directly below the history
           *  list, so its last message-kind item is the "latest message"
           *  (Retry attaches there). Trailing non-message rows (thinking
           *  slot, pending prompts, ephemeral meta) carry no trailer, so
           *  the flag skips past them. With an anchor present the latest
           *  turn owns the flag instead (see `LatestTurnRow`). */}
          {grouped.history.map(renderGroupedHistoryItem)}
          {anchorGroup
            ? renderGroupedHistoryItem(anchorGroup, grouped.history.length)
            : null}
          {/* Latest-edge region: contains the latest-turn cluster and the
           *  assistant avatar. Two layout modes:
           *
           *  1. Anchor visible: `minHeight: viewportMinHeight` pins the
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
            <TranscriptColumn
              className="flex flex-col"
              minHeight={anchorVisible ? viewportMinHeight : undefined}
            >
              {partition.anchorMessage && !sessionGroupsOn && (
                <LatestTurnRow
                  anchorMessage={partition.anchorMessage}
                  responseItems={partition.responseItems}
                  {...rowProps}
                  responseArtifactsByKey={responseArtifactsByKey}
                />
              )}
              {partition.anchorMessage && sessionGroupsOn
                ? renderGroupedLatest()
                : null}
              {rest.renderAvatar && (
                <div
                  data-latest-assistant-avatar="true"
                  data-copy-exclude
                  className={`flex justify-start pl-1 pb-2 ${avatarFollowsSession ? "pt-0" : "pt-3"} ${
                    sessionGroupsOn
                      ? "transition-[padding-top] duration-300 ease-out motion-reduce:transition-none"
                      : ""
                  }`}
                >
                  {rest.renderAvatar()}
                </div>
              )}
              {partition.anchorMessage && (
                <div
                  ref={latestEdgeSpacerRef}
                  data-latest-edge-spacer="true"
                  className="flex-1"
                />
              )}
              <div aria-hidden data-latest-edge="true" />
            </TranscriptColumn>
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
