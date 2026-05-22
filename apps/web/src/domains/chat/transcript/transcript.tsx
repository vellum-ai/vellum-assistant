
import {
  Fragment,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { SubagentProgressCard } from "@/domains/chat/components/subagent-progress-card.js";
import type { SubagentEntry } from "@/domains/subagents/subagent-store.js";
import { partitionLatestTurn } from "@/domains/chat/transcript/partition-latest-turn.js";
import type { TranscriptItem } from "@/domains/chat/transcript/types.js";

import { LatestTurnRow } from "@/domains/chat/transcript/latest-turn-row.js";
import { PullRefreshSpinner } from "@/domains/chat/transcript/pull-refresh-spinner.js";
import { TranscriptRow } from "@/domains/chat/transcript/transcript-row.js";
import {
  PULL_THRESHOLD_PX,
  usePullToRefresh,
} from "@/domains/chat/transcript/use-pull-to-refresh.js";
import { useViewportMinHeight } from "@/domains/chat/transcript/use-viewport-min-height.js";
import type { ConfirmationDecision } from "@/domains/chat/api/event-types.js";

/** Outcome of a pull-to-refresh, returned by the consumer's
 *  `onPullRefresh` handler so the page can render the right feedback
 *  pill. */
export type RefreshOutcome =
  | { kind: "no-change" }
  | { kind: "new-messages"; count: number }
  | { kind: "error"; message?: string };

export interface TranscriptProps {
  items: TranscriptItem[];
  assistantDisplayName?: string | null;
  onSecretSubmit: (requestId: string, value: string) => void;
  onConfirmationDecision: (requestId: string, decision: string) => void;
  onSurfaceAction: (
    surfaceId: string,
    action: string,
    input?: unknown,
  ) => void;
  onRetryError: () => void;
  /** Callback for "Fork from here" from a message's hover actions. */
  onForkConversation?: (messageId: string) => void;
  /** Callback for "Inspect" from a message's hover actions. */
  onInspectMessage?: (messageId: string) => void;
  /** Persistent expanded tool-call ids. Optional — the Transcript owns its
   *  own set if not provided. Callers that need cross-render persistence
   *  should pass a stable ref. */
  expandedToolCallIds?: Set<string>;
  /** Optional renderer for `kind: "pendingSecret"` items. PR 7 passes the
   *  real `SecretPromptCard` here. */
  renderPendingSecret?: (requestId: string) => ReactNode;
  /** Optional renderer for `kind: "pendingConfirmation"` items. PR 7 passes
   *  the real `ConfirmationPromptCard` here. */
  renderPendingConfirmation?: (requestId: string) => ReactNode;
  /** Optional renderer for `kind: "pendingContactRequest"` items. */
  renderPendingContactRequest?: (requestId: string) => ReactNode;
  /** Optional renderer for `kind: "onboardingChoice"` items. */
  renderOnboardingChoice?: () => ReactNode;
  /** Click handler on a tool-call risk badge — opens the rule editor. The
   *  ToolCallChip forwards the active tool-call's metadata so the modal can
   *  pre-fill its fields. */
  onOpenRuleEditor?: (context: {
    toolName: string;
    riskLevel?: string;
    riskReason?: string;
    input?: Record<string, unknown>;
    allowlistOptions: import("@/domains/chat/api/event-types.js").AllowlistOption[];
    scopeOptions: import("@/domains/chat/api/event-types.js").ScopeOption[];
    directoryScopeOptions: import("@/domains/chat/api/event-types.js").DirectoryScopeOption[];
  }) => void;
  /** Set of tool-call ids that should display the "command not recognized"
   *  nudge below their chip. */
  unknownNudgeToolCallIds?: Set<string>;
  /** Dismiss handler for an unknown-nudge entry. */
  onDismissUnknownNudge?: (toolCallId: string) => void;
  /** Whether the confirmation action is currently being submitted. */
  isSubmittingConfirmation?: boolean;
  /** Callback when the user clicks Allow or Deny on an inline confirmation. */
  onConfirmationSubmit?: (decision: ConfirmationDecision) => void;
  /** Callback when the user picks "Allow & Create Rule" from the split button. */
  onAllowAndCreateRule?: () => void;
  /** The tool call id that currently has the active pending confirmation.
   *  Only the matching chip renders the inline confirmation UI. */
  pendingConfirmationToolCallId?: string;
  onOpenApp?: (appId: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  /** Forwarded to inline app surfaces so they can render live preview iframes. */
  assistantId?: string | null;
  /** Ordered subagent entries to render via SubagentProgressCard on assistant
   *  messages. When empty or undefined, no progress card renders. */
  subagentEntries?: SubagentEntry[];
  /** Click handler when the user clicks a subagent row in the progress card. */
  onSubagentClick?: (subagentId: string) => void;
  /** Callback to abort/stop a running subagent. */
  onStopSubagent?: (subagentId: string) => void;
  /** Optional render-prop that produces the chat avatar element to mount
   *  at the bottom of the latest assistant cluster (forwarded to
   *  `LatestTurnRow`'s `avatarSlot`). A function — rather than a
   *  `ReactNode` — lets callers avoid constructing the element when
   *  there is no latest turn, and gives them a stable identity via
   *  `useCallback`. Called once per render inside `Transcript`. */
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
   *  when omitted, getScrollState() returns a default "not pinned" state. */
  scrollCoordinatorState?: {
    isPinnedToLatest: boolean;
    showScrollToLatest: boolean;
    shouldLoadOlder: boolean;
  };
}

export interface TranscriptHandle {
  scrollToLatest(opts?: { behavior?: "auto" | "smooth" }): void;
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
    const { items, onPullRefresh, pullRefreshEnabled, ...rest } = props;
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const viewportMinHeight = useViewportMinHeight(scrollRef);

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

    const [ownedExpandedToolCallIds] = useState(() => new Set<string>());
    const effectiveExpandedToolCallIds =
      rest.expandedToolCallIds ?? ownedExpandedToolCallIds;

    const [expandedCardIds] = useState(() => new Map<string, boolean>());

    const partition = useMemo(() => partitionLatestTurn(items), [items]);

    const subagentsByParent = useMemo(() => {
      if (!rest.subagentEntries?.length) return null;

      // Build a reverse lookup from daemon message UUID → item key (stableId).
      // Used to resolve subagent entries reconstructed from history where
      // parentMessageId (stable UUID) is set but parentMessageStableId
      // (ephemeral, regenerated each load) won't match.
      const messageIdToItemKey = new Map<string, string>();
      for (const item of items) {
        if (item.kind === "message" && item.message.id) {
          messageIdToItemKey.set(item.message.id, item.key);
        }
      }

      const groups = new Map<string, SubagentEntry[]>();
      for (const entry of rest.subagentEntries) {
        const itemKey =
          entry.parentMessageStableId ??
          (entry.parentMessageId
            ? messageIdToItemKey.get(entry.parentMessageId)
            : undefined);
        if (!itemKey) continue;
        const list = groups.get(itemKey) ?? [];
        list.push(entry);
        groups.set(itemKey, list);
      }
      return groups.size > 0 ? groups : null;
    }, [rest.subagentEntries, items]);

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
            isPinned: rest.scrollCoordinatorState?.isPinnedToLatest ?? true,
            showScrollToLatest: rest.scrollCoordinatorState?.showScrollToLatest ?? false,
            shouldLoadOlder: rest.scrollCoordinatorState?.shouldLoadOlder ?? false,
          };
        },
      }),
      [rest.scrollCoordinatorState],
    );

    const rowProps = {
      expandedToolCallIds: effectiveExpandedToolCallIds,
      expandedCardIds,
      onSurfaceAction: rest.onSurfaceAction,
      onSecretSubmit: rest.onSecretSubmit,
      onConfirmationDecision: rest.onConfirmationDecision,
      onRetryError: rest.onRetryError,
      onForkConversation: rest.onForkConversation,
      onInspectMessage: rest.onInspectMessage,
      renderPendingSecret: rest.renderPendingSecret,
      renderPendingConfirmation: rest.renderPendingConfirmation,
      renderPendingContactRequest: rest.renderPendingContactRequest,
      renderOnboardingChoice: rest.renderOnboardingChoice,
      assistantDisplayName: rest.assistantDisplayName,
      onOpenRuleEditor: rest.onOpenRuleEditor,
      unknownNudgeToolCallIds: rest.unknownNudgeToolCallIds,
      onDismissUnknownNudge: rest.onDismissUnknownNudge,
      isSubmittingConfirmation: rest.isSubmittingConfirmation,
      onConfirmationSubmit: rest.onConfirmationSubmit,
      onAllowAndCreateRule: rest.onAllowAndCreateRule,
      pendingConfirmationToolCallId: rest.pendingConfirmationToolCallId,
      onOpenApp: rest.onOpenApp,
      onOpenDocument: rest.onOpenDocument,
      assistantId: rest.assistantId,
    };

    return (
      <div
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
                {item.kind === "message" &&
                  subagentsByParent?.get(item.key) &&
                  rest.onSubagentClick && (
                    <SubagentProgressCard
                      entries={subagentsByParent.get(item.key)!}
                      onSubagentClick={rest.onSubagentClick}
                      onStopSubagent={rest.onStopSubagent}
                    />
                  )}
              </div>
            </Fragment>
          ))}
          {/* LatestTurnRow last = visual bottom in flex-col. */}
          {partition.anchorMessage && (
            <div className="mx-auto w-full max-w-[var(--chat-max-width)] contain-content px-4 sm:px-6">
              <LatestTurnRow
                anchorMessage={partition.anchorMessage}
                responseItems={partition.responseItems}
                viewportMinHeight={viewportMinHeight}
                avatarSlot={rest.renderAvatar ? rest.renderAvatar() : undefined}
                subagentsByParent={subagentsByParent}
                onSubagentClick={rest.onSubagentClick}
                onStopSubagent={rest.onStopSubagent}
                {...rowProps}
              />
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
