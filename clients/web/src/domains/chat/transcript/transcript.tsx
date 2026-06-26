
import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import {
  VirtualList,
  type VirtualListHandle,
} from "@vellumai/design-library/components/virtual-list";

import { partitionLatestTurn } from "@/domains/chat/transcript/partition-latest-turn";
import {
  computePrependDelta,
  findLatestUserAnchorKey,
  PINNED_THRESHOLD_PX,
  type ScrollClassification,
} from "@/domains/chat/transcript/transcript-scroll-utils";
import type {
  MessageItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

import {
  LatestTurnRow,
  type LatestTurnRowProps,
} from "@/domains/chat/transcript/latest-turn-row";
import { PullRefreshSpinner } from "@/domains/chat/transcript/pull-refresh-spinner";
import { TranscriptRow } from "@/domains/chat/transcript/transcript-row";
import { PULL_THRESHOLD_PX } from "@/domains/chat/transcript/pull-to-refresh-utils";
import { usePullToRefresh } from "@/domains/chat/transcript/use-pull-to-refresh";
import { useViewportMinHeight } from "@/domains/chat/transcript/use-viewport-min-height";
import type { ConfirmationDecision } from "@/types/event-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

/** Virtuoso addresses items by an absolute index that survives prepends. We
 *  start high and decrement by the prepended count (see `computePrependDelta`)
 *  so older pages insert at the front without the viewport jumping. */
const FIRST_ITEM_INDEX_BASE = 1_000_000;

/** Constant key for the composite latest-edge row. A stable key preserves the
 *  `LatestTurnRow` memo and the assistant avatar's entrance-spring state across
 *  streaming growth and the no-anchor → anchor transition. */
const LATEST_EDGE_KEY = "latest-edge";

/**
 * Outcome of a pull-to-refresh, returned by the consumer's `onPullRefresh`
 * handler so the page can render the right feedback pill.
 */
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
  scrollCoordinatorState?: Pick<
    ScrollClassification,
    "showScrollToLatest" | "shouldLoadOlder"
  >;
  ref?: Ref<TranscriptHandle>;
}

export interface TranscriptHandle {
  scrollToLatest(opts?: { behavior?: "auto" | "smooth" }): void;
  /** Scroll a message into view by id and briefly highlight it. Returns
   *  `false` when the message is not currently loaded (e.g. it lives in an
   *  older history page that hasn't been fetched). The caller may retry once
   *  the page loads. */
  scrollToMessage(messageId: string): boolean;
  getScrollElement(): HTMLElement | null;
  getViewportHeight(): number;
  /** Debug API: snapshot of the current scroll state (distance from bottom,
   *  pinned-to-latest flag, button visibility, older-page load flag). Reuses
   *  the coordinator's {@link ScrollClassification} shape rather than
   *  re-declaring it. */
  getScrollState(): ScrollClassification;
}

/** A row in the virtual list: either a stable history item, or the single
 *  composite "latest-edge" row (latest user message + its streaming response +
 *  the avatar), which is always last when present. */
type VirtualRow =
  | { type: "history"; item: TranscriptItem }
  | {
      type: "latest-edge";
      anchorMessage: MessageItem | null;
      responseItems: TranscriptItem[];
      hasAvatar: boolean;
    };

/** The shared per-row props forwarded to every `TranscriptRow` /
 *  `LatestTurnRow` — everything the row renderers need except the item
 *  payload itself. */
type RowSharedProps = Omit<
  LatestTurnRowProps,
  "anchorMessage" | "responseItems"
>;

export interface LatestEdgeRowProps {
  /** The latest user message, or `null` for assistant-only history (the
   *  avatar still mounts, but no anchor / min-height / spacer). */
  anchorMessage: MessageItem | null;
  responseItems: TranscriptItem[];
  /** Whether to mount the bottom-pinned assistant avatar slot. */
  hasAvatar: boolean;
  /** Produces the avatar element; only invoked when `hasAvatar`. */
  renderAvatar?: () => ReactNode;
  /** Reserved min-height that pins the anchor to the viewport top while the
   *  response streams into the space below. Applied only when an anchor is
   *  present. */
  viewportMinHeight: number | undefined;
  /** Shared row props forwarded to the inner `LatestTurnRow`. */
  rowProps: RowSharedProps;
}

/**
 * The composite trailing row of the transcript: the latest user message
 * (anchor) + its streaming response + the bottom-pinned assistant avatar,
 * all inside a min-height wrapper. Two layout modes:
 *
 *  1. **Anchor present** — `minHeight: viewportMinHeight` pins the anchor to
 *     the viewport top; the avatar renders below the response; the `flex-1`
 *     spacer fills the remaining space so the latest-edge sentinel sits at
 *     the viewport bottom.
 *  2. **No anchor** (assistant-only history, or first paint before a submit) —
 *     no min-height, no spacer; the avatar appears inline below the last
 *     history item.
 *
 * The avatar is decoupled from the anchor so it persists across the
 * user-send → response gap; the composite's constant row key preserves its
 * `ChatAvatar` entrance-spring state across the no-anchor → anchor flip.
 *
 * A standalone component (rather than inline JSX) so its layout invariants
 * (markers, min-height, child ordering) are unit-testable with
 * `renderToStaticMarkup` — `Transcript` renders through virtuoso, which paints
 * nothing server-side.
 */
export function LatestEdgeRow({
  anchorMessage,
  responseItems,
  hasAvatar,
  renderAvatar,
  viewportMinHeight,
  rowProps,
}: LatestEdgeRowProps) {
  return (
    <div
      className="mx-auto flex w-full max-w-[var(--chat-max-width)] flex-col contain-content px-4 sm:px-6"
      style={anchorMessage ? { minHeight: viewportMinHeight } : undefined}
    >
      {anchorMessage && (
        <LatestTurnRow
          anchorMessage={anchorMessage}
          responseItems={responseItems}
          {...rowProps}
        />
      )}
      {hasAvatar && renderAvatar && (
        <div
          data-latest-assistant-avatar="true"
          className="flex justify-start pl-1 pt-3 pb-2"
        >
          {renderAvatar()}
        </div>
      )}
      {anchorMessage && (
        <div data-latest-edge-spacer="true" className="flex-1" />
      )}
      <div aria-hidden data-latest-edge="true" />
    </div>
  );
}

export function Transcript({
  items,
  conversationId,
  onPullRefresh,
  pullRefreshEnabled,
  ref,
  ...rest
}: TranscriptProps) {
  const virtualListRef = useRef<VirtualListHandle>(null);
  // Virtuoso owns the scroll element. Capture it after mount into state so the
  // viewport-min-height + pull-to-refresh hooks (which expect a ref) re-run
  // once it exists, and again when the list remounts on conversation switch.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const scrollElRef = useMemo(() => ({ current: scrollEl }), [scrollEl]);
  // Pending removal of the transient deep-link highlight class.
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasItems = items.length > 0;
  // Virtuoso exposes its scroller asynchronously (after the initial commit, via
  // its internal scrollerRef), so a single synchronous read here can miss it —
  // leaving `useViewportMinHeight` sized to 0, which collapses the latest-edge
  // pin-to-top reserve. Read synchronously for the fast path, then poll on
  // rAF until the scroller exists. Re-runs on first mount + conversation switch
  // (the list remounts on `key={conversationId}`, yielding a new scroller).
  useLayoutEffect(() => {
    let raf = 0;
    let tries = 0;
    const capture = () => {
      const el = virtualListRef.current?.getScrollElement() ?? null;
      if (el) {
        setScrollEl(el);
      } else if (tries++ < 30) {
        raf = requestAnimationFrame(capture);
      }
    };
    capture();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [conversationId, hasItems]);

  useLayoutEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const viewportMinHeight = useViewportMinHeight(scrollElRef);

  const pullEnabled = !!pullRefreshEnabled && !!onPullRefresh;
  const handlePullRefresh = useCallback(async () => {
    if (!onPullRefresh) return;
    await onPullRefresh();
  }, [onPullRefresh]);
  const pull = usePullToRefresh({
    scrollRef: scrollElRef,
    onRefresh: handlePullRefresh,
    enabled: pullEnabled,
  });

  const partition = useMemo(() => partitionLatestTurn(items), [items]);

  // History rows + a single trailing composite when there's an anchor or an
  // avatar to mount.
  const rows = useMemo<VirtualRow[]>(() => {
    const out: VirtualRow[] = partition.historyItems.map((item) => ({
      type: "history",
      item,
    }));
    if (partition.anchorMessage || rest.renderAvatar) {
      out.push({
        type: "latest-edge",
        anchorMessage: partition.anchorMessage,
        responseItems: partition.responseItems,
        hasAvatar: !!rest.renderAvatar,
      });
    }
    return out;
  }, [partition, rest.renderAvatar]);

  // firstItemIndex: decrement by the prepended history count so older pages
  // insert at the front without the viewport jumping (virtuoso anchors the
  // scroll itself). Derived during render — it must be correct on the prepend
  // frame — and guarded on `items` identity so StrictMode's double-invoke
  // can't double-apply the decrement.
  const firstItemIndexRef = useRef(FIRST_ITEM_INDEX_BASE);
  const prevFirstKeyRef = useRef<string | null>(null);
  const prevHistoryLenRef = useRef(0);
  const prevConversationIdRef = useRef(conversationId);
  const processedItemsRef = useRef<TranscriptItem[] | null>(null);
  if (processedItemsRef.current !== items) {
    if (prevConversationIdRef.current !== conversationId) {
      prevConversationIdRef.current = conversationId;
      firstItemIndexRef.current = FIRST_ITEM_INDEX_BASE;
      prevFirstKeyRef.current = null;
      prevHistoryLenRef.current = 0;
    }
    firstItemIndexRef.current -= computePrependDelta(
      partition.historyItems,
      prevFirstKeyRef.current,
      prevHistoryLenRef.current,
    );
    prevFirstKeyRef.current = partition.historyItems[0]?.key ?? null;
    prevHistoryLenRef.current = partition.historyItems.length;
    processedItemsRef.current = items;
  }
  const firstItemIndex = firstItemIndexRef.current;

  // Map both the server `message.id` (the deep-link + DOM id) and the optimistic
  // `clientMessageId` to a row index, for `scrollToMessage`.
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    const register = (msg: MessageItem | null, index: number) => {
      if (!msg) return;
      map.set(msg.message.id, index);
      if (msg.message.clientMessageId) {
        map.set(msg.message.clientMessageId, index);
      }
    };
    rows.forEach((row, index) => {
      if (row.type === "history") {
        if (row.item.kind === "message") register(row.item, index);
      } else {
        // The composite renders the anchor user message AND the latest turn's
        // response messages (inside LatestTurnRow), so a deep link to the
        // latest assistant reply must resolve to this row too — not just the
        // anchor. All of them map to the single latest-edge row index; the
        // post-scroll `#msg-<id>` highlight then targets the exact node.
        register(row.anchorMessage, index);
        for (const resp of row.responseItems) {
          if (resp.kind === "message") register(resp, index);
        }
      }
    });
    return map;
  }, [rows]);

  useImperativeHandle(
    ref,
    (): TranscriptHandle => ({
      scrollToLatest(opts) {
        virtualListRef.current?.scrollToBottom({
          behavior: opts?.behavior ?? "auto",
        });
      },
      scrollToMessage(messageId) {
        const index = indexById.get(messageId);
        if (index === undefined) return false;
        virtualListRef.current?.scrollToIndex({
          index,
          behavior: "smooth",
          align: "center",
        });
        // Virtuoso scrolls (smoothly), then mounts the target row only once the
        // scroll reaches it — for a far target that can take several hundred ms.
        // Poll on a time budget (not a fixed frame count) so the highlight still
        // lands: the render-everything predecessor highlighted reliably because
        // every row was always in the DOM, and we preserve that.
        const highlightStart = performance.now();
        const tryHighlight = () => {
          const target = document.getElementById(`msg-${messageId}`);
          if (target) {
            target.classList.add("message-highlighted");
            if (highlightTimerRef.current) {
              clearTimeout(highlightTimerRef.current);
            }
            highlightTimerRef.current = setTimeout(() => {
              target.classList.remove("message-highlighted");
              highlightTimerRef.current = null;
            }, 2000);
            return;
          }
          if (performance.now() - highlightStart < 2500) {
            requestAnimationFrame(tryHighlight);
          }
        };
        requestAnimationFrame(tryHighlight);
        return true;
      },
      getScrollElement() {
        return virtualListRef.current?.getScrollElement() ?? null;
      },
      getViewportHeight() {
        return virtualListRef.current?.getScrollElement()?.clientHeight ?? 0;
      },
      getScrollState() {
        const el = virtualListRef.current?.getScrollElement() ?? null;
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
          shouldLoadOlder: rest.scrollCoordinatorState?.shouldLoadOlder ?? false,
        };
      },
    }),
    [indexById, rest.scrollCoordinatorState],
  );

  // Submit pin: when a new user message becomes the anchor, align the composite
  // (last row) to the viewport top — the min-height wrapper reserves a viewport
  // of space below it for the streaming response. Skipped on conversation
  // switch, where the remount + initialTopMostItemIndex="LAST" handle position.
  const prevAnchorKeyRef = useRef<string | null>(
    findLatestUserAnchorKey(items),
  );
  const prevConvForPinRef = useRef(conversationId);
  useLayoutEffect(() => {
    const anchorKey = findLatestUserAnchorKey(items);
    if (prevConvForPinRef.current !== conversationId) {
      prevConvForPinRef.current = conversationId;
      prevAnchorKeyRef.current = anchorKey;
      return;
    }
    if (
      anchorKey !== null &&
      anchorKey !== prevAnchorKeyRef.current &&
      rows.length > 0
    ) {
      virtualListRef.current?.scrollToIndex({
        index: rows.length - 1,
        align: "start",
        behavior: "auto",
      });
    }
    prevAnchorKeyRef.current = anchorKey;
  }, [items, conversationId, rows.length]);

  const rowProps = {
    conversationId,
    onSurfaceAction: rest.onSurfaceAction,
    onForkConversation: rest.onForkConversation,
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

  const renderAvatar = rest.renderAvatar;

  const itemContent = (_index: number, row: VirtualRow): ReactNode => {
    if (row.type === "history") {
      return (
        <div className="mx-auto w-full max-w-[var(--chat-max-width)] contain-content px-4 sm:px-6">
          <TranscriptRow item={row.item} {...rowProps} />
        </div>
      );
    }
    // Latest-edge region — see {@link LatestEdgeRow} for the two layout modes.
    return (
      <LatestEdgeRow
        anchorMessage={row.anchorMessage}
        responseItems={row.responseItems}
        hasAvatar={row.hasAvatar}
        renderAvatar={renderAvatar}
        viewportMinHeight={viewportMinHeight}
        rowProps={rowProps}
      />
    );
  };

  const computeItemKey = useCallback(
    (_index: number, row: VirtualRow): string =>
      row.type === "history" ? row.item.key : LATEST_EDGE_KEY,
    [],
  );

  return (
    <VirtualList<VirtualRow>
      key={conversationId}
      ref={virtualListRef}
      items={rows}
      itemContent={itemContent}
      computeItemKey={computeItemKey}
      firstItemIndex={firstItemIndex}
      initialTopMostItemIndex="LAST"
      increaseViewportBy={{ top: 200, bottom: 0 }}
      className="h-full w-full overscroll-none [overflow-anchor:none]"
      footer={
        pullEnabled ? (
          <PullRefreshSpinner
            height={pull.pullDistance}
            progress={pull.pullDistance / PULL_THRESHOLD_PX}
            phase={pull.phase}
          />
        ) : undefined
      }
    />
  );
}
