/**
 * Dev-facing chat debug API surfaced on `window._vellumDebug.chat`.
 *
 * Designed for in-the-moment inspection when a chat-streaming bug shows
 * up — open DevTools, call `window._vellumDebug.chat.getClientMessages()`
 * to see the message rows the chat page is rendering,
 * `.getTranscriptItems()` to see the full virtualized row list (messages
 * plus trailers like thinking / pending interactions), `.forceReconcile()`
 * to imperatively run /v1/history reconcile, and `.serverMessages()` to
 * fetch the raw `/v1/history` message list (so you can diff against
 * `getClientMessages()` by hand in the console when a turn looks stuck).
 *
 * Attached unconditionally (no query-param gating) so the API is
 * available in dev, staging, and production builds. The implementation
 * is a thin consumer of state already tracked elsewhere (refs in
 * ChatPage) — it adds no new background work and no
 * production-path overhead beyond a global property assignment.
 *
 * The namespace is intentionally nested under `_vellumDebug` so other
 * areas of the app (sync, gateway, telemetry) can hang their own
 * sub-objects off the same root without colliding.
 */

import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";

import * as assistantApi from "@vellumai/assistant-api";
import {
  type ChatDebugEventsApi,
  eventsDebugApi,
} from "@/domains/chat/api/debug-api";
import {
  fetchConversationMessages as defaultFetchConversationMessages,
  type RuntimeMessage,
} from "@/domains/chat/api/messages";
import type { ChatEventStream } from "@/domains/chat/api/stream";
import type {
  PendingConfirmationState,
  PendingContactRequestState,
  PendingQuestionState,
  PendingSecretState,
} from "@/types/interaction-ui-types";
import { recordChatDiagnostic } from "@/domains/chat/utils/diagnostics";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation";
import { setTranscriptScrollControllerEnabled } from "@/domains/chat/transcript/transcript-scroll-flag";
import { setImpersonatedAssistantVersion } from "@/lib/backwards-compat/impersonate-version-flag";
import {
  classifyScrollPosition,
  type TranscriptHandle,
} from "@/domains/chat/transcript/use-deprecated-transcript-scroll";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import {
  type TerminalReason,
  type TurnPhase,
  type TurnState,
  isSending,
  isThinking,
} from "@/domains/messaging/turn-store";
import {
  type UIContext,
  shouldShowThinkingIndicator,
} from "@/domains/messaging/turn-selectors";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-condition snapshot returned by {@link ChatDebugApi.thinkingIndicator}.
 *
 * Each boolean is one of the AND-clauses inside {@link shouldShowThinkingIndicator}
 * (or its inverse, when the predicate negates the field). When `visible` is
 * `false`, callers can scan {@link ChatDebugThinkingIndicator.failingConditions}
 * to see exactly which clauses blocked the indicator.
 */
export interface ChatDebugThinkingConditions {
  /** {@link isSending} — phase is queued/thinking/streaming/awaiting_user_input. */
  isSending: boolean;
  /** {@link isThinking} — phase === "thinking". */
  isThinking: boolean;
  /** activeConversationIsProcessing && hasPendingAssistantResponse — restores
   *  the indicator after a conversation switch. */
  restoredProcessing: boolean;
  /** Number of in-flight tool calls. Predicate requires `=== 0`. */
  activeToolCallCount: number;
  /** Daemon-provided activity label (e.g. "Processing bash results"). */
  statusText: string | null;
  /** Pending-prompt gates from the UI context. */
  hasPendingSecret: boolean;
  hasPendingConfirmation: boolean;
  hasPendingQuestion: boolean;
  hasPendingContactRequest: boolean;
  hasUncompletedVisibleSurface: boolean;
  hasStreamingAssistantMessage: boolean;
  activeConversationIsProcessing: boolean;
  hasPendingAssistantResponse: boolean;
}

/**
 * "Done" signal block — describes where the turn sits in its lifecycle so a
 * developer can tell at a glance whether the assistant has finished, errored,
 * or is still active. Mirrors the terminal-state machinery in
 * `turn-store.ts` and the daemon-emitted `assistant_activity_state`
 * events.
 */
export interface ChatDebugThinkingDoneSignal {
  /** True iff the turn reducer has reached a terminal state (idle/errored
   *  with no active turn id). */
  terminal: boolean;
  /** Current turn phase. */
  phase: TurnPhase;
  /** Last terminal reason recorded by the reducer. `null` if the turn is
   *  still active or has never terminated since mount. */
  lastTerminalReason: TerminalReason;
  /** Human-readable summary of the current lifecycle state — what we'd say
   *  to a developer asking "why isn't this turn done?" or "why is it done?". */
  explanation: string;
}

/**
 * Snapshot returned by {@link ChatDebugApi.listPendingInteractions}.
 *
 * Mirrors the user-facing slice of the `interactions` domain's Zustand
 * store — the prompts the UI is actually rendering (or just dismissed)
 * plus their submission flags. This is the frontend-tracked view of
 * "what's waiting on the user right now", not the server's pending-list,
 * so it's the source of truth for triaging stuck-prompt bugs (the class
 * of issue that triggered ATL-652).
 *
 * Returned as a plain object so it serializes cleanly in DevTools and
 * doesn't expose the live Zustand reference.
 */
export interface PendingInteractionsSnapshot {
  pendingSecret: PendingSecretState | null;
  isSubmittingSecret: boolean;
  pendingConfirmation: PendingConfirmationState | null;
  isSubmittingConfirmation: boolean;
  pendingContactRequest: PendingContactRequestState | null;
  isSubmittingContactRequest: boolean;
  pendingQuestion: PendingQuestionState | null;
  isSubmittingQuestion: boolean;
  /** True while the question card is hidden but `pendingQuestion` is set —
   *  the composer free-text intercept still routes to `submitQuestionResponse`. */
  isQuestionCardDismissed: boolean;
  /** Tool-call id paired with the currently-rendered inline confirmation,
   *  or `null` when no inline confirmation is active. */
  inlineConfirmationToolCallId: string | null;
}

/** Result of {@link ChatDebugApi.thinkingIndicator}. */
export interface ChatDebugThinkingIndicator {
  /** Live evaluation of {@link shouldShowThinkingIndicator}. */
  visible: boolean;
  /** Raw turn-state snapshot at evaluation time. */
  turnState: TurnState;
  /** Raw UI-context snapshot at evaluation time. */
  uiContext: UIContext;
  /** Per-clause evaluation of the predicate. */
  conditions: ChatDebugThinkingConditions;
  /** Names of the clauses currently blocking visibility. Empty when
   *  `visible` is true. */
  failingConditions: string[];
  /** Lifecycle / terminal-state signal — answers "is the assistant done?". */
  done: ChatDebugThinkingDoneSignal;
}

/**
 * Snapshot of scroll geometry + classification returned by
 * {@link ChatDebugApi.getScrollState}.
 *
 * Reads through `transcriptRef` + `getScrollPagination` supplied to
 * {@link useChatDebugApi} from ChatPage. When the transcript isn't
 * mounted yet, the snapshot reports `scrollTop === null` and a
 * diagnosis that explains the absence.
 *
 * Designed to triage ATL-644 — "why can't I scroll up to older
 * messages?" — without opening a profiler.
 */
export interface ChatDebugScrollState {
  /** ISO timestamp of when the snapshot was captured. */
  capturedAt: string;

  /** Raw DOM metrics — null when the scroll element is not mounted. */
  scrollTop: number | null;
  scrollHeight: number | null;
  clientHeight: number | null;

  /** Computed distances — null when raw metrics are unavailable. */
  distanceFromBottom: number | null;
  distanceFromTop: number | null;

  /** Classification — null when raw metrics are unavailable. */
  isPinnedToLatest: boolean | null;
  showScrollToLatest: boolean | null;

  /** Pagination context from React state (always available). */
  hasMore: boolean;
  isLoadingOlder: boolean;
  itemCount: number;

  /**
   * Whether the current geometry + pagination would trigger a load-older
   * fetch. True when we are near the top, more pages exist, and nothing is
   * already in flight.
   */
  shouldLoadOlder: boolean;

  /** Human-readable summary for DevTools quick diagnosis. */
  diagnosis: string;
}

/** The dev API surface attached to `window._vellumDebug.chat`. */
export interface ChatDebugApi {
  /**
   * Return up to `limit` chat messages currently held in memory, in the
   * exact shape the UI consumes (`DisplayMessage`). The last row is the
   * current visual bottom of the chat's message list.
   *
   * No bespoke projection — this is the same array
   * {@link buildTranscriptItems} reads, so what you see in DevTools is
   * what the UI sees. Each message carries `content`, `textSegments`,
   * `toolCalls`, `surfaces`, and `contentOrder` as-is; cross-reference
   * `contentOrder` against the entity arrays to reconstruct render order
   * (the same lookup the transcript performs in
   * `transcript-message-body.tsx`).
   *
   * For the full virtualized row list — including non-message rows like
   * the thinking indicator, pending prompts, and the queued-marker —
   * use {@link getTranscriptItems}.
   */
  getClientMessages(limit?: number): DisplayMessage[];
  /**
   * Return the full transcript-item array the virtualized list iterates
   * — messages, the thinking indicator, pending-interaction rows, the
   * queued-marker, error notices, the onboarding-choice row.
   *
   * `getClientMessages()` returns only the `DisplayMessage[]` slice;
   * `getTranscriptItems()` returns the discriminated union of every
   * row kind that maps 1:1 to a virtualized DOM row. Use this when
   * triaging "why is the thinking indicator stuck below my message" or
   * "the pending-secret card disappeared" — those questions live at the
   * `TranscriptItem` layer, not the message layer.
   *
   * No bespoke projection — same reference the render path passes to
   * `<Transcript />`. Populated by `chat-route-content.tsx` right after
   * the `useMemo(() => buildTranscriptItems(...))`.
   */
  getTranscriptItems(): TranscriptItem[];
  /**
   * Live evaluation of the thinking-indicator predicate
   * ({@link shouldShowThinkingIndicator}) plus turn-state lifecycle info.
   *
   * Use this to answer two questions when triaging "indicator stuck"
   * reports (ATL-654 et al.):
   *   1. Is the assistant done? See `.done` (terminal/phase/lastTerminalReason).
   *   2. Why are the `...` showing — or not showing? See `.visible` and
   *      `.failingConditions` for the AND-clauses that blocked visibility.
   *
   * Synchronous, side-effect-free; reads the same turn-store + UI-context
   * snapshot the React render path reads, so the result matches what the
   * UI is computing on this frame.
   */
  thinkingIndicator(): ChatDebugThinkingIndicator;
  /**
   * [experimental] Imperatively trigger a reconcile of the active conversation
   * against `/v1/history`. Returns the same shape as the watchdog /
   * resume / cache-restore reconcile paths. Subject to change.
   */
  forceReconcile(): Promise<ReconcileActiveConversationResult>;
  /**
   * [experimental] Fetch `/v1/history` for the active assistant +
   * conversation and return the raw server-side message list. Does
   * not touch UI state — diff against `getClientMessages()` manually in
   * the console when you need to declare drift. Throws if there's no
   * active assistant/conversation context. Subject to change.
   */
  serverMessages(): Promise<RuntimeMessage[]>;
  /**
   * Return the frontend-tracked pending interactions — the user prompts
   * currently rendered (or recently dismissed) by the chat UI, plus their
   * submission flags. Reads the `interactions` domain's Zustand store
   * via a getter ref supplied at the composition root, so the chat
   * domain never imports the interactions store directly.
   *
   * Use this to triage "ask-question card stuck" / "confirmation didn't
   * resolve" reports (the bug class that triggered ATL-652): the snapshot
   * tells you what the UI thinks is pending, independent of what the
   * server's pending-interactions endpoint says.
   *
   * Synchronous and side-effect-free.
   */
  listPendingInteractions(): PendingInteractionsSnapshot;
  /**
   * Snapshot of scroll position, geometry, and classification for the
   * active transcript container. Answers: "why can't I scroll up to
   * older messages?" (ATL-644).
   *
   * - If `scrollTop === null`, the transcript isn't mounted.
   * - If `isPinnedToLatest === true`, the UI thinks you're at the bottom.
   * - If `shouldLoadOlder === true` but `isLoadingOlder === false`,
   *   we're near the top yet the fetch isn't firing — investigate the
   *   scroll handler.
   * - If `hasMore === false`, the server reports no more history.
   */
  getScrollState(): ChatDebugScrollState;
  /** Print help for this API. Log-only, returns undefined. */
  help(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_CLIENT_MESSAGES_LIMIT = 20;
const ROOT_NS = "_vellumDebug";
const CHAT_NS = "chat";
const FLAGS_NS = "flags";

/**
 * Refs the API reads to surface client state and trigger actions. All are
 * `MutableRefObject` because the API holds them across the lifetime of
 * the chat page and reads them lazily on each call — capturing the
 * current value at install time would freeze the API to the initial render.
 */
export interface ChatDebugRefs {
  messagesRef: MutableRefObject<DisplayMessage[]>;
  /**
   * Post-`sanitizeDisplayMessages` snapshot. Populated by
   * `chat-route-content.tsx` and read by `getClientMessages()`.
   */
  sanitizedMessagesRef: MutableRefObject<DisplayMessage[]>;
  /**
   * Output of `buildTranscriptItems` — the virtualized row list.
   * Populated by `chat-route-content.tsx` and read by
   * `getTranscriptItems()`.
   */
  transcriptItemsRef: MutableRefObject<TranscriptItem[]>;
  /**
   * Ref to the mounted `<Transcript />` imperative handle. Used by
   * {@link ChatDebugApi.getScrollState} to read scroll geometry directly
   * from the DOM. `current` is null when no chat route is mounted.
   */
  transcriptRef: { current: TranscriptHandle | null };
  streamContextRef: MutableRefObject<{
    assistantId: string;
    conversationId: string;
  } | null>;
  streamRef: MutableRefObject<ChatEventStream | null>;
  streamEpochRef: MutableRefObject<number>;
  activeConversationIdRef: MutableRefObject<string | null>;
  /**
   * Reads the latest transcript pagination state (`hasMore`,
   * `isLoadingOlder`) for {@link ChatDebugApi.getScrollState}. Held as a
   * getter rather than a ref because pagination lives in React state
   * (useState) in ChatPage, not in a dedicated ref.
   */
  getScrollPagination: () => { hasMore: boolean; isLoadingOlder: boolean };
  /**
   * Reads the current assistantId. Held as a getter rather than a ref
   * because the value lives in a hook return value in ChatPage, not in
   * a dedicated ref.
   */
  getAssistantId: () => string | null;
  /**
   * Reads the current {@link TurnState}. Held as a getter rather than a
   * ref because the turn state lives in a Zustand store
   * (`useTurnStore.getState()`), not a React ref. The store fields are
   * a superset of `TurnState`, so the returned value satisfies the
   * structural type.
   */
  getTurnState: () => TurnState;
  /**
   * Reads the current {@link UIContext} that the chat page passes to
   * {@link shouldShowThinkingIndicator}. Held as a getter because the
   * inputs (pendingSecret, pendingConfirmation, surface counts, etc.)
   * live in React state across multiple components, not in a single ref.
   * Routed through `latestRefs` in {@link useChatDebugApi} so the API
   * sees fresh values on every call without re-installing.
   */
  getUIContext: () => UIContext;
  /**
   * Reads a snapshot of the `interactions` domain's pending-prompt state
   * (secret, confirmation, contact-request, question) plus their
   * submission flags. Held as a getter so the chat domain doesn't have
   * to import the interactions store directly — the composition root
   * (chat-page.tsx) supplies the implementation, which is allowed to
   * cross domains per the existing cross-domain allowlist entry.
   *
   * Called lazily on every `listPendingInteractions()` invocation so
   * DevTools always sees a fresh snapshot.
   */
  getPendingInteractionsSnapshot: () => PendingInteractionsSnapshot;
  reconcileActiveConversation: () => Promise<ReconcileActiveConversationResult>;
  /**
   * Optional injector for the `/v1/history` fetch. Defaults to
   * {@link fetchConversationMessages} from `@/domains/chat/api/messages.js`
   * when omitted. Injected primarily so unit tests can substitute a fake
   * without mocking the whole module (which would leak to sibling test
   * files in the same process).
   */
  historyFetcher?: (
    assistantId: string,
    conversationId: string,
  ) => Promise<RuntimeMessage[]>;
}

/**
 * Build the {@link ChatDebugApi} closure-bound to a set of refs. Pure
 * factory so it can be unit-tested without a `window`.
 */
export function createChatDebugApi(refs: ChatDebugRefs): ChatDebugApi {
  function getClientMessages(
    limit: number = DEFAULT_CLIENT_MESSAGES_LIMIT,
  ): DisplayMessage[] {
    const safeLimit =
      Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : DEFAULT_CLIENT_MESSAGES_LIMIT;
    // Read straight from the post-sanitization snapshot the render path
    // already wrote. Logic-free — same array `buildTranscriptItems` sees.
    const messages = refs.sanitizedMessagesRef.current ?? [];
    const startIndex = Math.max(0, messages.length - safeLimit);
    return messages.slice(startIndex);
  }

  function getTranscriptItems(): TranscriptItem[] {
    // Read straight from the snapshot the render path already wrote.
    // Same array `<Transcript />` iterates — no projection, no cloning.
    return refs.transcriptItemsRef.current ?? [];
  }

  function thinkingIndicator(): ChatDebugThinkingIndicator {
    const turnState = refs.getTurnState();
    const uiContext = refs.getUIContext();

    const restoredProcessing =
      uiContext.activeConversationIsProcessing === true &&
      uiContext.hasPendingAssistantResponse === true;

    const conditions: ChatDebugThinkingConditions = {
      isSending: isSending(turnState),
      isThinking: isThinking(turnState),
      restoredProcessing,
      activeToolCallCount: turnState.activeToolCallCount,
      statusText: turnState.statusText,
      hasPendingSecret: uiContext.hasPendingSecret,
      hasPendingConfirmation: uiContext.hasPendingConfirmation,
      hasPendingQuestion: uiContext.hasPendingQuestion,
      hasPendingContactRequest: uiContext.hasPendingContactRequest,
      hasUncompletedVisibleSurface: uiContext.hasUncompletedVisibleSurface,
      hasStreamingAssistantMessage: uiContext.hasStreamingAssistantMessage,
      activeConversationIsProcessing:
        uiContext.activeConversationIsProcessing === true,
      hasPendingAssistantResponse:
        uiContext.hasPendingAssistantResponse === true,
    };

    // Mirror the AND-clauses of `shouldShowThinkingIndicator` exactly so a
    // false `visible` lines up with the list of blocking clauses. Order here
    // matches the order in the predicate body.
    const failingConditions: string[] = [];
    if (!(conditions.isSending || conditions.restoredProcessing)) {
      failingConditions.push("notSendingAndNotRestoredProcessing");
    }
    if (conditions.hasPendingSecret) {
      failingConditions.push("hasPendingSecret");
    }
    if (conditions.hasPendingConfirmation) {
      failingConditions.push("hasPendingConfirmation");
    }
    if (conditions.hasPendingQuestion) {
      failingConditions.push("hasPendingQuestion");
    }
    if (conditions.hasPendingContactRequest) {
      failingConditions.push("hasPendingContactRequest");
    }
    if (conditions.hasUncompletedVisibleSurface) {
      failingConditions.push("hasUncompletedVisibleSurface");
    }
    if (
      !(
        conditions.isThinking ||
        conditions.restoredProcessing ||
        !conditions.hasStreamingAssistantMessage
      )
    ) {
      failingConditions.push("streamingAssistantMessageActive");
    }
    if (conditions.activeToolCallCount > 0) {
      failingConditions.push("activeToolCallCount>0");
    }

    const visible = shouldShowThinkingIndicator(turnState, uiContext);
    // Cross-check: the failingConditions list should be empty iff visible is
    // true. If this ever drifts we want the test suite (and DevTools users) to
    // notice immediately rather than chasing a confusing report.
    if (visible !== (failingConditions.length === 0)) {
      recordChatDiagnostic("debug_thinking_indicator_drift", {
        visible,
        failingConditionCount: failingConditions.length,
      });
    }

    const phase = turnState.phase;
    const terminal =
      (phase === "idle" || phase === "errored") &&
      turnState.activeTurnId === null;
    const lastTerminalReason = turnState.lastTerminalReason;

    let explanation: string;
    if (terminal) {
      explanation = lastTerminalReason
        ? `terminal: phase=${phase}, lastTerminalReason=${lastTerminalReason}`
        : `terminal: phase=${phase}, no prior turn this session`;
    } else if (phase === "queued") {
      explanation = `active: phase=queued, pending=${turnState.pendingQueuedCount}`;
    } else if (turnState.activeToolCallCount > 0) {
      explanation = `active: phase=${phase}, activeToolCallCount=${turnState.activeToolCallCount}`;
    } else if (conditions.hasStreamingAssistantMessage) {
      explanation = `active: phase=${phase}, streaming an assistant message`;
    } else {
      explanation = `active: phase=${phase}`;
    }

    return {
      visible,
      turnState,
      uiContext,
      conditions,
      failingConditions,
      done: {
        terminal,
        phase,
        lastTerminalReason,
        explanation,
      },
    };
  }

  async function forceReconcile(): Promise<ReconcileActiveConversationResult> {
    recordChatDiagnostic("debug_force_reconcile_start", {
      activeConversationId: refs.activeConversationIdRef.current,
      assistantId: refs.getAssistantId(),
    });
    const result = await refs.reconcileActiveConversation();
    recordChatDiagnostic("debug_force_reconcile_result", {
      activeConversationId: refs.activeConversationIdRef.current,
      changed: result.changed,
      messagesAdded: result.messagesAdded,
      assistantProgress: result.assistantProgress,
    });
    return result;
  }

  async function serverMessages(): Promise<RuntimeMessage[]> {
    // Resolve context from `streamContextRef` first (matches what
    // reconcile would use); fall back to assistantId +
    // activeConversationId so the call still works during a brief
    // conv-switch window where the stream context is transiently null.
    const streamContext = refs.streamContextRef.current;
    const assistantId =
      streamContext?.assistantId ?? refs.getAssistantId() ?? null;
    const conversationId =
      streamContext?.conversationId ??
      refs.activeConversationIdRef.current ??
      null;
    if (!assistantId || !conversationId) {
      throw new Error(
        "serverMessages: no active assistant/conversation context",
      );
    }
    const historyFetcher =
      refs.historyFetcher ?? defaultFetchConversationMessages;
    return await historyFetcher(assistantId, conversationId);
  }

  function listPendingInteractions(): PendingInteractionsSnapshot {
    return refs.getPendingInteractionsSnapshot();
  }

  function getScrollState(): ChatDebugScrollState {
    const capturedAt = new Date().toISOString();
    const messages = refs.messagesRef.current ?? [];
    const itemCount = messages.length;
    const pagination = refs.getScrollPagination();

    const el = refs.transcriptRef.current?.getScrollElement() ?? null;
    if (!el) {
      return {
        capturedAt,
        scrollTop: null,
        scrollHeight: null,
        clientHeight: null,
        distanceFromBottom: null,
        distanceFromTop: null,
        isPinnedToLatest: null,
        showScrollToLatest: null,
        hasMore: pagination.hasMore,
        isLoadingOlder: pagination.isLoadingOlder,
        itemCount,
        shouldLoadOlder: false,
        diagnosis:
          "Transcript scroll container not mounted — check React component tree.",
      };
    }

    const scrollTop = el.scrollTop;
    const scrollHeight = el.scrollHeight;
    const clientHeight = el.clientHeight;
    const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
    const distanceFromTop = scrollTop;

    const classification = classifyScrollPosition(
      { scrollTop, scrollHeight, clientHeight },
      {
        hasMore: pagination.hasMore,
        isLoadingOlder: pagination.isLoadingOlder,
        hasConversation: itemCount > 0,
      },
    );

    const diagnosis = (() => {
      if (!pagination.hasMore) {
        return `At top of content, server says no more history. itemCount=${itemCount}`;
      }
      if (pagination.isLoadingOlder) {
        return `Already loading older messages — scroll handler fired correctly. itemCount=${itemCount}`;
      }
      if (classification.shouldLoadOlder) {
        return `NEAR TOP (distanceFromTop=${Math.round(distanceFromTop)}px) and shouldLoadOlder=true but NOT loading — scroll handler may be stuck. itemCount=${itemCount}`;
      }
      if (classification.isPinned) {
        return `Pinned to bottom (distanceFromBottom=${Math.round(distanceFromBottom)}px). Scrolling up should unpin. itemCount=${itemCount}`;
      }
      return `Mid-scroll (distanceFromBottom=${Math.round(distanceFromBottom)}px, distanceFromTop=${Math.round(distanceFromTop)}px). itemCount=${itemCount}`;
    })();

    return {
      capturedAt,
      scrollTop,
      scrollHeight,
      clientHeight,
      distanceFromBottom,
      distanceFromTop,
      isPinnedToLatest: classification.isPinned,
      showScrollToLatest: classification.showScrollToLatest,
      hasMore: pagination.hasMore,
      isLoadingOlder: pagination.isLoadingOlder,
      itemCount,
      shouldLoadOlder: classification.shouldLoadOlder,
      diagnosis,
    };
  }

  function help(): void {
    const lines = [
      "window._vellumDebug.chat — surgical chat debug API",
      "",
      "  .getClientMessages(n?)     last N DisplayMessage[] the UI is rendering (post-sanitize)",
      "  .getTranscriptItems()      full virtualized row list — messages + thinking + pending prompts + markers",
      "  .thinkingIndicator()       live evaluation of the `...` predicate + done signal",
      "                              .visible / .failingConditions tell you why dots are or aren't showing",
      "                              .done.terminal / .done.lastTerminalReason tell you if the turn is finished",
      "  .forceReconcile()          [experimental] imperatively run /v1/history reconcile",
      "  .serverMessages()          [experimental] fetch /v1/history and return server message list",
      "                              (diff against getClientMessages() manually in the console)",
      "  .listPendingInteractions() frontend-tracked pending prompts (secret/confirmation/",
      "                              contact-request/question) and submission flags",
      "  .getScrollState()          scroll geometry + pagination — why can't I scroll up?",
      "                              .diagnosis gives a human-readable summary",
      "  .help()                    print this message",
    ];
    console.log(lines.join("\n"));
  }

  return {
    getClientMessages,
    getTranscriptItems,
    thinkingIndicator,
    forceReconcile,
    serverMessages,
    listPendingInteractions,
    getScrollState,
    help,
  };
}

// ---------------------------------------------------------------------------
// Global install / uninstall
// ---------------------------------------------------------------------------

const EVENTS_NS = "events";
const API_NS = "api";

/**
 * Dev-only toggle surface. Each function is a single-purpose imperative
 * flip — call from the console to flip a localStorage-persisted flag.
 * Toggles that change React hook ordering (e.g. swapping which scroll
 * coordinator runs) reload the page so the new value takes effect
 * cleanly. See `transcript-scroll-flag.ts` for the storage layer.
 */
export interface VellumDebugFlagsApi {
  /** Flip the parallel `useTranscriptScrollController` path on or off.
   *  Persists to localStorage and reloads the page. Pass `true`/`false`
   *  to force a specific value; omit to flip the current value. */
  toggleTranscriptScrollController(value?: boolean): boolean;
  /** Override the assistant's reported version for every version-gated
   *  code path in the web client (the wire-field cutover, the
   *  server-mint gate, `useAssistantSupports`, …). Persists to
   *  localStorage and reloads.
   *
   *  - `impersonateVersion("0.8.6")` — set to that version + reload.
   *  - `impersonateVersion(null)`    — clear override + reload.
   *  - `impersonateVersion()`        — log + return current value
   *    (no reload, no mutation).
   *
   *  Returns the value in effect after the call. */
  impersonateVersion(value?: string | null): string | null;
}

interface VellumDebugRoot extends Record<string, unknown> {
  [EVENTS_NS]?: ChatDebugEventsApi;
  [CHAT_NS]?: ChatDebugApi;
  [API_NS]?: typeof assistantApi;
  [FLAGS_NS]?: VellumDebugFlagsApi;
}

declare global {
  interface Window {
    _vellumDebug?: VellumDebugRoot;
  }
}

/**
 * Single entry point that attaches every half of the debug API to
 * `window._vellumDebug` in one shot:
 *
 *   - `events` — the SSE client + ring-buffer accessors from
 *     {@link eventsDebugApi}. Stable singleton; same surface every call.
 *   - `chat` — the per-page chat introspection API built from React refs.
 *     Component-scoped; rebuilt on each mount.
 *   - `api` — the full `@vellumai/assistant-api` namespace, so a developer
 *     can pull canonical SSE schemas (`RelationshipStateUpdatedEventSchema`, …)
 *     out of the shipped bundle from the console.
 *   - `flags` — dev-toggleable feature flags
 *     (`toggleTranscriptScrollController`, `impersonateVersion`).
 *     Stable singleton; pure module exports backed by localStorage.
 *
 * Consolidating these into one installer guarantees they're set at the
 * same time and torn down together, so DevTools never sees one namespace
 * populated and the others missing.
 *
 * Returns a cleanup function that removes all bindings (identity-
 * checking the chat API in case a newer mount replaced it) and the
 * root object if it's empty afterwards. Safe to call on the server —
 * no-op when `window` is undefined.
 */
export function installVellumDebugApi(
  chatApi: ChatDebugApi,
  flagsApi: VellumDebugFlagsApi,
): () => void {
  if (typeof window === "undefined") return () => {};
  const win = window as Omit<Window, typeof ROOT_NS> & { [ROOT_NS]?: VellumDebugRoot };
  const existing: VellumDebugRoot = (win[ROOT_NS] ?? {}) as VellumDebugRoot;
  existing[EVENTS_NS] = eventsDebugApi;
  existing[CHAT_NS] = chatApi;
  existing[API_NS] = assistantApi;
  existing[FLAGS_NS] = flagsApi;
  win[ROOT_NS] = existing;
  return () => {
    const current = win[ROOT_NS];
    if (!current) return;
    // Gate every deletion on the chat-API identity check. If a newer
    // mount has already replaced our chatApi (strict-mode double-mount,
    // hot reload, etc.), our teardown is stale — leave the world alone.
    // `events`, `api`, and `flags` lifecycles are paired with `chat`
    // because they are stable singletons (pure module exports);
    // identity-checking them would always pass.
    if (current[CHAT_NS] === chatApi) {
      delete current[CHAT_NS];
      delete current[EVENTS_NS];
      delete current[API_NS];
      delete current[FLAGS_NS];
    }
    // Only remove the root if we left it empty — other debug domains
    // may have attached siblings under the same namespace.
    if (Object.keys(current).length === 0) {
      delete win[ROOT_NS];
    }
  };
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Wire {@link createChatDebugApi} into a React component's lifecycle.
 *
 * The API is installed once on mount and torn down on unmount. The
 * `MutableRefObject`s in `refs` are stable across the host page's
 * lifetime so we capture them directly. The two non-ref dependencies
 * (`getAssistantId`, `reconcileActiveConversation`) are routed through
 * a sibling ref updated on every render so the API's closures always
 * see the latest values — without this, the API would freeze them to
 * the values present at first mount.
 */
export function useChatDebugApi(refs: ChatDebugRefs): void {
  const latestRefs = useRef(refs);
  latestRefs.current = refs;

  useEffect(() => {
    const stableRefs: ChatDebugRefs = {
      messagesRef: refs.messagesRef,
      sanitizedMessagesRef: refs.sanitizedMessagesRef,
      transcriptItemsRef: refs.transcriptItemsRef,
      transcriptRef: refs.transcriptRef,
      streamContextRef: refs.streamContextRef,
      streamRef: refs.streamRef,
      streamEpochRef: refs.streamEpochRef,
      activeConversationIdRef: refs.activeConversationIdRef,
      getAssistantId: () => latestRefs.current.getAssistantId(),
      getTurnState: () => latestRefs.current.getTurnState(),
      getUIContext: () => latestRefs.current.getUIContext(),
      getPendingInteractionsSnapshot: () =>
        latestRefs.current.getPendingInteractionsSnapshot(),
      getScrollPagination: () => latestRefs.current.getScrollPagination(),
      reconcileActiveConversation: () =>
        latestRefs.current.reconcileActiveConversation(),
      historyFetcher: refs.historyFetcher,
    };
    const api = createChatDebugApi(stableRefs);
    const flagsApi: VellumDebugFlagsApi = {
      toggleTranscriptScrollController: setTranscriptScrollControllerEnabled,
      impersonateVersion: setImpersonatedAssistantVersion,
    };
    const uninstall = installVellumDebugApi(api, flagsApi);
    return uninstall;
  }, []);
}
