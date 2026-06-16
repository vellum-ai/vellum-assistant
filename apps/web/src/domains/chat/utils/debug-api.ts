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

import { useEffect, useLayoutEffect, useRef } from "react";
import type { MutableRefObject } from "react";

import * as assistantApi from "@vellumai/assistant-api";
import type { MessagesGetResponse } from "@/generated/daemon/types.gen";
import {
  type ChatDebugEventsApi,
  eventsDebugApi,
} from "@/domains/chat/api/debug-api";
import { fetchConversationMessages as defaultFetchConversationMessages } from "@/domains/chat/api/messages";
import { useStreamStore } from "@/domains/chat/stream-store";
import type {
  PendingConfirmationState,
  PendingContactRequestState,
  PendingQuestionState,
  PendingSecretState,
} from "@/types/interaction-ui-types";
import {
  type DiagnosticsEvent,
  getDiagnosticsEvents,
  getLifecycleDiagnosticsEvents,
  recordDiagnostic,
} from "@/lib/diagnostics";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation";
import { setImpersonatedAssistantVersion } from "@/lib/backwards-compat/impersonate-version-flag";
import { classifyScrollPosition } from "@/domains/chat/transcript/transcript-scroll-utils";
import type { TranscriptHandle } from "@/domains/chat/transcript/transcript";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import {
  type TerminalReason,
  type TurnPhase,
  type TurnState,
  isSending,
  isThinking,
} from "@/domains/chat/turn-store";
import {
  type UIContext,
  shouldShowThinkingIndicator,
} from "@/domains/chat/turn-selectors";
import { useConversationStore } from "@/stores/conversation-store";

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
  /** True when the live assistant message already has reasoning content, so the
   * inline `SingleActivity` owns the loading state and the dots row defers. */
  hasStreamingAssistantThinking: boolean;
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
 * doesn't expose the live Zustand reference. A pending confirmation's
 * `input` values are redacted (see {@link redactPendingInteractions}) so the
 * snapshot never carries tool-call argument values.
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

/**
 * Avatar streaming-ring state block — answers "why is the spinning ring
 * around the avatar showing (or stuck) — or not showing?".
 *
 * The ring renders in {@link ChatAvatar} for custom-image avatars iff
 * `isStreaming || isProcessing` (see `chat-avatar.tsx`, and the props wired
 * in `chat-route-content.tsx`). This mirrors those two gates so a developer
 * can tell at a glance which one is keeping it lit — most usefully when the
 * ring "hangs" after a turn ends, which means one gate is still latched on.
 *
 * Distinct from the transcript "thinking…" dots described by
 * {@link ChatDebugThinkingIndicator}: the dots gate on the stricter
 * {@link shouldShowThinkingIndicator} predicate (which tolerates a stale
 * `activeConversationIsProcessing` snapshot via `hasPendingAssistantResponse`),
 * whereas the ring trusts the coarse `isStreaming`/`isProcessing` OR directly.
 */
export interface ChatDebugStreamingRing {
  /** Whether the ring would render this frame — `isStreaming || isProcessing`. */
  visible: boolean;
  /** The `isStreaming` prop `ChatAvatar` receives — the app's
   *  `isAssistantStreaming` signal (`showThinking || hasStreamingAssistantMessage`,
   *  i.e. {@link shouldShowThinkingIndicator} OR an open streaming bubble). */
  isStreaming: boolean;
  /** The `isProcessing` prop `ChatAvatar` receives — the OR of the local
   *  optimistic processing set and the cached `conversation.isProcessing`
   *  snapshot (`uiContext.activeConversationIsProcessing`). A `true` here
   *  after the turn is done points at a stale cached snapshot. */
  isProcessing: boolean;
  /** Names of the gates currently keeping the ring visible. Empty when
   *  `visible` is false. */
  litBy: string[];
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

/**
 * Kind prefixes that make up the reconciliation triage view returned by
 * {@link ChatDebugApi.getReconciliationDiagnostics}: the reconcile loop
 * itself (`reconciliation_*`, `debug_force_reconcile_*`), the pre-updater
 * drop gates that silently discard SSE events (`sse_event_seq_replayed`,
 * `sse_event_wrong_conversation*`, `sse_event_stale`), and the seq-frontier
 * transitions that explain them (`sse_seq_generation_reset`,
 * `sse_seq_gap_detected`).
 */
export const RECONCILIATION_DIAGNOSTIC_KIND_PREFIXES: readonly string[] = [
  "reconciliation_",
  "debug_force_reconcile_",
  "sse_event_seq_replayed",
  "sse_event_wrong_conversation",
  "sse_event_stale",
  "sse_seq_generation_reset",
  "sse_seq_gap_detected",
];

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
   * the thinking indicator and pending prompts — use
   * {@link getTranscriptItems}.
   */
  getClientMessages(limit?: number): DisplayMessage[];
  /**
   * Return the full transcript-item array the virtualized list iterates
   * — messages, the thinking indicator, pending-interaction rows, error
   * notices, the onboarding-choice row.
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
   * Current turn phase — the `phase` field of the turn-store state
   * machine (`useTurnStore`). One of `idle`, `queued`, `thinking`,
   * `streaming`, `awaiting_user_input`, or `errored`.
   *
   * Console-callable mirror of the `useTurnStore.use.phase()` render hook:
   * reads `useTurnStore.getState().phase` so it returns the live value
   * without creating a subscription. Use it to answer "what phase is the
   * turn in right now?" at a glance; for the full lifecycle picture
   * (terminal signal, failing thinking-indicator clauses) use
   * {@link thinkingIndicator}.
   *
   * Synchronous and side-effect-free.
   */
  getPhase(): TurnPhase;
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
   * Live evaluation of the avatar streaming-ring gates — answers "why is
   * the spinning ring around the avatar showing (or stuck), or not
   * showing?". See {@link ChatDebugStreamingRing}: `.litBy` names the gate
   * keeping it lit, so a terminal turn with `litBy: ["isProcessing"]` is the
   * signature of a stale `conversation.isProcessing` snapshot.
   *
   * Synchronous, side-effect-free; reads the same turn-store + UI-context
   * snapshot the React render path reads.
   */
  streamingRing(): ChatDebugStreamingRing;
  /**
   * [experimental] Imperatively trigger a reconcile of the active conversation
   * against `/v1/history`. Returns the same shape as the watchdog /
   * resume / cache-restore reconcile paths. Subject to change.
   */
  forceReconcile(): Promise<ReconcileActiveConversationResult>;
  /**
   * [experimental] Fetch `/v1/history` for the active assistant +
   * conversation and return the raw server snapshot response — the
   * message list plus the top-level `seq` watermark. Does not touch UI
   * state — diff against `getClientMessages()` manually in the console
   * when you need to declare drift, and read `seq` to compare against the
   * applied frontier. Throws if there's no active assistant/conversation
   * context. Subject to change.
   */
  serverMessages(): Promise<MessagesGetResponse | undefined>;
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
  /**
   * Return the main (high-volume) diagnostics ring — per-delta SSE
   * diagnostics, history applies, drop-gate skips — newest last, each
   * entry timestamped (`ts`, ISO). Optionally filter by kind prefix,
   * e.g. `getDiagnostics("sse_event_")` or
   * `getDiagnostics("reconciliation_applied")`.
   *
   * Reads the sessionStorage-backed ring from `@/lib/diagnostics`
   * (`vellum:chat-diagnostics:v1`, capped at 200 entries). Synchronous
   * and side-effect-free; returns defensive copies.
   */
  getDiagnostics(kindPrefix?: string): DiagnosticsEvent[];
  /**
   * Return the durable lifecycle diagnostics ring — stream open / close /
   * reconnect / watchdog, tab visibility, network, power transitions —
   * newest last. Optionally filter by kind prefix. Kept in a separate
   * buffer (`vellum:chat-diagnostics-lifecycle:v1`) so high-volume
   * per-delta events never flush the connection timeline.
   *
   * Synchronous and side-effect-free; returns defensive copies.
   */
  getLifecycleDiagnostics(kindPrefix?: string): DiagnosticsEvent[];
  /**
   * Curated triage view for "streamed text never showed up" /
   * "reconcile clobbered my messages" reports: the main ring filtered to
   * {@link RECONCILIATION_DIAGNOSTIC_KIND_PREFIXES} — reconcile loop
   * activity, the SSE drop gates (`sse_event_seq_replayed` et al.), and
   * seq-frontier resets/gaps — in chronological order.
   *
   * Reading it: an `sse_event_seq_replayed` whose `details.localSeq` is
   * far above `details.eventSeq` right after an `sse_seq_generation_reset`
   * is the stale-frontier signature; a `reconciliation_applied` in the
   * same window explains an alias-only row with no streamed text.
   *
   * Synchronous and side-effect-free.
   */
  getReconciliationDiagnostics(): DiagnosticsEvent[];
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
  ) => Promise<MessagesGetResponse | undefined>;
}

/** Marker substituted for redacted confirmation-input values. */
const REDACTED_CONFIRMATION_INPUT_VALUE = "[redacted]";

/**
 * Strip a pending confirmation's raw `input` values out of the snapshot.
 *
 * `input` is the arbitrary argument object the assistant proposed for a tool
 * call, so it can hold secrets under any key (tokens, passwords, API keys).
 * `listPendingInteractions` feeds both DevTools inspection and the support
 * feedback archive, neither of which may carry credentials, so every value is
 * replaced with a marker while the argument key names are kept for triage.
 * Returns a new object — the live store and the confirmation card keep the
 * real arguments.
 */
function redactPendingInteractions(
  snapshot: PendingInteractionsSnapshot,
): PendingInteractionsSnapshot {
  const { pendingConfirmation } = snapshot;
  if (!pendingConfirmation?.input) {
    return snapshot;
  }
  return {
    ...snapshot,
    pendingConfirmation: {
      ...pendingConfirmation,
      input: Object.fromEntries(
        Object.keys(pendingConfirmation.input).map((key) => [
          key,
          REDACTED_CONFIRMATION_INPUT_VALUE,
        ]),
      ),
    },
  };
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

  function getPhase(): TurnPhase {
    return refs.getTurnState().phase;
  }

  function thinkingIndicator(): ChatDebugThinkingIndicator {
    const turnState = refs.getTurnState();
    const uiContext = refs.getUIContext();

    const restoredProcessing =
      uiContext.activeConversationIsProcessing === true &&
      uiContext.hasPendingAssistantResponse === true;

    const conditions: ChatDebugThinkingConditions = {
      isSending: isSending(turnState.phase),
      isThinking: isThinking(turnState.phase),
      restoredProcessing,
      activeToolCallCount: turnState.activeToolCallCount,
      statusText: turnState.statusText,
      hasPendingSecret: uiContext.hasPendingSecret,
      hasPendingConfirmation: uiContext.hasPendingConfirmation,
      hasPendingQuestion: uiContext.hasPendingQuestion,
      hasPendingContactRequest: uiContext.hasPendingContactRequest,
      hasUncompletedVisibleSurface: uiContext.hasUncompletedVisibleSurface,
      hasStreamingAssistantMessage: uiContext.hasStreamingAssistantMessage,
      hasStreamingAssistantThinking: uiContext.hasStreamingAssistantThinking,
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
    if (conditions.hasStreamingAssistantThinking) {
      failingConditions.push("hasStreamingAssistantThinking");
    }
    if (conditions.activeToolCallCount > 0) {
      failingConditions.push("activeToolCallCount>0");
    }

    const visible = shouldShowThinkingIndicator(turnState.phase, turnState.activeToolCallCount, uiContext);
    // Cross-check: the failingConditions list should be empty iff visible is
    // true. If this ever drifts we want the test suite (and DevTools users) to
    // notice immediately rather than chasing a confusing report.
    if (visible !== (failingConditions.length === 0)) {
      recordDiagnostic("debug_thinking_indicator_drift", {
        visible,
        failingConditionCount: failingConditions.length,
      });
    }

    const phase = turnState.phase;
    const terminal =
      (phase === "idle" || phase === "errored") &&
      turnState.activeTurnId === null;
    const lastTerminalReason = turnState.lastTerminalReason;

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
      },
    };
  }

  function streamingRing(): ChatDebugStreamingRing {
    const turnState = refs.getTurnState();
    const uiContext = refs.getUIContext();

    // The ring renders in `ChatAvatar` for custom-image avatars iff
    // `isStreaming || isProcessing`; mirror both gates so a stuck (or missing)
    // ring points straight at the latched gate. `isStreaming` is the app's
    // `isAssistantStreaming` (`showThinking || hasStreamingAssistantMessage`);
    // `isProcessing` is the coarse `activeConversationIsProcessing` OR-signal.
    const isStreaming =
      shouldShowThinkingIndicator(turnState.phase, turnState.activeToolCallCount, uiContext) ||
      uiContext.hasStreamingAssistantMessage;
    const isProcessing = uiContext.activeConversationIsProcessing === true;
    const litBy: string[] = [];
    if (isStreaming) {
      litBy.push("isStreaming");
    }
    if (isProcessing) {
      litBy.push("isProcessing");
    }

    return {
      visible: isStreaming || isProcessing,
      isStreaming,
      isProcessing,
      litBy,
    };
  }

  async function forceReconcile(): Promise<ReconcileActiveConversationResult> {
    recordDiagnostic("debug_force_reconcile_start", {
      activeConversationId: useConversationStore.getState().activeConversationId,
      assistantId: refs.getAssistantId(),
    });
    const result = await refs.reconcileActiveConversation();
    recordDiagnostic("debug_force_reconcile_result", {
      activeConversationId: useConversationStore.getState().activeConversationId,
      changed: result.changed,
      messagesAdded: result.messagesAdded,
      assistantProgress: result.assistantProgress,
    });
    return result;
  }

  async function serverMessages(): Promise<MessagesGetResponse | undefined> {
    // Resolve context from stream store first (matches what reconcile
    // would use); fall back to assistantId + activeConversationId so
    // the call still works during a brief conv-switch window where
    // the stream context is transiently null.
    const streamContext = useStreamStore.getState().streamContext;
    const assistantId =
      streamContext?.assistantId ?? refs.getAssistantId() ?? null;
    const conversationId =
      streamContext?.conversationId ??
      useConversationStore.getState().activeConversationId ??
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
    return redactPendingInteractions(refs.getPendingInteractionsSnapshot());
  }

  function getScrollState(): ChatDebugScrollState {
    const capturedAt = new Date().toISOString();
    const { messages } = useChatSessionStore.getState();
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

  function filterByKindPrefix(
    events: DiagnosticsEvent[],
    kindPrefix?: string,
  ): DiagnosticsEvent[] {
    if (!kindPrefix) return events;
    return events.filter((event) => event.kind.startsWith(kindPrefix));
  }

  function getDiagnostics(kindPrefix?: string): DiagnosticsEvent[] {
    return filterByKindPrefix(getDiagnosticsEvents(), kindPrefix);
  }

  function getLifecycleDiagnostics(kindPrefix?: string): DiagnosticsEvent[] {
    return filterByKindPrefix(getLifecycleDiagnosticsEvents(), kindPrefix);
  }

  function getReconciliationDiagnostics(): DiagnosticsEvent[] {
    return getDiagnosticsEvents().filter((event) =>
      RECONCILIATION_DIAGNOSTIC_KIND_PREFIXES.some((prefix) =>
        event.kind.startsWith(prefix),
      ),
    );
  }

  function help(): void {
    const lines = [
      "window._vellumDebug.chat — surgical chat debug API",
      "",
      "  .getClientMessages(n?)     last N DisplayMessage[] the UI is rendering (post-sanitize)",
      "  .getTranscriptItems()      full virtualized row list — messages + thinking + pending prompts",
      "  .getPhase()                current turn phase (idle/queued/thinking/streaming/awaiting_user_input/errored)",
      "  .thinkingIndicator()       live evaluation of the `...` predicate + done signal",
      "                              .visible / .failingConditions tell you why dots are or aren't showing",
      "                              .done.terminal / .done.lastTerminalReason tell you if the turn is finished",
      "  .streamingRing()           why the avatar ring is showing or stuck — .visible / .litBy",
      "  .forceReconcile()          [experimental] imperatively run /v1/history reconcile",
      "  .serverMessages()          [experimental] fetch /v1/history and return the server snapshot response (messages + seq)",
      "                              (diff against getClientMessages() manually in the console)",
      "  .listPendingInteractions() frontend-tracked pending prompts (secret/confirmation/",
      "                              contact-request/question) and submission flags",
      "  .getScrollState()          scroll geometry + pagination — why can't I scroll up?",
      "                              .diagnosis gives a human-readable summary",
      "  .getDiagnostics(prefix?)   main diagnostics ring (per-delta SSE / drop gates / history applies),",
      "                              optionally filtered by kind prefix, e.g. .getDiagnostics('sse_event_')",
      "  .getLifecycleDiagnostics(prefix?)  durable lifecycle ring — stream open/close/reconnect, visibility, network",
      "  .getReconciliationDiagnostics()    curated timeline: reconcile loop + SSE drop gates + seq resets/gaps —",
      "                              the 'streamed text never showed up' triage view",
      "  .help()                    print this message",
    ];
    console.log(lines.join("\n"));
  }

  return {
    getClientMessages,
    getTranscriptItems,
    getPhase,
    thinkingIndicator,
    streamingRing,
    forceReconcile,
    serverMessages,
    listPendingInteractions,
    getScrollState,
    getDiagnostics,
    getLifecycleDiagnostics,
    getReconciliationDiagnostics,
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
 * Toggles that change React hook ordering or module-load constants
 * reload the page so the new value takes effect cleanly.
 */
export interface VellumDebugFlagsApi {
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
 *   - `flags` — dev-toggleable feature flags (`impersonateVersion`).
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
  useLayoutEffect(() => { latestRefs.current = refs; });

  useEffect(() => {
    const stableRefs: ChatDebugRefs = {
      sanitizedMessagesRef: refs.sanitizedMessagesRef,
      transcriptItemsRef: refs.transcriptItemsRef,
      transcriptRef: refs.transcriptRef,

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
      impersonateVersion: setImpersonatedAssistantVersion,
    };
    const uninstall = installVellumDebugApi(api, flagsApi);
    return uninstall;
  }, []);
}
