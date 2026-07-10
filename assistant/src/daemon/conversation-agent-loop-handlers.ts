/**
 * Extracted event handler functions for the conversation agent loop.
 *
 * Each switch case from the original monolithic event handler is now a
 * standalone exported function, making individual behaviors independently
 * testable while keeping shared mutable state bundled in EventHandlerState.
 */

import type pino from "pino";
import { v4 as uuid } from "uuid";

import type { AgentEvent } from "../agent/loop.js";
import { getThreadTs } from "../channels/slack-thread-store.js";
import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { recordEstimate } from "../context/estimator-calibration.js";
import { stripInjectionsForCompaction } from "../context/strip-injections.js";
import { getCalibrationProviderKey } from "../context/token-estimator.js";
import {
  formatSlackTimezoneLabel,
  type SlackMessageMetadata,
  writeSlackMetadata,
} from "../messaging/providers/slack/message-metadata.js";
import {
  recordCompactionEndBestEffort,
  recordCompactionStartBestEffort,
} from "../persistence/compaction-log-store-clickhouse.js";
import {
  deleteMessageById,
  getConversation,
  getMessageById,
  messageMetadataSchema,
  provenanceFromTrustContext,
  recordConversationPersistedSeq,
  reserveMessage,
  setConversationHistoryStrippedAt,
  setLastNotifiedInferenceProfile,
  updateMessageContent,
} from "../persistence/conversation-crud.js";
import { syncMessageToDisk } from "../persistence/conversation-disk-view.js";
import { enqueueLexicalIndexForMessage } from "../persistence/job-handlers/message-lexical.js";
import {
  backfillMessageIdOnLogs,
  buildProviderErrorResponsePayload,
  recordRequestLog,
  setAgentLoopExitReasonOnLatestLog,
} from "../persistence/llm-request-log-store.js";
import { endSection, markSection } from "../persistence/slow-sync-log.js";
import type { ContextWindowResult } from "../plugins/defaults/compaction/window-manager.js";
import { indexMessageNow } from "../plugins/defaults/memory/indexer.js";
import { backfillMemoryRecallLogMessageId } from "../plugins/defaults/memory/memory-recall-log-store.js";
import { backfillMemoryV2ActivationMessageId } from "../plugins/defaults/memory/memory-v2-activation-log-store.js";
import { backfillMemoryV3SelectionMessageId } from "../plugins/defaults/memory/v3/shadow-plugin.js";
import { resolveMediaSourceData } from "../providers/media-resolve.js";
import type {
  ContentBlock,
  ImageContent,
  Message,
} from "../providers/types.js";
import { getCurrentSeq } from "../runtime/assistant-stream-state.js";
import { redactSecrets } from "../security/secret-scanner.js";
import { extractDomain } from "../tools/network/domain-normalize.js";
import {
  classifyWebSearchFailure,
  logWebSearchBackendFailure,
  WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
} from "../tools/network/web-search-error.js";
import {
  buildPricingUsage,
  resolveStructuredPricing,
} from "../usage/pricing.js";
import { ProviderError } from "../util/errors.js";
import { faviconUrlForDomain } from "../util/favicon.js";
import { getLogger } from "../util/logger.js";
import { withSqliteRetry } from "../util/sqlite-retry.js";
import type { DirectiveRequest } from "./assistant-attachments.js";
import {
  cleanAssistantContent,
  drainDirectiveDisplayBuffer,
} from "./assistant-attachments.js";
import type { Conversation } from "./conversation.js";
import type { AssistantSurface } from "./conversation-agent-loop.js";
import {
  buildConversationErrorMessage,
  classifyConversationError,
  maxTokensReachedClassification,
} from "./conversation-error.js";
import { buildDeferredFinalizeEffect } from "./conversation-turn-finalize.js";
import { resolveTurnTimezoneContext } from "./date-context.js";
import type {
  CardSurfaceData,
  ServerMessage,
  SurfaceAction,
  UiSurfaceShow,
} from "./message-protocol.js";
import type {
  ToolActivityMetadata,
  WebSearchMetadata,
  WebSearchResultItem,
} from "./message-types/web-activity.js";
import { referenceMediaBlocksForPersist } from "./persist-media-references.js";
import type { TurnLatencyTracker } from "./turn-latency-tracker.js";

const log = getLogger("agent-loop-handlers");

function shouldPersistProviderErrorAsAssistantMessage(classified: {
  code: string;
}): boolean {
  return classified.code !== "MANAGED_KEY_INVALID";
}

/**
 * Persist the history-stripped marker after the loop strips runtime injections
 * for compaction / overflow recovery. The marker is a durability hint, not
 * turn-critical state — a transient SQLite write failure (SQLITE_BUSY,
 * disk-full, read-only FS) must not abort the turn, so failures log a warning
 * and continue.
 */
export function markHistoryStrippedBestEffort(conversationId: string): void {
  try {
    setConversationHistoryStrippedAt(conversationId, Date.now());
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Failed to persist history-stripped marker after compaction strip (non-fatal)",
    );
  }
}

// ── Partial-persistence tunables ─────────────────────────────────────
// Debounce for mid-turn `updateContent` writes from text deltas.
// Indexer + projector still fire ONLY at `handleMessageComplete`.
const PARTIAL_PERSIST_DEBOUNCE_MS = 1000;

// ── Types ────────────────────────────────────────────────────────────

export interface PendingToolResult {
  content: string;
  isError: boolean;
  contentBlocks?: ContentBlock[];
}

/** Mutable state shared across event handlers within a single agent loop run. */
export interface EventHandlerState {
  /**
   * Profile key whose `model_profile` notice has been assembled into the turn
   * context but not yet marked notified. Set when the turn injects the notice,
   * and consumed the first time the model actually receives that context — i.e.
   * on the first `message_complete`. Persisting on delivery (rather than inline
   * before the provider call) means a cancelled or failed turn re-sends the
   * notice next turn instead of silently marking the profile notified without
   * the model ever having seen it.
   */
  pendingNotifiedInferenceProfile: string | null;
  pendingDirectiveDisplayBuffer: string;
  firstAssistantText: string;
  /** Most recent resolved provider for the current exchange's usage accounting. */
  exchangeProviderName: string | undefined;
  exchangeInputTokens: number;
  exchangeCacheCreationInputTokens: number;
  exchangeCacheReadInputTokens: number;
  exchangeOutputTokens: number;
  /** Input tokens from the most recent LLM API call (overwritten, not accumulated). */
  lastCallInputTokens: number;
  /** Number of actual LLM API calls within this exchange. */
  exchangeLlmCallCount: number;
  readonly exchangeRawResponses: unknown[];
  model: string;
  providerErrorUserMessage: string | null;
  /**
   * Stable classified code of the most recent provider error
   * (`classifyConversationError(...).code`). Carried into the turn's
   * telemetry outcome stamp when the loop terminates on the provider-error
   * path.
   */
  providerErrorCode: string | null;
  persistProviderErrorAsAssistantMessage: boolean;
  lastAssistantMessageId: string | undefined;
  /**
   * True when `handleLlmCallStarted` has reserved an empty assistant row
   * that has NOT yet been finalized via `handleMessageComplete`
   * (`op:"updateContent"` + indexing + projection). Used by error/retry
   * paths to detect a stranded reservation that must be cleaned up
   * before the next LLM call reserves a fresh row — without it, every
   * retryable failure (overflow, ordering, image overflow) and every
   * terminal provider rejection would leak an empty assistant bubble
   * into the transcript and mispoint downstream sync/projection.
   *
   * Cleared by `handleMessageComplete` on successful finalize, and by
   * the synthetic-error branch in `conversation-agent-loop.ts` after it
   * absorbs the reserved row into the error message.
   */
  assistantRowAwaitingFinalization: boolean;
  readonly pendingToolResults: Map<string, PendingToolResult>;
  /**
   * Reservation of the grouped `user` tool-result row for the current batch,
   * resolving to the row id. Shared across the concurrent `handleToolResult`
   * calls of one parallel-tool batch so they reserve exactly one row and write
   * into it as sibling results land. `undefined` until the first result of a
   * batch triggers a reservation (reset on a failed reservation so the next
   * arrival can retry) and again after the batch is finalized.
   */
  pendingToolResultRowReservation: Promise<string> | undefined;
  readonly persistedToolUseIds: Set<string>;
  readonly accumulatedDirectives: DirectiveRequest[];
  readonly accumulatedToolContentBlocks: ContentBlock[];
  /** Maps index in accumulatedToolContentBlocks → tool name that produced it. */
  readonly toolContentBlockToolNames: Map<number, string>;
  readonly directiveWarnings: string[];
  readonly toolUseIdToName: Map<string, string>;
  /** Sticky for the whole run: this turn created/refreshed an app. */
  appBuildToolUsedThisRun: boolean;
  /** Tracks whether the first text delta has been emitted this turn for activity state transitions. */
  firstTextDeltaEmitted: boolean;
  /** Tracks whether a thinking delta has been emitted this turn for activity state transitions. */
  firstThinkingDeltaEmitted: boolean;
  /** Name of the last completed tool, used to generate contextual statusText. */
  lastCompletedToolName: string | undefined;
  /** Tracks tool_use_id → timing data for persisting on content blocks. */
  readonly toolCallTimestamps: Map<
    string,
    { startedAt: number; completedAt?: number }
  >;
  /**
   * Tracks tool_use_id → the `tool_use_preview_start` timestamp (Unix ms), the
   * first byte of the tool call. Stamped before execution begins, so it lives
   * in its own map rather than `toolCallTimestamps` (whose record requires an
   * execution `startedAt`). Read when emitting `tool_use_start` and when
   * annotating the persisted block so the user-perceived latency survives a
   * refresh.
   */
  readonly toolPreviewStartedAt: Map<string, number>;
  /** The tool_use_id of the currently executing tool (set in handleToolUse, cleared in handleToolResult). */
  currentToolUseId: string | undefined;
  /** Maps confirmation requestId → tool_use_id for linking decisions to tools. */
  readonly requestIdToToolUseId: Map<string, string>;
  /** Stores confirmation outcomes keyed by tool_use_id. */
  readonly toolConfirmationOutcomes: Map<
    string,
    { decision: string; label: string }
  >;
  /** Stores risk metadata keyed by tool_use_id (populated in handleToolResult). */
  readonly toolRiskOutcomes: Map<
    string,
    {
      riskLevel: string;
      riskReason?: string;
      autoApproved: boolean;
      matchedTrustRuleId?: string;
      approvalMode?: string;
      approvalReason?: string;
      riskThreshold?: string;
      /** Display-only regex ladder for the rule editor (narrowest → broadest). */
      riskScopeOptions?: Array<{ pattern: string; label: string }>;
      /** Minimatch save patterns for the rule editor (narrowest → broadest). */
      riskAllowlistOptions?: Array<{
        label: string;
        description: string;
        pattern: string;
      }>;
      /** Directory scope ladder for the rule editor. */
      riskDirectoryScopeOptions?: Array<{ scope: string; label: string }>;
    }
  >;
  /**
   * Structured tool activity (web_search / web_fetch) keyed by tool_use_id,
   * captured when a result lands so it can be persisted on the tool's content
   * block and survive a history reopen. Populated for both external provider
   * tools (in handleToolResult) and native server tools (server_tool_complete).
   */
  readonly toolActivityMetadata: Map<string, ToolActivityMetadata>;
  /** tool_use_ids emitted in the current turn (populated in handleToolUse, cleared after annotation). */
  currentTurnToolUseIds: string[];
  /** Wall-clock time (ms since epoch) when the agent loop turn started, used as the display timestamp for assistant messages. */
  turnStartedAt: number;
  /** Wall-clock start time of native server tool calls, keyed by tool_use_id. */
  readonly serverToolStartedAt: Map<string, number>;
  /** Original input from server_tool_start, keyed by tool_use_id, so the complete handler can read the query. */
  readonly serverToolInputs: Map<string, Record<string, unknown>>;
  /** Request ids for which a user-facing web_search backend-failure notice was already surfaced this turn (dedup noisy repeats). Keyed by request id; each turn has a fresh request id, so this grows at most one entry per turn. */
  readonly webSearchBackendFailureNotified: Set<string>;
  /** Active debounce timer for partial persistence; `undefined` when idle. */
  pendingPartialFlushTimer: ReturnType<typeof setTimeout> | undefined;
  /** In-flight partial flush write awaited at finalize to avoid overwrite races. */
  pendingPartialFlushPromise: Promise<void> | undefined;
  /**
   * Running mirror of the in-flight assistant message's streamed content
   * (text and thinking), flushed to the assistant row on the partial-persist
   * debounce so a mid-turn snapshot reflects what the user is watching live.
   */
  currentMessageContent: ContentBlock[];
  /**
   * Per-thinking-block timing for the in-flight LLM call, in stream order:
   * entry `i` is the `i`-th thinking block mirrored into `currentMessageContent`.
   * `startedAt` is stamped when a thinking block opens; `completedAt` is the
   * last reasoning delta fused into it. Used to stamp `_startedAt`/`_completedAt`
   * onto the authoritative thinking blocks at `message_complete`, mirroring how
   * tool calls persist timing. Reset alongside `currentMessageContent`.
   */
  currentThinkingTimestamps: { startedAt: number; completedAt: number }[];
  /**
   * `seq` of the most recent streamed content delta mirrored into
   * `currentMessageContent`. Recorded as the conversation's persisted `seq`
   * after each flush commits (the debounced partial flushes and the
   * `message_complete` finalize), so the snapshot's advertised `seq` tracks
   * exactly the streamed content the durable row holds. `undefined` until the
   * first content delta of the in-flight message. Because every streamed
   * content type rides the same mirror-and-flush path, this single field
   * never claims content a flush has not yet written.
   */
  lastPersistedContentSeq: number | undefined;
  /**
   * Pre-compaction history buffered from `context_compacting` start events,
   * keyed by `compactionId`. The paired `compaction_completed` event no
   * longer carries the pre-compaction history, so the dispatcher re-derives
   * the stripped durable base from the buffered start messages. Entries are
   * consumed (deleted) when the end event dispatches.
   */
  readonly compactionStartMessages: Map<string, Message[]>;
  /**
   * Cursor into the turn's latency-mark list marking how far prior calls have
   * already been serialized, so each `usage` event emits only its own call's
   * latency segment. Advances on every `handleUsage`.
   */
  latencyCursor: number;
  /**
   * Non-critical finalize side-effects deferred off the turn's critical path —
   * one closure per assistant message that completes (memory segment indexing,
   * lexical indexing, attention projection). `handleMessageComplete` persists
   * the message content synchronously (so a snapshot/refetch on the terminal
   * `message_complete` SSE still sees the full reply) and pushes these
   * follow-ups here; the orchestrator drains them after the terminal SSE has
   * re-enabled the composer but before the next turn can start. Each closure is
   * individually best-effort. Accumulates across retries/multi-call turns so
   * every produced assistant row is indexed.
   */
  readonly deferredFinalizeEffects: Array<() => Promise<void>>;
}

/** Immutable context shared across event handlers within a single agent loop run. */
export interface EventHandlerDeps {
  readonly ctx: Conversation;
  readonly onEvent: (msg: ServerMessage) => void;
  readonly reqId: string;
  readonly isFirstMessage: boolean;
  /** Whether the conversation title is replaceable — controls firstAssistantText accumulation for title generation. */
  readonly shouldGenerateTitle: boolean;
  readonly rlog: pino.Logger;
  readonly turnChannelContext: TurnChannelContext;
  readonly turnInterfaceContext: TurnInterfaceContext;
  /**
   * Commit a successful inline compaction to durable state. Invoked from the
   * `compaction_completed` dispatch case (when `compacted`) with the
   * loop's compaction result and the stripped pre-compaction history. Supplied
   * by the orchestrator because the body writes Conversation DB-record fields,
   * projects Slack provenance, and emits transport the loop is intentionally
   * blind to.
   */
  readonly applyCompaction: (
    result: ContextWindowResult,
    messages: Message[],
  ) => Promise<void>;
  /**
   * Per-turn first-token latency instrumentation. The orchestrator stamps the
   * turn-level marks; the agent loop stamps the per-call marks. `handleUsage`
   * serializes the breakdown for each call and persists it on the request log.
   * Optional: a pure observability hook that the production orchestrator always
   * supplies, but test fixtures and any future caller may omit — `handleUsage`
   * degrades gracefully when it's absent.
   */
  readonly latencyTracker?: TurnLatencyTracker;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createEventHandlerState(): EventHandlerState {
  return {
    pendingNotifiedInferenceProfile: null,
    pendingDirectiveDisplayBuffer: "",
    firstAssistantText: "",
    exchangeProviderName: undefined,
    exchangeInputTokens: 0,
    exchangeCacheCreationInputTokens: 0,
    exchangeCacheReadInputTokens: 0,
    exchangeOutputTokens: 0,
    lastCallInputTokens: 0,
    exchangeLlmCallCount: 0,
    exchangeRawResponses: [],
    model: "",
    providerErrorUserMessage: null,
    providerErrorCode: null,
    persistProviderErrorAsAssistantMessage: false,
    lastAssistantMessageId: undefined,
    assistantRowAwaitingFinalization: false,
    pendingToolResults: new Map(),
    pendingToolResultRowReservation: undefined,
    persistedToolUseIds: new Set(),
    accumulatedDirectives: [],
    accumulatedToolContentBlocks: [],
    toolContentBlockToolNames: new Map(),
    directiveWarnings: [],
    toolUseIdToName: new Map(),
    appBuildToolUsedThisRun: false,
    firstTextDeltaEmitted: false,
    firstThinkingDeltaEmitted: false,
    lastCompletedToolName: undefined,
    toolCallTimestamps: new Map(),
    toolPreviewStartedAt: new Map(),
    currentToolUseId: undefined,
    requestIdToToolUseId: new Map(),
    toolConfirmationOutcomes: new Map(),
    toolRiskOutcomes: new Map(),
    toolActivityMetadata: new Map(),
    currentTurnToolUseIds: [],
    turnStartedAt: Date.now(),
    serverToolStartedAt: new Map(),
    serverToolInputs: new Map(),
    webSearchBackendFailureNotified: new Set(),
    pendingPartialFlushTimer: undefined,
    pendingPartialFlushPromise: undefined,
    currentMessageContent: [],
    currentThinkingTimestamps: [],
    lastPersistedContentSeq: undefined,
    compactionStartMessages: new Map(),
    latencyCursor: 0,
    deferredFinalizeEffects: [],
  };
}

// ── Partial-persistence helpers ──────────────────────────────────────

/** Canonical persisted-content build: clean → append surfaces → redact. */
export function buildPersistedAssistantContent(
  rawBlocks: readonly ContentBlock[],
  surfaces: readonly AssistantSurface[],
  activityByToolUseId?: ReadonlyMap<string, ToolActivityMetadata>,
): ContentBlock[] {
  const { cleanedContent } = cleanAssistantContent(rawBlocks);
  const cleaned = cleanedContent as ContentBlock[];
  const withSurfaces: ContentBlock[] = [...cleaned];
  for (const surface of surfaces) {
    withSurfaces.push({
      type: "ui_surface",
      surfaceId: surface.surfaceId,
      surfaceType: surface.surfaceType,
      title: surface.title,
      data: surface.data,
      actions: surface.actions,
      display: surface.display,
      ...(surface.persistent ? { persistent: true } : {}),
      ...(surface.toolCallId ? { toolCallId: surface.toolCallId } : {}),
    } as unknown as ContentBlock);
  }
  return withSurfaces.map((block) => {
    if (block.type === "text") {
      const tb = block as Extract<ContentBlock, { type: "text" }>;
      return { ...tb, text: redactSecrets(tb.text) };
    }
    // Native server tools (Anthropic web_search) resolve mid-stream — their
    // `server_tool_complete` fires before `message_complete` — so the captured
    // activity is available at persist time. Stamp it on the server_tool_use
    // block here so the web-search card survives a history reopen. External
    // tool_use activity arrives only with the later tool_result, so it is
    // stamped in `annotatePersistedAssistantMessage` instead.
    if (block.type === "server_tool_use" && activityByToolUseId) {
      const activity = activityByToolUseId.get(block.id);
      if (activity) {
        return { ...block, _activityMetadata: activity } as ContentBlock;
      }
    }
    return block;
  });
}

/**
 * Stamp `_startedAt`/`_completedAt` onto the content's thinking blocks from the
 * per-block timing captured while streaming, matched by position: the `i`-th
 * thinking block in `content` takes `timings[i]`. The `_`-prefixed fields are
 * vellum-internal metadata (never sent to providers), mirroring how tool calls
 * persist timing; `renderHistoryContent` reads them back onto the wire schema's
 * `startedAt`/`completedAt`.
 *
 * Timing is only captured when reasoning is streamed (`streamThinking`), so a
 * turn with thinking disabled — or any block without a matching entry — is left
 * unstamped and the UI hides its duration, exactly as a tool call with no
 * timing does.
 */
export function stampThinkingTiming(
  content: ContentBlock[],
  timings: ReadonlyArray<{ startedAt: number; completedAt: number }>,
): ContentBlock[] {
  if (timings.length === 0) {
    return content;
  }
  let thinkingIdx = 0;
  return content.map((block) => {
    if (block.type !== "thinking") {
      return block;
    }
    const timing = timings[thinkingIdx++];
    if (!timing) {
      return block;
    }
    return {
      ...block,
      _startedAt: timing.startedAt,
      _completedAt: timing.completedAt,
    } as ContentBlock;
  });
}

/** Append a streamed text chunk to `state.currentMessageContent`, fusing into tail text block. */
function appendTextToCurrentMessage(
  state: EventHandlerState,
  text: string,
): void {
  if (text.length === 0) {
    return;
  }
  const tail = state.currentMessageContent.at(-1);
  if (tail && tail.type === "text") {
    tail.text = tail.text + text;
  } else {
    state.currentMessageContent.push({ type: "text", text });
  }
}

/**
 * Append a streamed thinking chunk to `state.currentMessageContent`, fusing
 * into the tail thinking block. The streamed delta carries no provider
 * `signature` (that arrives only when the block closes), so the mirrored block
 * holds an empty one; `message_complete` overwrites the row with the
 * authoritative signed content before it is ever sent back to a provider.
 */
function appendThinkingToCurrentMessage(
  state: EventHandlerState,
  thinking: string,
): void {
  if (thinking.length === 0) {
    return;
  }
  const now = Date.now();
  const tail = state.currentMessageContent.at(-1);
  if (tail && tail.type === "thinking") {
    tail.thinking = tail.thinking + thinking;
    const timing = state.currentThinkingTimestamps.at(-1);
    if (timing) {
      timing.completedAt = now;
    }
  } else {
    state.currentMessageContent.push({
      type: "thinking",
      thinking,
      signature: "",
    });
    state.currentThinkingTimestamps.push({ startedAt: now, completedAt: now });
  }
}

/** Reset partial-persist accumulator and any pending flush state. Idempotent. */
function resetPartialPersistAccumulator(state: EventHandlerState): void {
  if (state.pendingPartialFlushTimer !== undefined) {
    clearTimeout(state.pendingPartialFlushTimer);
    state.pendingPartialFlushTimer = undefined;
  }
  state.currentMessageContent = [];
  state.currentThinkingTimestamps = [];
  state.lastPersistedContentSeq = undefined;
  state.pendingPartialFlushPromise = undefined;
}

/**
 * Persist an in-loop message-content write, retrying transient SQLite write
 * contention (`SQLITE_BUSY`/`SQLITE_IOERR`) and swallowing a final failure so a
 * lock held by another writer cannot abort the turn. Every in-loop write
 * rewrites the full content snapshot of its assistant/tool-result row, so a
 * dropped write is overwritten by a later write in the same turn (the
 * end-of-turn finalize) or the next turn — missing one is a self-healing
 * cosmetic gap, not corruption.
 *
 * Returns whether the write committed, so callers can gate dependent
 * bookkeeping (e.g. advancing the persisted seq) on durable content.
 */
async function persistLoopMessageContent(
  messageId: string,
  contentJson: string,
  op: string,
  rlog: pino.Logger,
  metadataUpdates?: Record<string, unknown>,
): Promise<boolean> {
  try {
    // Metadata updates (e.g. the served model at finalize) ride the same
    // write as the content — `updateMessageContent` commits both atomically —
    // so a partial write can't leave them out of sync; the updates
    // shallow-merge onto the channel provenance stamped at reserve.
    await withSqliteRetry(
      () => updateMessageContent(messageId, contentJson, metadataUpdates),
      {
        op,
        context: { messageId },
      },
    );
    return true;
  } catch (err) {
    rlog.error(
      { err, messageId, op },
      "in-loop message-content write failed after retries; continuing without interrupting the turn",
    );
    return false;
  }
}

/** Flush `state.currentMessageContent` to the persisted assistant row. */
async function flushAccumulatedContent(
  state: EventHandlerState,
  deps: EventHandlerDeps,
): Promise<void> {
  const messageId = state.lastAssistantMessageId;
  if (messageId === undefined) {
    return;
  }
  if (state.currentMessageContent.length === 0) {
    return;
  }

  const built = buildPersistedAssistantContent(
    state.currentMessageContent,
    [],
    state.toolActivityMetadata,
  );
  const contentJson = JSON.stringify(built);
  // Pair the seq with the exact content snapshot taken above: deltas that
  // arrive while the write is in flight bump `lastPersistedContentSeq`
  // again, but they are not part of this write.
  const flushedSeq = state.lastPersistedContentSeq;

  const persisted = await persistLoopMessageContent(
    messageId,
    contentJson,
    "partial_flush_assistant_content",
    deps.rlog,
  );
  // Record only after the write commits, so the snapshot seq never
  // claims content that is not yet durable.
  if (persisted && flushedSeq != null) {
    recordConversationPersistedSeq(deps.ctx.conversationId, flushedSeq);
  }
}

/** Schedule a debounced partial flush. First-scheduled wins; no-op when timer pending. */
function schedulePartialFlush(
  state: EventHandlerState,
  deps: EventHandlerDeps,
): void {
  if (state.pendingPartialFlushTimer !== undefined) {
    return;
  }
  state.pendingPartialFlushTimer = setTimeout(() => {
    state.pendingPartialFlushTimer = undefined;
    const flushPromise = flushAccumulatedContent(state, deps);
    state.pendingPartialFlushPromise = flushPromise;
    void flushPromise.finally(() => {
      if (state.pendingPartialFlushPromise === flushPromise) {
        state.pendingPartialFlushPromise = undefined;
      }
    });
  }, PARTIAL_PERSIST_DEBOUNCE_MS);
}

// ── Shared Helper ────────────────────────────────────────────────────

// providerNameOverride should be supplied when the caller already knows the
// resolved provider name (e.g. handleUsage, which has event.actualProvider).
// When called during streaming (text_delta / thinking_delta) the override is
// omitted and provider.name is used — the CallSiteRoutingProvider getter
// returns the active transport name during sendMessage, so they agree.
// Passing the override from handleUsage guarantees started/finished never
// disagree even for tool-call-only responses where text_delta never fires
// (and therefore the started event would otherwise fall back here *after*
// the AsyncLocalStorage context in CallSiteRoutingProvider has already exited).
// ── Client Payload Size Caps ─────────────────────────────────────────
// tool_input_delta streams accumulated JSON as tools run. For non-app
// tools the client discards it (extractCodePreview only handles app tools),
// so we skip forwarding entirely to avoid transport/decode overhead.
const APP_TOOL_NAMES = new Set(["app_create"]);
const MAX_TOKENS_CONTINUE_PROMPT =
  "Continue from where you stopped. Do not repeat content you've already sent.";
const MAX_TOKENS_SURFACE_COMPLETION_SUMMARY = "Continue";

// ── Friendly Tool Names ──────────────────────────────────────────────

const TOOL_FRIENDLY_NAMES: Record<string, string> = {
  bash: "command",
  web_search: "web search",
  web_fetch: "web fetch",
  file_read: "file read",
  file_write: "file write",
  file_edit: "file edit",
  app_create: "app",
  app_refresh: "app refresh",
  skill_load: "skill",
  skill_execute: "skill",
};

function friendlyToolName(name: string): string {
  return TOOL_FRIENDLY_NAMES[name] ?? name.replace(/_/g, " ");
}

/**
 * Status text shown to the client while a web search is in flight.
 * Surfaces the actual query so the loading state is meaningful instead of
 * a generic "Searching the web". Used for both Anthropic native server-tool
 * starts and non-native `web_search` tool starts.
 */
export function formatSearchStatusText(
  toolName: string,
  query: string,
): string {
  if (toolName !== "web_search") {
    return `Running ${toolName}`;
  }
  const trimmed = query.trim();
  if (!trimmed) {
    return "Searching the web";
  }
  const truncated =
    trimmed.length > 60 ? trimmed.slice(0, 57) + "..." : trimmed;
  return `Searching "${truncated}"`;
}

/**
 * Status text shown to the client while a web fetch is in flight.
 * Surfaces the domain so users can tell what page is being read.
 */
export function formatFetchStatusText(url: unknown): string {
  if (typeof url !== "string") {
    return "Reading a page";
  }
  const domain = extractDomain(url);
  if (!domain) {
    return "Reading a page";
  }
  return `Reading ${domain}`;
}

function computeToolUseStatusText(
  name: string,
  input: Record<string, unknown>,
): string {
  if (name === "web_search") {
    const query = typeof input.query === "string" ? input.query : "";
    return formatSearchStatusText("web_search", query);
  }
  if (name === "web_fetch") {
    return formatFetchStatusText(input.url);
  }
  if (
    name === "skill_execute" &&
    typeof input.activity === "string" &&
    input.activity.length > 0
  ) {
    return input.activity;
  }
  return `Running ${friendlyToolName(name)}`;
}

function resolveAssistantReplyTimestampTimezone(ctx: Conversation): string {
  const config = getConfig();
  return resolveTurnTimezoneContext({
    configuredUserTimeZone: config.ui?.userTimezone ?? null,
    clientTimezone: ctx.clientTimezone ?? null,
    detectedTimezone: config.ui?.detectedTimezone ?? null,
    hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).effectiveTimezone;
}

/**
 * Assemble the metadata envelope written to the assistant message row.
 *
 * Stamped at reserve time (before `provider.sendMessage`) so the row carries
 * channel provenance from the moment it lands in SQLite, mirroring the
 * snapshot that handleMessageComplete used to compute at end-of-turn. All
 * inputs (channel context, trust context, turnStartedAt) are stable across
 * the LLM call, so building this once at reserve is equivalent to building
 * it at complete. Slack reply rows further stamp a `slackMeta` sub-object —
 * the `channelTs` field stays absent here and is back-filled by
 * `deliverReplyViaCallback` after the gateway returns the ts.
 */
function buildAssistantChannelMetadata(
  state: EventHandlerState,
  deps: EventHandlerDeps,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    ...provenanceFromTrustContext(deps.ctx.trustContext),
    userMessageChannel: deps.turnChannelContext.userMessageChannel,
    assistantMessageChannel: deps.turnChannelContext.assistantMessageChannel,
    userMessageInterface: deps.turnInterfaceContext.userMessageInterface,
    assistantMessageInterface:
      deps.turnInterfaceContext.assistantMessageInterface,
    sentAt: state.turnStartedAt,
  };

  if (deps.turnChannelContext.assistantMessageChannel === "slack") {
    const channelId = deps.ctx.trustContext?.requesterChatId;
    if (channelId) {
      const threadTs = getThreadTs(deps.ctx.conversationId);
      const timestampTimezone = resolveAssistantReplyTimestampTimezone(
        deps.ctx,
      );
      const timestampTimezoneLabel = formatSlackTimezoneLabel(
        timestampTimezone,
        { nowMs: state.turnStartedAt },
      );
      const partialSlackMeta: Partial<SlackMessageMetadata> = {
        source: "slack",
        eventKind: "message",
        channelId,
        ...(threadTs ? { threadTs } : {}),
        timestampTimezone,
        ...(timestampTimezoneLabel ? { timestampTimezoneLabel } : {}),
      };
      // `channelTs` is filled in by the post-send reconciliation step in
      // `deliverReplyViaCallback`; cast through the Partial to satisfy
      // the writer's type at this pre-send boundary.
      metadata.slackMeta = writeSlackMetadata(
        partialSlackMeta as SlackMessageMetadata,
      );
    }
  }

  return metadata;
}

/**
 * Reserve an empty assistant row for the LLM call about to begin, stash
 * its id on `state.lastAssistantMessageId`, and announce the boundary on
 * the wire via `assistant_turn_start`.
 *
 * Awaited so the row exists and the client has the anchor id BEFORE any
 * streaming delta arrives — every subsequent `deps.onEvent` in this LLM
 * call stamps `messageId: state.lastAssistantMessageId`, and
 * `handleMessageComplete` flushes the final content to the same row via
 * `op: "updateContent"` instead of inserting a fresh one.
 *
 * Multi-LLM-call agent turns (LLM call → tool execution → LLM call) emit
 * one `llm_call_started` per call, so each LLM call reserves its own row.
 * The read-path `findDisplayTurnEndIndex` collapses consecutive assistant
 * rows for the merged history view, matching today's per-call DB layout.
 */
export async function handleLlmCallStarted(
  state: EventHandlerState,
  deps: EventHandlerDeps,
): Promise<void> {
  // Clean up an orphaned reservation from a previous LLM call in this run
  // that errored before `message_complete` could finalize it. This covers
  // the retryable paths (overflow, ordering, image overflow) where the
  // agent loop re-enters with a fresh `run()` and reserves another row;
  // without this delete the failed-attempt row stays in the transcript as
  // an empty assistant bubble. The finalized-row case is filtered out via
  // the `assistantRowAwaitingFinalization` flag — `handleMessageComplete`
  // clears it after the successful `updateContent`, so the previous call's
  // committed row is never touched here.
  if (state.assistantRowAwaitingFinalization && state.lastAssistantMessageId) {
    try {
      deleteMessageById(state.lastAssistantMessageId);
    } catch (err) {
      // Non-fatal: a leaked empty row is preferable to a turn-level throw.
      deps.rlog.warn(
        { err, messageId: state.lastAssistantMessageId },
        "Failed to clean up stranded reserved assistant row before new reservation",
      );
    }
  }

  const metadata = buildAssistantChannelMetadata(state, deps);
  const reservedRow = await reserveMessage(
    deps.ctx.conversationId,
    "assistant",
    metadata,
  );
  state.lastAssistantMessageId = reservedRow.id;
  state.assistantRowAwaitingFinalization = true;
  // Fresh row → fresh accumulator. If an earlier (failed) LLM call
  // within the same run left partial state behind, the
  // `assistantRowAwaitingFinalization` cleanup above already deleted
  // the orphan row, so the accumulator content would point at a
  // non-existent id. Reset here so the new row starts from zero.
  resetPartialPersistAccumulator(state);
  deps.onEvent({
    type: "assistant_turn_start",
    messageId: reservedRow.id,
    conversationId: deps.ctx.conversationId,
  });
}

// ── Individual Handlers ──────────────────────────────────────────────

function handleTextDelta(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "text_delta" }>,
): void {
  state.pendingDirectiveDisplayBuffer += event.text;
  const drained = drainDirectiveDisplayBuffer(
    state.pendingDirectiveDisplayBuffer,
  );
  state.pendingDirectiveDisplayBuffer = drained.bufferedRemainder;
  if (drained.emitText.length > 0) {
    if (!state.firstTextDeltaEmitted) {
      state.firstTextDeltaEmitted = true;
      deps.ctx.emitActivityState("streaming", "first_text_delta", {
        requestId: deps.reqId,
        statusText: "Thinking",
      });
    }
    deps.onEvent({
      type: "assistant_text_delta",
      text: drained.emitText,
      conversationId: deps.ctx.conversationId,
      messageId: state.lastAssistantMessageId,
    });
    if (deps.shouldGenerateTitle) {
      state.firstAssistantText += drained.emitText;
    }
    // Mirror the drained delta into state.currentMessageContent so partial
    // flushes mid-turn see the same content the user is watching live.
    appendTextToCurrentMessage(state, drained.emitText);
    // The hub stamps `seq` synchronously on the delta emitted above, so
    // `getCurrentSeq()` here is that delta's seq -- the position the
    // mirrored content now reflects. A partial flush snapshots this to
    // record how far the durable rows track the live stream.
    state.lastPersistedContentSeq = getCurrentSeq();
    schedulePartialFlush(state, deps);
  }
}

function handleThinkingDelta(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "thinking_delta" }>,
): void {
  if (!state.firstThinkingDeltaEmitted) {
    state.firstThinkingDeltaEmitted = true;
    const lastToolName = state.lastCompletedToolName;
    // Only emit an activity state when a tool just completed, so we can
    // show "Processing <tool> results". When no tool has completed yet
    // (e.g. right after confirmation_resolved), skip the emission entirely
    // so the client preserves its current status text (e.g. "Resuming
    // after approval"). Even omitting statusText from the message would
    // cause the client to clear it, since the client overwrites
    // assistantStatusText for every assistant_activity_state event.
    if (lastToolName) {
      const statusText = `Processing ${friendlyToolName(lastToolName)} results`;
      deps.ctx.emitActivityState("thinking", "thinking_delta", {
        requestId: deps.reqId,
        statusText,
      });
    }
  }
  if (!deps.ctx.streamThinking) {
    return;
  }
  deps.onEvent({
    type: "assistant_thinking_delta",
    thinking: event.thinking,
    conversationId: deps.ctx.conversationId,
    messageId: state.lastAssistantMessageId,
    timestampMs: Date.now(),
  });
  // Mirror thinking into the same running view as text so the debounced
  // partial flush persists it mid-turn -- long reasoning streams survive a
  // refresh that outlives the SSE replay window, exactly as long answers do.
  appendThinkingToCurrentMessage(state, event.thinking);
  // The hub stamps `seq` synchronously on the delta emitted above, so
  // `getCurrentSeq()` is that delta's position in the mirrored content.
  state.lastPersistedContentSeq = getCurrentSeq();
  schedulePartialFlush(state, deps);
}

export function handleToolUse(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "tool_use" }>,
): void {
  state.toolUseIdToName.set(event.id, event.name);
  if (event.name === "app_create" || event.name === "app_refresh") {
    state.appBuildToolUsedThisRun = true;
  }
  const startedAt = Date.now();
  state.toolCallTimestamps.set(event.id, { startedAt });
  state.currentToolUseId = event.id;
  state.currentTurnToolUseIds.push(event.id);
  // Stamp the start time onto the already-durable tool_use block so a snapshot
  // fetched mid-tool (refresh / reconnect) carries it and clients can render a
  // running timer without having seen the live `tool_use_start` event.
  recordToolStartOnPersistedMessage(state, event.id, startedAt);
  // Mirror the first-byte preview timestamp onto the same durable block so a
  // mid-tool snapshot keeps the perceived-start anchor instead of falling back
  // to execution start. The block exists now (message_complete wrote it before
  // this tool event), unlike at `tool_use_preview_start` time.
  const previewStartedAt = state.toolPreviewStartedAt.get(event.id);
  if (previewStartedAt != null) {
    recordToolPreviewStartOnPersistedMessage(state, event.id, previewStartedAt);
  }
  const statusText = computeToolUseStatusText(event.name, event.input);
  deps.ctx.emitActivityState("tool_running", "tool_use_start", {
    requestId: deps.reqId,
    statusText,
  });
  deps.onEvent({
    type: "tool_use_start",
    toolName: event.name,
    input: event.input,
    conversationId: deps.ctx.conversationId,
    toolUseId: event.id,
    messageId: state.lastAssistantMessageId,
    startedAt,
    // Carry the first-byte timestamp through so a client that connected after
    // the preview event still anchors the perceived-latency timer to it.
    previewStartedAt: state.toolPreviewStartedAt.get(event.id),
  });
  // `message_complete` always precedes tool events (see handleMessageComplete),
  // so this tool_use block is already durable in the assistant row. The
  // `tool_use_start` emitted just above is therefore the newest stamped event
  // whose content the `/messages` snapshot already reflects -- advance the
  // persisted seq to it. Without this the snapshot would advertise a seq below
  // an event it already incorporates, and a client applying `seq > snapshot.seq`
  // would replay this tool start.
  recordConversationPersistedSeq(deps.ctx.conversationId, getCurrentSeq());
}

export function handleToolUsePreviewStart(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "tool_use_preview_start" }>,
): void {
  // Stamp the first-byte timestamp on the server clock. The user-perceived
  // latency timer anchors here, so clients can start rendering the tool card
  // and ticking elapsed time the moment the call is recognized — well before
  // its input finishes streaming (which can lag many seconds on a large input).
  //
  // We only record it in state here, not onto the persisted assistant row: the
  // tool_use block does not exist yet (message_complete writes it after the
  // stream ends, which is after this preview event). `handleToolUse` mirrors
  // this timestamp onto the durable block once it exists.
  const previewStartedAt = Date.now();
  state.toolPreviewStartedAt.set(event.toolUseId, previewStartedAt);
  deps.onEvent({
    type: "tool_use_preview_start",
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    conversationId: deps.ctx.conversationId,
    messageId: state.lastAssistantMessageId,
    previewStartedAt,
  });
  const statusText = `Preparing ${friendlyToolName(event.toolName)}...`;
  deps.ctx.emitActivityState("tool_running", "preview_start", {
    requestId: deps.reqId,
    statusText,
  });
}

function handleToolOutputChunk(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "tool_output_chunk" }>,
): void {
  let structured:
    | {
        subType?: "tool_start" | "tool_complete" | "status";
        subToolName?: string;
        subToolInput?: string;
        subToolIsError?: boolean;
        subToolId?: string;
      }
    | undefined;

  const trimmed = event.chunk.trimStart();
  if (trimmed.length > 0 && trimmed.length < 4096 && trimmed[0] === "{") {
    try {
      const parsed = JSON.parse(event.chunk);
      const VALID_SUB_TYPES = new Set([
        "tool_start",
        "tool_complete",
        "status",
      ]);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.subType === "string" &&
        VALID_SUB_TYPES.has(parsed.subType)
      ) {
        structured = {
          subType: parsed.subType as "tool_start" | "tool_complete" | "status",
          subToolName:
            typeof parsed.subToolName === "string"
              ? parsed.subToolName
              : undefined,
          subToolInput:
            typeof parsed.subToolInput === "string"
              ? parsed.subToolInput
              : undefined,
          subToolIsError:
            typeof parsed.subToolIsError === "boolean"
              ? parsed.subToolIsError
              : undefined,
          subToolId:
            typeof parsed.subToolId === "string" ? parsed.subToolId : undefined,
        };
      }
    } catch {
      // Not valid JSON — pass through as plain chunk
    }
  }

  if (structured) {
    deps.onEvent({
      type: "tool_output_chunk",
      chunk: event.chunk,
      conversationId: deps.ctx.conversationId,
      toolUseId: event.toolUseId,
      messageId: state.lastAssistantMessageId,
      subType: structured.subType,
      subToolName: structured.subToolName,
      subToolInput: structured.subToolInput,
      subToolIsError: structured.subToolIsError,
      subToolId: structured.subToolId,
    });
  } else {
    deps.onEvent({
      type: "tool_output_chunk",
      chunk: event.chunk,
      conversationId: deps.ctx.conversationId,
      toolUseId: event.toolUseId,
      messageId: state.lastAssistantMessageId,
    });
  }
}

export function handleInputJsonDelta(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "input_json_delta" }>,
): void {
  // Only forward input deltas for app tools — the client only uses this
  // stream for app_create code previews. Non-app tools would send large
  // cumulative JSON on every delta with no benefit.
  if (!APP_TOOL_NAMES.has(event.toolName)) {
    return;
  }
  deps.onEvent({
    type: "tool_input_delta",
    toolName: event.toolName,
    content: event.accumulatedJson,
    conversationId: deps.ctx.conversationId,
    toolUseId: event.toolUseId,
    messageId: state.lastAssistantMessageId,
  });
}

/**
 * Build the persisted `tool_result` content blocks for the buffered results,
 * redacting secrets from both the flat content and any structured blocks. All
 * results of one assistant turn share a single `user` row (the shape providers
 * expect for tool_result-in-user-turn).
 */
function buildToolResultBlocks(
  pending: ReadonlyMap<string, PendingToolResult>,
) {
  return Array.from(pending.entries()).map(([toolUseId, result]) => ({
    type: "tool_result",
    tool_use_id: toolUseId,
    content: redactSecrets(result.content),
    is_error: result.isError,
    ...(result.contentBlocks
      ? {
          contentBlocks: result.contentBlocks.map((block) =>
            block.type === "text"
              ? { ...block, text: redactSecrets(block.text) }
              : block,
          ),
        }
      : {}),
  }));
}

/**
 * Channel/interface provenance metadata for the grouped tool-result row,
 * stamped from the turn context so the row carries the same provenance the
 * snapshot reflects from the moment it lands in SQLite.
 */
function buildToolResultMetadata(
  deps: EventHandlerDeps,
): Record<string, unknown> {
  return {
    ...provenanceFromTrustContext(deps.ctx.trustContext),
    userMessageChannel: deps.turnChannelContext.userMessageChannel,
    assistantMessageChannel: deps.turnChannelContext.assistantMessageChannel,
    userMessageInterface: deps.turnInterfaceContext.userMessageInterface,
    assistantMessageInterface:
      deps.turnInterfaceContext.assistantMessageInterface,
  };
}

/**
 * Reserve the grouped `user` tool-result row for the current batch exactly
 * once. Parallel tool results are dispatched without awaiting (`agent/loop.ts`
 * emits each `tool_result` synchronously), so concurrent `handleToolResult`
 * calls can reach this before the first reservation resolves; sharing one
 * in-flight reservation promise keeps the whole batch in a single row. A
 * failed reservation resets the promise so the next caller can retry rather
 * than inheriting a settled rejection.
 */
function ensureToolResultRowReserved(
  state: EventHandlerState,
  conversationId: string,
  metadata: Record<string, unknown>,
): Promise<string> {
  if (state.pendingToolResultRowReservation === undefined) {
    state.pendingToolResultRowReservation = reserveMessage(
      conversationId,
      "user",
      metadata,
    )
      .then((reserved) => reserved.id)
      .catch((err) => {
        state.pendingToolResultRowReservation = undefined;
        throw err;
      });
  }
  return state.pendingToolResultRowReservation;
}

/**
 * Persist the buffered tool results into their grouped `user` row as each
 * result arrives, so a long-running tool's output survives a refresh that
 * outlives the SSE replay window. The row is reserved once per batch and
 * rewritten in place as sibling parallel results land, keeping all
 * `tool_result` blocks of one turn in a single message. `seq` is the position
 * stamped on the triggering `tool_result` event, captured by the caller before
 * any await so it reflects exactly the content now durable in the row.
 * Indexing and the buffer drain are deferred to `finalizePendingToolResultRow`.
 */
async function persistPendingToolResultRow(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  seq: number,
): Promise<void> {
  if (state.pendingToolResults.size === 0) {
    return;
  }
  const rowId = await ensureToolResultRowReserved(
    state,
    deps.ctx.conversationId,
    buildToolResultMetadata(deps),
  );
  // Serialize the content after the reservation resolves so the last of the
  // concurrent writers reflects the fullest batch.
  const persisted = await persistLoopMessageContent(
    rowId,
    JSON.stringify(buildToolResultBlocks(state.pendingToolResults)),
    "persist_tool_result_row",
    deps.rlog,
  );
  if (persisted) {
    recordConversationPersistedSeq(deps.ctx.conversationId, seq);
  }
  const conv = getConversation(deps.ctx.conversationId);
  if (conv != null) {
    syncMessageToDisk(deps.ctx.conversationId, rowId, conv.createdAt);
  }
}

/**
 * Finalize the grouped tool-result row at a turn/loop boundary: ensure the row
 * is reserved (a fallback for the case where every on-arrival write failed),
 * rewrite it to the full batch, sync it to disk, index it for memory recall,
 * and clear the batch state. Shared by `message_complete` and the orchestrator
 * loop-exit flush so an aborted or yielded turn finalizes the same reserved row
 * instead of writing a duplicate.
 */
export async function finalizePendingToolResultRow(
  state: EventHandlerState,
  conversationId: string,
  metadata: Record<string, unknown>,
  rlog: pino.Logger,
): Promise<void> {
  if (state.pendingToolResults.size === 0) {
    return;
  }
  const rowId = await ensureToolResultRowReserved(
    state,
    conversationId,
    metadata,
  );
  // `getConversation` returns `ConversationRow | null`, so `!= null` gates on a
  // real row (skipping media referencing / disk sync when the conversation was
  // not found rather than asking those helpers to resolve a missing id).
  const conv = getConversation(conversationId);
  // Swap any base64 media the tools produced (screenshots, generated images)
  // for workspace references so the blob stays in the attachment store, out of
  // this row and the lexical index. Runs once, here at finalize (on-arrival
  // writes keep base64 for durability); the send boundary re-inflates the refs.
  const blocks = buildToolResultBlocks(state.pendingToolResults);
  const contentJson = JSON.stringify(
    conv != null
      ? referenceMediaBlocksForPersist(
          conversationId,
          conv.createdAt,
          rowId,
          blocks as ContentBlock[],
        )
      : blocks,
  );
  await persistLoopMessageContent(
    rowId,
    contentJson,
    "finalize_tool_result_row",
    rlog,
  );
  // Sync the row to the JSONL disk view so it stays in lockstep with the DB.
  if (conv != null) {
    syncMessageToDisk(conversationId, rowId, conv.createdAt);
  }
  // `reserveMessage` + `updateMessageContent` are CRUD-only, so index the
  // finalized tool-result content explicitly here (mirroring the assistant-row
  // finalize) once it is durable. Non-fatal: a memory hiccup must not escalate
  // a successful turn into a throw.
  const row = getMessageById(rowId, conversationId);
  if (row) {
    let provenanceTrustClass:
      | "guardian"
      | "trusted_contact"
      | "unverified_contact"
      | "unknown"
      | undefined;
    let automated: boolean | undefined;
    if (row.metadata) {
      try {
        const parsedMeta = messageMetadataSchema.safeParse(
          JSON.parse(row.metadata),
        );
        if (parsedMeta.success) {
          provenanceTrustClass = parsedMeta.data.provenanceTrustClass;
          automated = parsedMeta.data.automated;
        }
      } catch {
        // Malformed metadata JSON — index with undefined provenance fields.
      }
    }
    try {
      await indexMessageNow(
        {
          messageId: rowId,
          conversationId,
          role: "user",
          content: contentJson,
          createdAt: row.createdAt,
          provenanceTrustClass,
          automated,
        },
        getConfig().memory,
      );
    } catch (err) {
      rlog.warn(
        { err, conversationId, messageId: rowId },
        "Failed to index tool-result message for memory (non-fatal)",
      );
    }
    // Dual-write the finalized tool-result content into the lexical index. The
    // reserve+finalize path bypasses the `addMessage` persist path, so enqueue
    // here to keep the lexical index in lockstep with the segment index.
    enqueueLexicalIndexForMessage(rowId);
  }
  for (const id of state.pendingToolResults.keys()) {
    state.persistedToolUseIds.add(id);
  }
  state.pendingToolResults.clear();
  state.pendingToolResultRowReservation = undefined;
}

export async function handleToolResult(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "tool_result" }>,
): Promise<void> {
  // A synthesized cancellation (the tool never executed) is captured for
  // persistence and forwarded to the client like any result, but skips every
  // side effect that assumes the tool ran. A real result already captured or
  // persisted for the same tool wins, so only fill genuine gaps.
  if (event.cancelled) {
    if (
      state.pendingToolResults.has(event.toolUseId) ||
      state.persistedToolUseIds.has(event.toolUseId)
    ) {
      return;
    }
    state.pendingToolResults.set(event.toolUseId, {
      content: event.content,
      isError: event.isError,
    });
    state.currentToolUseId = undefined;
    deps.onEvent({
      type: "tool_result",
      toolName: "",
      result: event.content,
      isError: event.isError,
      conversationId: deps.ctx.conversationId,
      messageId: state.lastAssistantMessageId,
      toolUseId: event.toolUseId,
    });
    // Capture the seq synchronously (before the persist await) so it reflects
    // the just-stamped tool_result event, then persist on arrival. A failure
    // here is non-fatal: the buffered result is still drained at
    // `message_complete`.
    const cancelledSeq = getCurrentSeq();
    try {
      await persistPendingToolResultRow(state, deps, cancelledSeq);
    } catch (err) {
      log.warn(
        { err, conversationId: deps.ctx.conversationId },
        "Failed to persist cancelled tool result on arrival (non-fatal; retried at message_complete)",
      );
    }
    return;
  }

  const imageBlocks = event.contentBlocks?.filter(
    (b): b is ImageContent => b.type === "image",
  );
  const imageDataList = imageBlocks?.length
    ? imageBlocks
        .map((b) => resolveMediaSourceData(b.source)?.data)
        .filter((d): d is string => d != null)
    : undefined;

  // Perform state mutations before deps.onEvent() so that if onEvent throws
  // (e.g. SSE disconnection) and the error is suppressed by dispatchAgentEvent,
  // critical state like pendingToolResults and currentToolUseId is still updated.
  state.pendingToolResults.set(event.toolUseId, {
    content: event.content,
    isError: event.isError,
    contentBlocks: event.contentBlocks,
  });

  // Record tool completion timestamp
  const completedAt = Date.now();
  const ts = state.toolCallTimestamps.get(event.toolUseId);
  if (ts) {
    ts.completedAt = completedAt;
  }
  state.currentToolUseId = undefined;

  // Capture risk metadata when present. autoApproved is true when the tool
  // was NOT prompted for confirmation (no entry in toolConfirmationOutcomes).
  // Confirmation outcomes are set BEFORE handleToolResult fires, so the map
  // is fully populated at this point.
  //
  // Known limitation: non-interactive sessions that auto-deny a tool without
  // prompting also have no confirmation outcome entry, so those denials are
  // recorded as autoApproved=true. This field is for DB/log analytics only
  // and has no UI impact; consult _confirmationDecision for denial signal.
  if (event.riskLevel) {
    state.toolRiskOutcomes.set(event.toolUseId, {
      riskLevel: event.riskLevel,
      riskReason: event.riskReason,
      autoApproved: !state.toolConfirmationOutcomes.has(event.toolUseId),
      matchedTrustRuleId: event.matchedTrustRuleId,
      approvalMode: event.approvalMode,
      approvalReason: event.approvalReason,
      riskThreshold: event.riskThreshold,
      // Capture the 3 risk-option arrays so the persisted tool_use block
      // carries the same chip ladder as the live tool_result event. Without
      // these, hydrated chips from chat history fall back to the synthesized
      // `*` allowlist and an empty scope ladder (see the comment on
      // `synthesizeFallbackOption` in web's RuleEditorModal).
      riskScopeOptions: event.riskScopeOptions,
      riskAllowlistOptions: event.riskAllowlistOptions,
      riskDirectoryScopeOptions: event.riskDirectoryScopeOptions,
    });
  }

  // Capture tool activity (web_search / web_fetch) so it can be persisted on
  // the tool_use block and the activity card survives a history reopen,
  // matching the live tool_result event's activityMetadata.
  if (event.activityMetadata) {
    state.toolActivityMetadata.set(event.toolUseId, event.activityMetadata);
  }

  const toolName = state.toolUseIdToName.get(event.toolUseId);
  if (toolName === "file_write" || toolName === "bash") {
    deps.ctx.markWorkspaceTopLevelDirty();
  } else if (toolName === "file_edit" && !event.isError) {
    deps.ctx.markWorkspaceTopLevelDirty();
  }

  if (event.contentBlocks) {
    for (const cb of event.contentBlocks) {
      if (cb.type === "image" || cb.type === "file") {
        state.accumulatedToolContentBlocks.push(cb);
        if (toolName) {
          state.toolContentBlockToolNames.set(
            state.accumulatedToolContentBlocks.length - 1,
            toolName,
          );
        }
      }
    }
  }

  // Track last completed tool for contextual statusText on next thinking phase
  state.lastCompletedToolName = state.toolUseIdToName.get(event.toolUseId);

  // Reset so that the next LLM exchange (think → stream) after this tool
  // call re-emits the activity state transitions.
  state.firstTextDeltaEmitted = false;
  state.firstThinkingDeltaEmitted = false;

  // Emit activity state immediately so clients show a thinking indicator
  // during the gap between tool_result and the next thinking_delta/text_delta.
  const statusText = `Processing ${friendlyToolName(
    state.lastCompletedToolName ?? "",
  )} results`;
  deps.ctx.emitActivityState("thinking", "tool_result_received", {
    requestId: deps.reqId,
    statusText,
  });

  // Once all tools for this turn have completed, annotate the persisted
  // assistant message with timing and confirmation metadata.
  const allToolsDone = state.currentTurnToolUseIds.every((id) => {
    const ts = state.toolCallTimestamps.get(id);
    return ts && ts.completedAt != null;
  });
  if (allToolsDone && state.currentTurnToolUseIds.length > 0) {
    try {
      annotatePersistedAssistantMessage(state, deps);
    } catch (err) {
      log.warn(
        { err, conversationId: deps.ctx.conversationId },
        "Failed to annotate persisted assistant message (non-fatal)",
      );
    }
  }

  // Send to client last so state is consistent even if onEvent throws.
  deps.onEvent({
    type: "tool_result",
    toolName: "",
    result: event.content,
    isError: event.isError,
    diff: event.diff,
    status: event.status,
    conversationId: deps.ctx.conversationId,
    messageId: state.lastAssistantMessageId,
    imageData: imageDataList?.[0],
    imageDataList,
    toolUseId: event.toolUseId,
    riskLevel: event.riskLevel,
    riskReason: event.riskReason,
    matchedTrustRuleId: event.matchedTrustRuleId,
    isContainerized: event.isContainerized,
    riskScopeOptions: event.riskScopeOptions,
    riskAllowlistOptions: event.riskAllowlistOptions,
    riskDirectoryScopeOptions: event.riskDirectoryScopeOptions,
    approvalMode: event.approvalMode,
    approvalReason: event.approvalReason,
    riskThreshold: event.riskThreshold,
    activityMetadata: event.activityMetadata,
    completedAt,
  });

  // Capture the seq synchronously (before the persist await) so it reflects the
  // just-stamped tool_result event, then persist the grouped row on arrival. A
  // failure here is non-fatal: the buffered result is still drained at
  // `message_complete`.
  const resultSeq = getCurrentSeq();
  try {
    await persistPendingToolResultRow(state, deps, resultSeq);
  } catch (err) {
    log.warn(
      { err, conversationId: deps.ctx.conversationId },
      "Failed to persist tool result on arrival (non-fatal; retried at message_complete)",
    );
  }
}

/**
 * Stamp `_startedAt` onto the in-flight tool_use block in the persisted
 * assistant message the moment the tool begins. The block is already durable
 * (message_complete precedes tool events), so without this a `/messages`
 * snapshot fetched mid-tool would carry no start time and clients could not
 * render a running elapsed-time counter until the whole turn finished. The
 * full timing + risk annotation still happens in
 * `annotatePersistedAssistantMessage` once every tool in the turn completes.
 */
function recordToolStartOnPersistedMessage(
  state: EventHandlerState,
  toolUseId: string,
  startedAt: number,
): void {
  const messageId = state.lastAssistantMessageId;
  if (!messageId) {
    return;
  }

  const row = getMessageById(messageId);
  if (!row) {
    return;
  }

  let content: ContentBlock[];
  try {
    content = JSON.parse(row.content) as ContentBlock[];
  } catch {
    return;
  }

  for (const block of content) {
    if (block.type !== "tool_use") {
      continue;
    }
    const rec = block as unknown as Record<string, unknown>;
    if (rec.id !== toolUseId) {
      continue;
    }
    if (rec._startedAt === startedAt) {
      return;
    }
    rec._startedAt = startedAt;
    // Best-effort early stamp: `annotatePersistedAssistantMessage` re-stamps
    // once every tool in the turn completes, so a transient `SQLITE_BUSY` here
    // must not abort the turn — the end-of-turn write recovers it.
    try {
      updateMessageContent(messageId, JSON.stringify(content));
    } catch (err) {
      log.error(
        { err, messageId },
        "stamping tool start time failed; end-of-turn annotation will recover",
      );
    }
    return;
  }
}

/**
 * Stamp `_previewStartedAt` (the first-byte timestamp) onto the durable
 * tool_use block, mirroring `recordToolStartOnPersistedMessage`. Called from
 * `handleToolUse` rather than `handleToolUsePreviewStart`: the block only exists
 * once message_complete has written it, which happens after the preview event
 * but before the tool event. Without this a `/messages` snapshot fetched
 * mid-tool would lose the perceived-start anchor and clients would fall back to
 * execution start — hiding the input-streaming gap the user actually waited
 * through.
 */
function recordToolPreviewStartOnPersistedMessage(
  state: EventHandlerState,
  toolUseId: string,
  previewStartedAt: number,
): void {
  const messageId = state.lastAssistantMessageId;
  if (!messageId) {
    return;
  }

  const row = getMessageById(messageId);
  if (!row) {
    return;
  }

  let content: ContentBlock[];
  try {
    content = JSON.parse(row.content) as ContentBlock[];
  } catch {
    return;
  }

  for (const block of content) {
    if (block.type !== "tool_use") {
      continue;
    }
    const rec = block as unknown as Record<string, unknown>;
    if (rec.id !== toolUseId) {
      continue;
    }
    if (rec._previewStartedAt === previewStartedAt) {
      return;
    }
    rec._previewStartedAt = previewStartedAt;
    // Best-effort early stamp, mirroring `recordToolStartOnPersistedMessage`:
    // `annotatePersistedAssistantMessage` re-stamps at end of turn, so a
    // transient `SQLITE_BUSY` here must not abort the turn.
    try {
      updateMessageContent(messageId, JSON.stringify(content));
    } catch (err) {
      log.error(
        { err, messageId },
        "stamping tool preview-start time failed; end-of-turn annotation will recover",
      );
    }
    return;
  }
}

/**
 * After all tools for the current turn complete, fetch the persisted assistant
 * message, annotate its tool_use blocks with timing and confirmation metadata,
 * and update the DB. This runs post-tool-execution so the metadata maps are
 * fully populated (unlike message_complete which fires before tools run).
 */
function annotatePersistedAssistantMessage(
  state: EventHandlerState,
  deps: EventHandlerDeps,
): void {
  const messageId = state.lastAssistantMessageId;
  if (!messageId) {
    return;
  }

  const row = getMessageById(messageId);
  if (!row) {
    return;
  }

  let content: ContentBlock[];
  try {
    content = JSON.parse(row.content) as ContentBlock[];
  } catch {
    return;
  }

  let modified = false;
  for (const block of content) {
    if (block.type === "tool_use") {
      const rec = block as unknown as Record<string, unknown>;
      const id = rec.id as string | undefined;
      if (!id) {
        continue;
      }

      const ts = state.toolCallTimestamps.get(id);
      if (ts) {
        rec._startedAt = ts.startedAt;
        if (ts.completedAt != null) {
          rec._completedAt = ts.completedAt;
        }
        modified = true;
      }
      const previewStartedAt = state.toolPreviewStartedAt.get(id);
      if (previewStartedAt != null) {
        rec._previewStartedAt = previewStartedAt;
        modified = true;
      }
      const confirmation = state.toolConfirmationOutcomes.get(id);
      if (confirmation) {
        rec._confirmationDecision = confirmation.decision;
        rec._confirmationLabel = confirmation.label;
        modified = true;
      }
      const risk = state.toolRiskOutcomes.get(id);
      if (risk) {
        rec._riskLevel = risk.riskLevel;
        if (risk.riskReason) {
          rec._riskReason = risk.riskReason;
        }
        rec._autoApproved = risk.autoApproved;
        if (risk.matchedTrustRuleId) {
          rec._matchedTrustRuleId = risk.matchedTrustRuleId;
        }
        if (risk.approvalMode) {
          rec._approvalMode = risk.approvalMode;
        }
        if (risk.approvalReason) {
          rec._approvalReason = risk.approvalReason;
        }
        if (risk.riskThreshold) {
          rec._riskThreshold = risk.riskThreshold;
        }
        // Persist the 3 risk-option arrays so the rule editor's chip ladder
        // survives chat-history reload. These mirror the same-named fields
        // on the live `tool_result` event; clients should read them back via
        // `shared.ts` and treat them identically to the live values.
        if (risk.riskScopeOptions && risk.riskScopeOptions.length > 0) {
          rec._riskScopeOptions = risk.riskScopeOptions;
        }
        if (risk.riskAllowlistOptions && risk.riskAllowlistOptions.length > 0) {
          rec._riskAllowlistOptions = risk.riskAllowlistOptions;
        }
        if (
          risk.riskDirectoryScopeOptions &&
          risk.riskDirectoryScopeOptions.length > 0
        ) {
          rec._riskDirectoryScopeOptions = risk.riskDirectoryScopeOptions;
        }
        modified = true;
      }
      // External provider tools (brave/perplexity/tavily) + web_fetch produce
      // their activity only when the tool_result lands, after message_complete
      // has already persisted this block — so it is stamped here. Native
      // server_tool_use activity is stamped earlier, at persist time, in
      // `buildPersistedAssistantContent`.
      const activity = state.toolActivityMetadata.get(id);
      if (activity) {
        rec._activityMetadata = activity;
        modified = true;
      }
    }
  }

  // Persist any surfaces created during tool execution.
  // message_complete fires BEFORE tools run, so currentTurnSurfaces is empty
  // at write time. We append them here after all tools have completed.
  if (deps.ctx.currentTurnSurfaces.length > 0) {
    for (const surface of deps.ctx.currentTurnSurfaces) {
      content.push({
        type: "ui_surface",
        surfaceId: surface.surfaceId,
        surfaceType: surface.surfaceType,
        title: surface.title,
        data: surface.data,
        actions: surface.actions,
        display: surface.display,
        ...(surface.persistent ? { persistent: true } : {}),
        ...(surface.toolCallId ? { toolCallId: surface.toolCallId } : {}),
        // Daemon-only commit-timing activation tag, persisted so
        // restoreSurfaceStateFromHistory can rehydrate it after a reload. This
        // block lives only in server-side conversation history, never in the
        // client `ui_surface_show` message.
        ...(surface.activationMoment
          ? { activationMoment: surface.activationMoment }
          : {}),
      } as unknown as ContentBlock);
    }
    modified = true;
    deps.ctx.currentTurnSurfaces = [];
  }

  if (modified) {
    // This end-of-turn write is best-effort: the caller wraps it in a
    // try/catch (and `dispatchAgentEvent` swallows `tool_result` handler
    // errors), so a transient `SQLITE_BUSY` here is logged and the turn
    // continues — it never reaches the turn-level catch.
    updateMessageContent(messageId, JSON.stringify(content));
  }

  // Clear for the next turn
  state.currentTurnToolUseIds = [];
}

function handleError(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "error" }>,
): void {
  const classified = classifyConversationError(event.error, {
    phase: "agent_loop",
  });
  if (classified.errorCategory === "provider_api_error") {
    log.error(
      {
        conversationId: deps.ctx.conversationId,
        errorCode: classified.code,
        errorCategory: classified.errorCategory,
        statusCode:
          event.error instanceof ProviderError
            ? event.error.statusCode
            : undefined,
        provider:
          event.error instanceof ProviderError
            ? event.error.provider
            : undefined,
        errorMessage: event.error.message,
      },
      "Provider rejected request with unclassified 4xx error",
    );
  }
  deps.onEvent(
    buildConversationErrorMessage(deps.ctx.conversationId, classified),
  );
  state.providerErrorUserMessage = classified.userMessage;
  state.providerErrorCode = classified.code;
  state.persistProviderErrorAsAssistantMessage =
    shouldPersistProviderErrorAsAssistantMessage(classified);
}

export function handleMaxTokensReached(
  _state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "max_tokens_reached" }>,
): void {
  const classified = maxTokensReachedClassification();
  const surfaceId = `max_tokens_${uuid()}`;
  const data: CardSurfaceData = {
    title: "Response limit reached",
    subtitle: "The partial response above was saved.",
    body: classified.userMessage,
  };
  const actions: SurfaceAction[] = [
    {
      id: "relay_prompt",
      label: "Continue",
      style: "primary",
      data: {
        prompt: MAX_TOKENS_CONTINUE_PROMPT,
        _completeSurface: true,
        _completionSummary: MAX_TOKENS_SURFACE_COMPLETION_SUMMARY,
      },
    },
  ];

  deps.ctx.surfaceState.set(surfaceId, {
    surfaceType: "card",
    title: data.title,
    data,
    actions,
  });
  deps.ctx.currentTurnSurfaces.push({
    surfaceId,
    surfaceType: "card",
    title: data.title,
    data,
    actions,
    display: "inline",
    persistent: true,
  });

  deps.rlog.warn(
    {
      conversationId: deps.ctx.conversationId,
      stopReason: event.stopReason,
      surfaceId,
    },
    "Surfacing max-tokens continuation card",
  );

  deps.onEvent({
    type: "ui_surface_show",
    conversationId: deps.ctx.conversationId,
    surfaceId,
    surfaceType: "card",
    title: data.title,
    data,
    actions,
    display: "inline",
    persistent: true,
  } as UiSurfaceShow);
}

export async function handleMessageComplete(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "message_complete" }>,
): Promise<void> {
  // A completed message means the model received the turn context, so record
  // any pending inference-profile-change notification. Guarded by the pending
  // slot so it fires once per turn; a turn that fails before reaching delivery
  // leaves the slot unconsumed and re-sends the notice next turn.
  if (state.pendingNotifiedInferenceProfile != null) {
    try {
      setLastNotifiedInferenceProfile(
        deps.ctx.conversationId,
        state.pendingNotifiedInferenceProfile,
      );
    } catch (err) {
      deps.rlog.warn(
        { conversationId: deps.ctx.conversationId, err },
        "Failed to persist last notified inference profile (non-fatal)",
      );
    }
    deps.ctx.lastNotifiedInferenceProfile =
      state.pendingNotifiedInferenceProfile;
    state.pendingNotifiedInferenceProfile = null;
  }

  // Reset per-turn tool tracking for the new turn.
  state.currentTurnToolUseIds = [];

  // Cancel any pending debounced partial flush and await an already
  // in-flight one before the authoritative `updateContent` below.
  // Without the timer-clear, a timer that fires during this handler
  // could double-write (idempotent in content but wastes a write) or
  // race ahead of the indexer/projector and serve a stale snapshot.
  // Without the await, a partial pipeline call that was dispatched a
  // moment before this handler can settle AFTER the final write and
  // overwrite the authoritative row.
  if (state.pendingPartialFlushTimer !== undefined) {
    clearTimeout(state.pendingPartialFlushTimer);
    state.pendingPartialFlushTimer = undefined;
  }
  if (state.pendingPartialFlushPromise !== undefined) {
    try {
      await state.pendingPartialFlushPromise;
    } catch {
      // The partial flush swallows its own pipeline errors via
      // `rlog.warn`; the `try`/`catch` here is defensive against
      // future changes that might surface them.
    }
    state.pendingPartialFlushPromise = undefined;
  }

  // Flush any remaining directive display buffer
  if (state.pendingDirectiveDisplayBuffer.length > 0) {
    deps.onEvent({
      type: "assistant_text_delta",
      text: state.pendingDirectiveDisplayBuffer,
      conversationId: deps.ctx.conversationId,
      messageId: state.lastAssistantMessageId,
    });
    if (deps.shouldGenerateTitle) {
      state.firstAssistantText += state.pendingDirectiveDisplayBuffer;
    }
    state.pendingDirectiveDisplayBuffer = "";
  }

  // Finalize the grouped tool-result row. Each result was persisted into this
  // row as it arrived (`persistPendingToolResultRow`); this rewrites it to the
  // full batch (covering the case where a mid-arrival write failed), indexes it
  // for memory recall, and clears the batch state.
  await finalizePendingToolResultRow(
    state,
    deps.ctx.conversationId,
    buildToolResultMetadata(deps),
    deps.rlog,
  );

  // Accumulate directives + warnings from the assistant content for
  // downstream attachment processing. `cleanAssistantContent` is also
  // called inside {@link buildPersistedAssistantContent} below; running
  // it here separately is the cheapest way to keep the directive
  // side-effects local to this handler while letting the shared helper
  // own the persisted-content shape.
  const { directives: msgDirectives, warnings: msgWarnings } =
    cleanAssistantContent(event.message.content);
  state.accumulatedDirectives.push(...msgDirectives);
  state.directiveWarnings.push(...msgWarnings);
  if (msgDirectives.length > 0) {
    deps.rlog.info(
      {
        parsedDirectives: msgDirectives.map((d) => ({
          source: d.source,
          path: d.path,
          mimeType: d.mimeType,
        })),
        totalAccumulated: state.accumulatedDirectives.length,
      },
      "Parsed attachment directives from assistant message",
    );
  }

  // NOTE: Tool timing/confirmation annotations are NOT applied here because
  // message_complete fires BEFORE tool_use/tool_result events. The annotations
  // are applied in handleToolResult after all tools for the turn complete,
  // then the persisted message is updated via updateMessageContent.

  // Build the canonical persisted content (cleaned + surfaces +
  // redacted) via the shared helper. The partial-persist flush uses
  // the same helper with `surfaces=[]` so a mid-turn snapshot lands in
  // the same shape as the finalize.
  const contentForPersistence = stampThinkingTiming(
    buildPersistedAssistantContent(
      event.message.content as ContentBlock[],
      deps.ctx.currentTurnSurfaces,
      state.toolActivityMetadata,
    ),
    state.currentThinkingTimestamps,
  );

  // The row was reserved at `llm_call_started` (with channel metadata
  // stamped at that point) and `state.lastAssistantMessageId` carries its
  // id. Flush the final content via `updateContent` instead of inserting a
  // new row. No `syncToDisk` flag here — the orchestrator separately
  // invokes `syncMessageToDisk` on `state.lastAssistantMessageId` after
  // the loop completes (see
  // `conversation-agent-loop.ts::syncLastAssistantMessageToDisk`).
  const assistantMessageId = state.lastAssistantMessageId;
  if (!assistantMessageId) {
    throw new Error(
      "handleMessageComplete fired without a prior llm_call_started reserving an assistant row",
    );
  }
  const contentJson = JSON.stringify(contentForPersistence);
  // Stamp the served model carried on the event (`response.model`, the same
  // value `llm_usage` records) onto the row alongside the content, so turn-trace
  // assembly can attribute each assistant message to the model that actually
  // ran it — including per-call reroutes by a `pre-model-call` hook. Absent on
  // synthesized completions with no provider response; the key is omitted then.
  const persisted = await persistLoopMessageContent(
    assistantMessageId,
    contentJson,
    "finalize_assistant_message",
    deps.rlog,
    event.model ? { model: event.model } : undefined,
  );
  state.assistantRowAwaitingFinalization = false;
  // The assistant row now holds the authoritative content (text + thinking +
  // tool_use blocks from `event.message`), and any drained tool-result rows
  // are durable. `lastPersistedContentSeq` is the last streamed text/thinking
  // delta's seq -- the highest stamped content event this row reflects -- so
  // recording it is honest. A drained tool result was stamped earlier in the
  // turn, so this seq already covers it; a call that streams no content (a
  // pure tool call) advances instead via `tool_use_start`.
  // `recordConversationPersistedSeq` clamps monotonically, so a lower value
  // here never regresses the seq. Gate on `persisted` so a swallowed finalize
  // write never advances the seq past content that is not durable.
  if (persisted && state.lastPersistedContentSeq != null) {
    recordConversationPersistedSeq(
      deps.ctx.conversationId,
      state.lastPersistedContentSeq,
    );
  }
  // Reset the partial-persist mirror so subsequent calls in this turn
  // start with an empty running view.
  state.currentMessageContent = [];
  state.currentThinkingTimestamps = [];
  state.lastPersistedContentSeq = undefined;

  // ── Indexing + attention projection (deferred off the critical path) ──
  // `reserveMessage` + `updateMessageContent` are CRUD-only — unlike
  // `addMessage`, they don't run the memory indexer or the attention-cursor
  // projector as insert side-effects — so the assistant row's external state
  // must be brought into lockstep explicitly. Neither gates delivery of the
  // reply or the composer re-enabling, so the work is queued here and drained
  // by the orchestrator after the terminal `message_complete` SSE fires (but
  // before the next turn). See `conversation-turn-finalize.ts`. The content
  // persisted synchronously above, so a snapshot/refetch on `message_complete`
  // still sees the full reply.
  state.deferredFinalizeEffects.push(
    buildDeferredFinalizeEffect({
      conversationId: deps.ctx.conversationId,
      assistantMessageId,
      contentJson,
      rlog: deps.rlog,
    }),
  );

  // Backfill message_id on all LLM request logs from this turn.
  // The agent loop is single-threaded per conversation, so all rows with
  // message_id IS NULL belong to the current turn. The reserved id was
  // available before the LLM call ran but the logs are inserted DURING
  // the call, so the sweep still runs here.
  try {
    backfillMessageIdOnLogs(deps.ctx.conversationId, assistantMessageId);
  } catch (err) {
    deps.rlog.warn(
      { err },
      "Failed to backfill message_id on LLM request logs (non-fatal)",
    );
  }

  try {
    backfillMemoryRecallLogMessageId(
      deps.ctx.conversationId,
      assistantMessageId,
    );
  } catch (err) {
    deps.rlog.warn(
      { err },
      "Failed to backfill message_id on memory recall log (non-fatal)",
    );
  }

  try {
    backfillMemoryV2ActivationMessageId(
      deps.ctx.conversationId,
      assistantMessageId,
    );
  } catch (err) {
    deps.rlog.warn(
      { err },
      "Failed to backfill memory v2 activation log messageId (non-fatal)",
    );
  }

  try {
    backfillMemoryV3SelectionMessageId(
      deps.ctx.conversationId,
      assistantMessageId,
    );
  } catch (err) {
    deps.rlog.warn(
      { err },
      "Failed to backfill memory v3 selection messageId (non-fatal)",
    );
  }

  deps.ctx.currentTurnSurfaces = [];
}

function handleUsage(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "usage" }>,
): void {
  const providerName = event.actualProvider ?? deps.ctx.provider.name;
  state.exchangeProviderName = providerName;
  state.exchangeLlmCallCount += 1;
  state.exchangeInputTokens += event.inputTokens;
  state.lastCallInputTokens = event.inputTokens;
  state.exchangeCacheCreationInputTokens += event.cacheCreationInputTokens ?? 0;
  state.exchangeCacheReadInputTokens += event.cacheReadInputTokens ?? 0;
  state.exchangeOutputTokens += event.outputTokens;
  state.model = event.model;

  // Feed the self-calibration loop: compare the pre-send estimate to the
  // provider's ground-truth inputTokens. `recordEstimate` silently ignores
  // samples below its magnitude threshold or outside its outlier bounds,
  // so it's safe to call unconditionally.
  //
  // The calibration key must match what `estimatePromptTokens` callers look
  // up — use the canonical provider key (`tokenEstimationProvider ?? name`),
  // falling back to the response's `actualProvider` only when neither hint
  // is set on the provider object (shouldn't happen, but cheap). Using
  // `event.actualProvider` as the primary key would scatter data across
  // mismatched keys for wrapper providers like OpenRouter.
  const calibrationProviderKey =
    getCalibrationProviderKey(deps.ctx.provider) ||
    (event.actualProvider ?? "");
  if (
    calibrationProviderKey.length > 0 &&
    event.estimatedInputTokens !== undefined &&
    event.estimatedInputTokens > 0
  ) {
    recordEstimate(
      calibrationProviderKey,
      event.model,
      event.estimatedInputTokens,
      event.inputTokens,
    );
  }
  if (event.rawResponse !== undefined) {
    state.exchangeRawResponses.push(event.rawResponse);
  }

  // Serialize this call's first-token latency segment and advance the cursor
  // so the next call in the turn serializes only its own marks. Non-fatal: a
  // tracking hiccup must never escalate into a turn-level throw.
  let latencyBreakdownJson: string | undefined;
  try {
    const segment = deps.latencyTracker?.serializeSince(state.latencyCursor);
    if (segment) {
      state.latencyCursor = segment.cursor;
      if (segment.breakdown) {
        latencyBreakdownJson = JSON.stringify(segment.breakdown);
      }
    }
  } catch (err) {
    deps.rlog.warn(
      { err },
      "Failed to serialize latency breakdown (non-fatal)",
    );
  }

  if (event.rawRequest && event.rawResponse) {
    try {
      recordRequestLog(
        deps.ctx.conversationId,
        JSON.stringify(event.rawRequest),
        JSON.stringify(event.rawResponse),
        undefined,
        providerName,
        "mainAgent",
        latencyBreakdownJson,
      );
    } catch (err) {
      deps.rlog.warn({ err }, "Failed to persist LLM request log (non-fatal)");
    }
  }

  // Emit a lightweight per-call usage progress event so clients can show
  // live-updating token/cost metrics. This is a UI hint only — no DB writes.
  const pricingUsage = buildPricingUsage({
    providerName,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheCreationInputTokens: event.cacheCreationInputTokens,
    cacheReadInputTokens: event.cacheReadInputTokens,
    rawResponse: event.rawResponse,
  });
  const pricing = resolveStructuredPricing(
    providerName,
    event.model,
    pricingUsage,
  );
  const estimatedCost =
    pricing.pricingStatus === "priced" && pricing.estimatedCostUsd != null
      ? pricing.estimatedCostUsd
      : 0;

  deps.onEvent({
    type: "usage_progress",
    conversationId: deps.ctx.conversationId,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    estimatedCost,
    model: event.model,
  });
}

/**
 * Persist a provider-rejected LLM call as an `llm_request_logs` row.
 *
 * Mirrors `handleUsage`'s recording side-effect for the failure path: the
 * loop only reaches the success branch (and emits `usage`) when the
 * provider returns a response, so without this handler a rejected call
 * leaves nothing in the inspector — only a pino line saying "The AI
 * provider rejected the request." The row's `messageId` is left null
 * here and linked via one of two backfill paths, depending on how the
 * turn unwinds:
 *
 *   - Multi-call turn where a later call also produces a real assistant
 *     response: `handleMessageComplete` -> `backfillMessageIdOnLogs`
 *     sweeps this row with the rest, same as a successful-call row.
 *   - Pure provider-failure turn (no real assistant response): the
 *     synthetic error-message branch in `conversation-agent-loop.ts`
 *     persists a stand-in assistant message and calls
 *     `backfillMessageIdOnLogs` itself, since `message_complete` is
 *     never emitted on that path. Closing the orphan window inside the
 *     same synchronous turn prevents a later turn's sweep from wrong-
 *     attaching this row to an unrelated assistant message.
 *
 * Failures inside the recording itself are logged and swallowed — this
 * mirrors `handleUsage`'s non-fatal stance so a DB hiccup never escalates
 * a provider rejection into a dispatcher-level throw.
 */
function handleProviderError(
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "provider_error" }>,
): void {
  const classified = classifyConversationError(event.error, {
    phase: "agent_loop",
  });
  if (!shouldPersistProviderErrorAsAssistantMessage(classified)) {
    return;
  }

  try {
    recordRequestLog(
      deps.ctx.conversationId,
      JSON.stringify(event.rawRequest),
      JSON.stringify(buildProviderErrorResponsePayload(event.error)),
      undefined,
      event.actualProvider,
      "mainAgent",
    );
  } catch (err) {
    deps.rlog.warn(
      { err },
      "Failed to persist provider-error LLM request log (non-fatal)",
    );
  }
}

// ── Dispatcher ───────────────────────────────────────────────────────

/** Routes an AgentEvent to the appropriate handler. */
export async function dispatchAgentEvent(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: AgentEvent,
): Promise<void> {
  // Section-trail breadcrumb for event-loop freeze attribution: the dispatch
  // is the single choke point for per-turn persistence work (message writes,
  // usage/request-log rows, SSE fan-out), so a watchdog report during a
  // handler names the event type that was being processed.
  const sectionMark = markSection(`agent-event:${event.type}`);
  try {
    switch (event.type) {
      case "llm_call_started":
        await handleLlmCallStarted(state, deps);
        break;
      case "text_delta":
        handleTextDelta(state, deps, event);
        break;
      case "thinking_delta":
        handleThinkingDelta(state, deps, event);
        break;
      case "tool_use":
        handleToolUse(state, deps, event);
        break;
      case "tool_use_preview_start":
        handleToolUsePreviewStart(state, deps, event);
        break;
      case "tool_output_chunk":
        handleToolOutputChunk(state, deps, event);
        break;
      case "input_json_delta":
        handleInputJsonDelta(state, deps, event);
        break;
      case "tool_result":
        await handleToolResult(state, deps, event);
        break;
      case "server_tool_start": {
        const query =
          typeof event.input.query === "string" ? event.input.query : "";
        const statusText = formatSearchStatusText(event.name, query);
        deps.ctx.emitActivityState("tool_running", "tool_use_start", {
          requestId: deps.reqId,
          statusText,
        });
        state.serverToolStartedAt.set(event.toolUseId, Date.now());
        state.serverToolInputs.set(event.toolUseId, event.input);
        deps.onEvent({
          type: "tool_use_start",
          toolName: event.name,
          input: event.input,
          conversationId: deps.ctx.conversationId,
          toolUseId: event.toolUseId,
          messageId: state.lastAssistantMessageId,
        });
        break;
      }
      case "server_tool_complete": {
        deps.ctx.emitActivityState("streaming", "tool_result_received", {
          requestId: deps.reqId,
          statusText: "Thinking",
        });

        // Prefer `resolvedInput` (Anthropic's accumulated server-tool input,
        // populated on content_block_stop) over the input captured at
        // server_tool_start, which is `{}` on Anthropic until the deltas land.
        const inputForCall =
          event.resolvedInput ?? state.serverToolInputs.get(event.toolUseId);
        const query =
          typeof inputForCall?.query === "string" ? inputForCall.query : "";
        const startedAt =
          state.serverToolStartedAt.get(event.toolUseId) ?? Date.now();
        const durationMs = Date.now() - startedAt;
        state.serverToolStartedAt.delete(event.toolUseId);
        state.serverToolInputs.delete(event.toolUseId);

        const rawBlocks = Array.isArray(event.content) ? event.content : [];
        const results: WebSearchResultItem[] = rawBlocks
          .filter(
            (r): r is { type: string; title: string; url: string } =>
              typeof r === "object" &&
              r != null &&
              (r as { type?: string }).type === "web_search_result",
          )
          .map((r, i) => {
            const domain = extractDomain(r.url);
            return {
              rank: i + 1,
              title: r.title,
              url: r.url,
              domain,
              faviconUrl: faviconUrlForDomain(domain),
              // snippet intentionally absent — Anthropic native content is encrypted/opaque
            };
          });

        // Only Anthropic produces structured `web_search_tool_result` blocks
        // that map cleanly onto `WebSearchMetadata` (provider-tagged
        // "anthropic-native"). Other providers (e.g. OpenAI's responses
        // `web_search_call`) share this event channel but their results are
        // woven into the text stream — emitting "anthropic-native" metadata
        // for them would mis-label the provider and ship empty results.
        const isAnthropicNative = deps.ctx.provider.name === "anthropic";

        // Classify provider failures through the shared normalizer so the same
        // friendly copy propagates to every client via WebSearchMetadata, while
        // the raw provider detail stays in telemetry only (ATL-727).
        const classification = classifyWebSearchFailure({
          errorCode: event.errorCode,
          error: event.errorMessage,
          isError: event.isError,
          hasResults: results.length > 0,
        });

        let errorMessage: string | undefined;
        let fallbackShown = false;
        if (event.isError) {
          // A genuine backend failure OR an unclassifiable, message-less native
          // failure (e.g. `isError:true` with no `error_code`) both surface the
          // friendly backend copy: a terse "Search failed" placeholder is the
          // confusing copy this normalization exists to eliminate (ATL-727).
          // Recoverable categories that carry a real user message
          // (query_too_long, max_uses_exceeded) keep their own copy.
          const useBackendCopy =
            classification.isBackendFailure || !classification.userMessage;
          if (useBackendCopy) {
            // Dedup the user-facing friendly notice per turn (request id) so a
            // burst of failures surfaces at most one full notice. The raw
            // provider error is preserved on every failure via telemetry below.
            const alreadyNotified = state.webSearchBackendFailureNotified.has(
              deps.reqId,
            );
            if (alreadyNotified) {
              errorMessage = "Search is still having trouble.";
            } else {
              state.webSearchBackendFailureNotified.add(deps.reqId);
              errorMessage = WEB_SEARCH_BACKEND_FAILURE_MESSAGE;
              fallbackShown = true;
            }

            // Backend-failure telemetry (provider outages / rate limits) must
            // fire only for genuine backend classifications so it does not
            // count recoverable input/quota errors — or a message-less unknown
            // failure that merely borrows the friendly copy — as provider
            // outages.
            if (classification.isBackendFailure) {
              logWebSearchBackendFailure(deps.rlog, {
                provider: isAnthropicNative
                  ? "anthropic-native"
                  : deps.ctx.provider.name,
                requestId: deps.reqId,
                errorCategory: classification.category,
                rawDetail: classification.rawDetail,
                fallbackShown,
                queryLength: query.length,
              });
            }
          } else {
            // Recoverable, non-backend categories with their own user-facing
            // copy (query_too_long, max_uses_exceeded) keep that message.
            errorMessage = classification.userMessage;
          }
        }

        const metadata: WebSearchMetadata | undefined = isAnthropicNative
          ? {
              query,
              provider: "anthropic-native",
              resultCount: results.length,
              durationMs,
              results,
              ...(errorMessage ? { errorMessage } : {}),
            }
          : undefined;

        const resultText = results
          .map((r) => `${r.title}\n${r.url}`)
          .join("\n\n");

        // Capture activity so it persists on the server_tool_use block and the
        // web-search card survives a history reopen, matching the live event.
        if (metadata) {
          state.toolActivityMetadata.set(event.toolUseId, {
            webSearch: metadata,
          });
        }

        deps.onEvent({
          type: "tool_result",
          toolName: "web_search",
          result: resultText,
          isError: event.isError,
          conversationId: deps.ctx.conversationId,
          toolUseId: event.toolUseId,
          messageId: state.lastAssistantMessageId,
          ...(metadata ? { activityMetadata: { webSearch: metadata } } : {}),
        });
        break;
      }
      case "context_compacting":
        recordCompactionStartBestEffort(deps.ctx.conversationId, event);
        // Buffer the pre-compaction history so the paired end event can
        // re-derive the stripped durable base.
        state.compactionStartMessages.set(event.compactionId, event.messages);
        deps.ctx.emitActivityState("thinking", "context_compacting", {
          requestId: deps.reqId,
          statusText: "Compacting context",
        });
        break;
      case "compaction_circuit_open":
      case "compaction_circuit_closed":
        // Circuit-breaker transitions are already in wire-contract shape
        // (a subset of ServerMessage), so forward them to the client sink
        // unchanged. They drive the client's "auto-compaction paused"
        // banner.
        deps.onEvent(event);
        break;
      case "compaction_completed": {
        // Always commit the stripped pre-compaction history as the durable
        // message base so re-injection re-applies onto the stripped history
        // even when the pipeline ran but did not compact. The base is
        // re-derived from the buffered start event's messages (the end event
        // carries only the pipeline's output). When the pipeline did compact,
        // commit the durable result (DB-record fields, Slack provenance,
        // SSE) — which overwrites `ctx.messages` with the compacted history.
        // This runs before the loop's `reinject` hook (the loop awaits this
        // dispatch), so the committed history is in place in time. A failed
        // durable commit re-throws below to abort the turn rather than
        // re-injecting against half-applied state.
        recordCompactionEndBestEffort(deps.ctx.conversationId, event);
        const startMessages = state.compactionStartMessages.get(
          event.compactionId,
        );
        state.compactionStartMessages.delete(event.compactionId);
        // Fall back to the pipeline's output when the start event was never
        // buffered — on the no-compaction path it is the stripped input.
        const strippedBase = startMessages
          ? stripInjectionsForCompaction(startMessages)
          : event.messages;
        deps.ctx.messages = strippedBase;
        if (event.compacted) {
          await deps.applyCompaction(event, strippedBase);
        }
        break;
      }
      case "history_stripped":
        // Record the history-stripped DB marker right after the loop strips
        // injections (before the pipeline). Best-effort: a transient marker
        // write must not abort the turn, so unlike `compaction_completed` this
        // is not on the re-throw allowlist below.
        markHistoryStrippedBestEffort(deps.ctx.conversationId);
        break;
      case "error":
        handleError(state, deps, event);
        break;
      case "max_tokens_reached":
        handleMaxTokensReached(state, deps, event);
        break;
      case "provider_error":
        handleProviderError(deps, event);
        break;
      case "message_complete":
        await handleMessageComplete(state, deps, event);
        break;
      case "usage":
        handleUsage(state, deps, event);
        break;
      case "agent_loop_exit":
        // Stamp the exit reason onto the most-recent llm_request_logs
        // row for this conversation. The final `usage` event of the run
        // lands its row immediately before this event arrives (in the
        // normal-dispatch path; the wake path handles ordering
        // explicitly via `pendingExitReason`).
        //
        // Wrapped in try/catch so a DB hiccup here can't tear down the
        // surrounding dispatch — the outer try/catch already swallows
        // errors, but logging here gives the diagnosis hook a clear
        // attribution to the exit handler specifically.
        try {
          setAgentLoopExitReasonOnLatestLog(
            deps.ctx.conversationId,
            event.reason,
          );
        } catch (err) {
          log.warn(
            {
              err,
              conversationId: deps.ctx.conversationId,
              reason: event.reason,
            },
            "Failed to persist agent_loop_exit_reason (non-fatal)",
          );
        }
        break;
      case "system_prompt_changed":
        deps.ctx.systemPrompt = event.systemPrompt;
        break;
    }
  } catch (err) {
    log.error(
      { err, eventType: event.type, conversationId: deps.ctx.conversationId },
      "Event dispatch failed; suppressing to keep agent loop alive",
    );
    // Re-throw errors from critical handlers that must not be silently swallowed:
    // - message_complete: persists assistant message to DB, sets state flags
    // - error: triggers image recovery or surfaces the user-facing error
    //   message
    // - usage: records token accounting
    // - compaction_completed: durable compaction commit; aborting the turn is
    //   safer than re-injecting against a half-applied compaction
    if (
      event.type === "message_complete" ||
      event.type === "error" ||
      event.type === "usage" ||
      event.type === "compaction_completed"
    ) {
      throw err;
    }
  } finally {
    endSection(sectionMark);
  }
}
