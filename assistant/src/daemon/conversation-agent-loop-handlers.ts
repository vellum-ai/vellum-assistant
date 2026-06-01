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
import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { recordEstimate } from "../context/estimator-calibration.js";
import { getCalibrationProviderKey } from "../context/token-estimator.js";
import { projectAssistantMessage } from "../memory/conversation-attention-store.js";
import {
  deleteMessageById,
  getConversation,
  getMessageById,
  messageMetadataSchema,
  provenanceFromTrustContext,
  updateMessageContent,
} from "../memory/conversation-crud.js";
import { indexMessageNow } from "../memory/indexer.js";
import {
  backfillMessageIdOnLogs,
  buildProviderErrorResponsePayload,
  recordRequestLog,
  setAgentLoopExitReasonOnLatestLog,
} from "../memory/llm-request-log-store.js";
import { backfillMemoryRecallLogMessageId } from "../memory/memory-recall-log-store.js";
import { backfillMemoryV2ActivationMessageId } from "../memory/memory-v2-activation-log-store.js";
import { getThreadTs } from "../memory/slack-thread-store.js";
import {
  formatSlackTimezoneLabel,
  type SlackMessageMetadata,
  writeSlackMetadata,
} from "../messaging/providers/slack/message-metadata.js";
import { defaultPersistenceTerminal } from "../plugins/defaults/persistence/terminal.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import { getMiddlewaresFor } from "../plugins/registry.js";
import type {
  PersistArgs,
  PersistReserveResult,
  PersistResult,
  TurnContext,
} from "../plugins/types.js";
import type { ContentBlock, ImageContent } from "../providers/types.js";
import { isContextOverflowError } from "../providers/types.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";
import { redactSecrets } from "../security/secret-scanner.js";
import { extractDomain } from "../tools/network/domain-normalize.js";
import {
  buildPricingUsage,
  resolveStructuredPricing,
} from "../usage/pricing.js";
import { ProviderError } from "../util/errors.js";
import { faviconUrlForDomain } from "../util/favicon.js";
import { getLogger } from "../util/logger.js";
import type { DirectiveRequest } from "./assistant-attachments.js";
import {
  cleanAssistantContent,
  drainDirectiveDisplayBuffer,
} from "./assistant-attachments.js";
import type {
  AgentLoopConversationContext,
  AssistantSurface,
} from "./conversation-agent-loop.js";
import {
  buildConversationErrorMessage,
  classifyConversationError,
  isContextTooLarge,
  maxTokensReachedClassification,
} from "./conversation-error.js";
import { isProviderOrderingError } from "./conversation-slash.js";
import { resolveTurnTimezoneContext } from "./date-context.js";
import type {
  CardSurfaceData,
  ServerMessage,
  SurfaceAction,
  UiSurfaceShow,
} from "./message-protocol.js";
import { conversationMetadataSyncTag } from "./message-types/sync.js";
import type {
  WebSearchMetadata,
  WebSearchResultItem,
} from "./message-types/web-activity.js";
import { FALLBACK_TURN_TRUST } from "./trust-context.js";

const log = getLogger("agent-loop-handlers");

// ── Partial-persistence tunables ─────────────────────────────────────
// Debounce for mid-turn `updateContent` writes from text deltas.
// Indexer + projector still fire ONLY at `handleMessageComplete`.
const PARTIAL_PERSIST_DEBOUNCE_MS = 1000;

/**
 * Build a {@link TurnContext} from the handler's deps for pipeline logging
 * and plugin attribution.
 *
 * Reads `turnIndex` from `deps.ctx.turnCount` — the orchestrator-owned
 * per-turn counter that is stable for the entire duration of a single
 * `runAgentLoopImpl` invocation. The handlers fire after the orchestrator
 * has completed its in-turn pipeline work but before `ctx.turnCount++` runs
 * in the outer `finally` block, so this value always reflects the turn the
 * handler's event belongs to. Trust pulls from the per-turn snapshot first,
 * then the conversation-level context, then the canonical `unknown`
 * fallback so the required field stays populated for edge cases (fresh
 * conversations before the trust resolver runs, heartbeat turns that never
 * bind an actor).
 */
function buildHandlerTurnContext(deps: EventHandlerDeps): TurnContext {
  return {
    requestId: deps.reqId,
    conversationId: deps.ctx.conversationId,
    turnIndex: deps.ctx.turnCount,
    trust:
      deps.ctx.currentTurnTrustContext ??
      deps.ctx.trustContext ??
      FALLBACK_TURN_TRUST,
  };
}

// ── Types ────────────────────────────────────────────────────────────

export interface PendingToolResult {
  content: string;
  isError: boolean;
  contentBlocks?: ContentBlock[];
}

/** Mutable state shared across event handlers within a single agent loop run. */
export interface EventHandlerState {
  llmCallStartedEmitted: boolean;
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
  orderingErrorDetected: boolean;
  deferredOrderingError: string | null;
  contextTooLargeDetected: boolean;
  /**
   * Set when the provider rejects with an image-dimension error. The agent
   * loop strips or downscales oversized image blocks from ctx.messages and
   * retries once before surfacing an error to the user.
   */
  imageTooLargeDetected: boolean;
  /**
   * The provider error object when context_too_large is detected, preserved
   * so `parseActualTokensFromError` can prefer the typed
   * `ContextOverflowError` fields over the string-regex fallback. The
   * message is always reachable via `.message` on this object — no separate
   * field is needed.
   */
  contextTooLargeError: unknown;
  providerErrorUserMessage: string | null;
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
  /** tool_use_ids emitted in the current turn (populated in handleToolUse, cleared after annotation). */
  currentTurnToolUseIds: string[];
  /** Wall-clock time (ms since epoch) when the agent loop turn started, used as the display timestamp for assistant messages. */
  turnStartedAt: number;
  /** Wall-clock start time of native server tool calls, keyed by tool_use_id. */
  readonly serverToolStartedAt: Map<string, number>;
  /** Original input from server_tool_start, keyed by tool_use_id, so the complete handler can read the query. */
  readonly serverToolInputs: Map<string, Record<string, unknown>>;
  /** Active debounce timer for partial persistence; `undefined` when idle. */
  pendingPartialFlushTimer: ReturnType<typeof setTimeout> | undefined;
  /** In-flight partial flush write awaited at finalize to avoid overwrite races. */
  pendingPartialFlushPromise: Promise<void> | undefined;
  /** Running mirror of the in-flight assistant message's content. */
  currentMessageContent: ContentBlock[];
}

/** Immutable context shared across event handlers within a single agent loop run. */
export interface EventHandlerDeps {
  readonly ctx: AgentLoopConversationContext;
  readonly onEvent: (msg: ServerMessage) => void;
  readonly reqId: string;
  readonly isFirstMessage: boolean;
  /** Whether the conversation title is replaceable — controls firstAssistantText accumulation for title generation. */
  readonly shouldGenerateTitle: boolean;
  readonly rlog: pino.Logger;
  readonly turnChannelContext: TurnChannelContext;
  readonly turnInterfaceContext: TurnInterfaceContext;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createEventHandlerState(): EventHandlerState {
  return {
    llmCallStartedEmitted: false,
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
    orderingErrorDetected: false,
    deferredOrderingError: null,
    contextTooLargeDetected: false,
    imageTooLargeDetected: false,
    contextTooLargeError: null,
    providerErrorUserMessage: null,
    lastAssistantMessageId: undefined,
    assistantRowAwaitingFinalization: false,
    pendingToolResults: new Map(),
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
    currentToolUseId: undefined,
    requestIdToToolUseId: new Map(),
    toolConfirmationOutcomes: new Map(),
    toolRiskOutcomes: new Map(),
    currentTurnToolUseIds: [],
    turnStartedAt: Date.now(),
    serverToolStartedAt: new Map(),
    serverToolInputs: new Map(),
    pendingPartialFlushTimer: undefined,
    pendingPartialFlushPromise: undefined,
    currentMessageContent: [],
  };
}

// ── Partial-persistence helpers ──────────────────────────────────────

/** Canonical persisted-content build: clean → append surfaces → redact. */
function buildPersistedAssistantContent(
  rawBlocks: readonly ContentBlock[],
  surfaces: readonly AssistantSurface[],
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
    return block;
  });
}

/** Append a streamed text chunk to `state.currentMessageContent`, fusing into tail text block. */
function appendTextToCurrentMessage(
  state: EventHandlerState,
  text: string,
): void {
  if (text.length === 0) return;
  const tail = state.currentMessageContent.at(-1);
  if (tail && tail.type === "text") {
    tail.text = tail.text + text;
  } else {
    state.currentMessageContent.push({ type: "text", text });
  }
}

/** Reset partial-persist accumulator and any pending flush state. Idempotent. */
function resetPartialPersistAccumulator(state: EventHandlerState): void {
  if (state.pendingPartialFlushTimer !== undefined) {
    clearTimeout(state.pendingPartialFlushTimer);
    state.pendingPartialFlushTimer = undefined;
  }
  state.currentMessageContent = [];
  state.pendingPartialFlushPromise = undefined;
}

/** Flush `state.currentMessageContent` to the row via the persistence pipeline. */
async function flushAccumulatedContent(
  state: EventHandlerState,
  deps: EventHandlerDeps,
): Promise<void> {
  const messageId = state.lastAssistantMessageId;
  if (messageId === undefined) return;
  if (state.currentMessageContent.length === 0) return;

  const built = buildPersistedAssistantContent(state.currentMessageContent, []);
  const contentJson = JSON.stringify(built);

  try {
    await runPipeline<PersistArgs, PersistResult>(
      "persistence",
      getMiddlewaresFor("persistence"),
      defaultPersistenceTerminal,
      {
        op: "updateContent",
        messageId,
        content: contentJson,
      },
      buildHandlerTurnContext(deps),
      DEFAULT_TIMEOUTS.persistence,
    );
  } catch (err) {
    deps.rlog.warn(
      { err, messageId },
      "partial flush of accumulated assistant content failed; finalize at message_complete will recover",
    );
  }
}

/** Schedule a debounced partial flush. First-scheduled wins; no-op when timer pending. */
function schedulePartialFlush(
  state: EventHandlerState,
  deps: EventHandlerDeps,
): void {
  if (state.pendingPartialFlushTimer !== undefined) return;
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
function emitLlmCallStartedIfNeeded(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  providerNameOverride?: string,
): void {
  if (state.llmCallStartedEmitted) return;
  state.llmCallStartedEmitted = true;
  const providerName = providerNameOverride ?? deps.ctx.provider.name;
  deps.ctx.traceEmitter.emit(
    "llm_call_started",
    `LLM call to ${providerName}`,
    {
      requestId: deps.reqId,
      status: "info",
      attributes: {
        provider: providerName,
        model: state.model || "unknown",
      },
    },
  );
}

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
  if (toolName !== "web_search") return `Running ${toolName}`;
  const trimmed = query.trim();
  if (!trimmed) return "Searching the web";
  const truncated =
    trimmed.length > 60 ? trimmed.slice(0, 57) + "..." : trimmed;
  return `Searching "${truncated}"`;
}

/**
 * Status text shown to the client while a web fetch is in flight.
 * Surfaces the domain so users can tell what page is being read.
 */
export function formatFetchStatusText(url: unknown): string {
  if (typeof url !== "string") return "Reading a page";
  const domain = extractDomain(url);
  if (!domain) return "Reading a page";
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

function resolveAssistantReplyTimestampTimezone(
  ctx: AgentLoopConversationContext,
): string {
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
  //
  // Direct `deleteMessageById` (not via the `persistence` pipeline) is
  // intentional: a never-finalized reservation has no segments, no
  // attachments, and no observable history — undoing it isn't a real
  // persistence event for plugins to react to, so routing through the
  // pipeline would only widen the mock surface for no observability win.
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
  const reserveResult = (await runPipeline<PersistArgs, PersistResult>(
    "persistence",
    getMiddlewaresFor("persistence"),
    defaultPersistenceTerminal,
    {
      op: "reserve",
      conversationId: deps.ctx.conversationId,
      role: "assistant",
      metadata,
    },
    buildHandlerTurnContext(deps),
    DEFAULT_TIMEOUTS.persistence,
  )) as PersistReserveResult;
  state.lastAssistantMessageId = reserveResult.message.id;
  state.assistantRowAwaitingFinalization = true;
  // Fresh row → fresh accumulator. If an earlier (failed) LLM call
  // within the same run left partial state behind, the
  // `assistantRowAwaitingFinalization` cleanup above already deleted
  // the orphan row, so the accumulator content would point at a
  // non-existent id. Reset here so the new row starts from zero.
  resetPartialPersistAccumulator(state);
  deps.onEvent({
    type: "assistant_turn_start",
    messageId: reserveResult.message.id,
    conversationId: deps.ctx.conversationId,
  });
}

// ── Individual Handlers ──────────────────────────────────────────────

function handleTextDelta(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "text_delta" }>,
): void {
  emitLlmCallStartedIfNeeded(state, deps);
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
    if (deps.shouldGenerateTitle) state.firstAssistantText += drained.emitText;
    // Mirror the drained delta into state.currentMessageContent so partial
    // flushes mid-turn see the same content the user is watching live.
    appendTextToCurrentMessage(state, drained.emitText);
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
  if (!deps.ctx.streamThinking) return;
  emitLlmCallStartedIfNeeded(state, deps);
  deps.onEvent({
    type: "assistant_thinking_delta",
    thinking: event.thinking,
    conversationId: deps.ctx.conversationId,
    messageId: state.lastAssistantMessageId,
  });
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
  state.toolCallTimestamps.set(event.id, { startedAt: Date.now() });
  state.currentToolUseId = event.id;
  state.currentTurnToolUseIds.push(event.id);
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
  });
}

export function handleToolUsePreviewStart(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "tool_use_preview_start" }>,
): void {
  deps.onEvent({
    type: "tool_use_preview_start",
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    conversationId: deps.ctx.conversationId,
    messageId: state.lastAssistantMessageId,
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
  if (!APP_TOOL_NAMES.has(event.toolName)) return;
  deps.onEvent({
    type: "tool_input_delta",
    toolName: event.toolName,
    content: event.accumulatedJson,
    conversationId: deps.ctx.conversationId,
    toolUseId: event.toolUseId,
    messageId: state.lastAssistantMessageId,
  });
}

export function handleToolResult(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "tool_result" }>,
): void {
  const imageBlocks = event.contentBlocks?.filter(
    (b): b is ImageContent => b.type === "image",
  );
  const imageDataList = imageBlocks?.length
    ? imageBlocks.map((b) => b.source.data)
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
  const ts = state.toolCallTimestamps.get(event.toolUseId);
  if (ts) ts.completedAt = Date.now();
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
  });
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
  if (!messageId) return;

  const row = getMessageById(messageId);
  if (!row) return;

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
      if (!id) continue;

      const ts = state.toolCallTimestamps.get(id);
      if (ts) {
        rec._startedAt = ts.startedAt;
        if (ts.completedAt != null) {
          rec._completedAt = ts.completedAt;
        }
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
        if (risk.riskReason) rec._riskReason = risk.riskReason;
        rec._autoApproved = risk.autoApproved;
        if (risk.matchedTrustRuleId)
          rec._matchedTrustRuleId = risk.matchedTrustRuleId;
        if (risk.approvalMode) rec._approvalMode = risk.approvalMode;
        if (risk.approvalReason) rec._approvalReason = risk.approvalReason;
        if (risk.riskThreshold) rec._riskThreshold = risk.riskThreshold;
        // Persist the 3 risk-option arrays so the rule editor's chip ladder
        // survives chat-history reload. These mirror the same-named fields
        // on the live `tool_result` event; clients should read them back via
        // `shared.ts` and treat them identically to the live values.
        if (risk.riskScopeOptions && risk.riskScopeOptions.length > 0)
          rec._riskScopeOptions = risk.riskScopeOptions;
        if (risk.riskAllowlistOptions && risk.riskAllowlistOptions.length > 0)
          rec._riskAllowlistOptions = risk.riskAllowlistOptions;
        if (
          risk.riskDirectoryScopeOptions &&
          risk.riskDirectoryScopeOptions.length > 0
        )
          rec._riskDirectoryScopeOptions = risk.riskDirectoryScopeOptions;
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
      } as unknown as ContentBlock);
    }
    modified = true;
    deps.ctx.currentTurnSurfaces = [];
  }

  if (modified) {
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
  if (isProviderOrderingError(event.error.message)) {
    state.orderingErrorDetected = true;
    state.deferredOrderingError = event.error.message;
  } else if (isContextOverflowError(event.error)) {
    // Typed path — the provider client already classified this as overflow.
    state.contextTooLargeDetected = true;
    state.contextTooLargeError = event.error;
  } else if (isContextTooLarge(event.error.message)) {
    state.contextTooLargeDetected = true;
    state.contextTooLargeError = event.error;
  } else {
    const classified = classifyConversationError(event.error, {
      phase: "agent_loop",
    });
    if (classified.code === "CONTEXT_TOO_LARGE") {
      state.contextTooLargeDetected = true;
      state.contextTooLargeError = event.error;
    } else if (classified.code === "IMAGE_TOO_LARGE") {
      // Trigger silent recovery: the agent loop will strip/downscale images
      // in ctx.messages and retry once before surfacing an error.
      state.imageTooLargeDetected = true;
    } else if (
      classified.code === "PROVIDER_ORDERING" ||
      classified.code === "PROVIDER_WEB_SEARCH"
    ) {
      // Ordering errors detected via classifyConversationError (e.g. from ProviderError
      // with statusCode 400 and ordering message) — trigger the retry path.
      state.orderingErrorDetected = true;
      state.deferredOrderingError = event.error.message;
    } else {
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
    }
  }
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
    if (deps.shouldGenerateTitle)
      state.firstAssistantText += state.pendingDirectiveDisplayBuffer;
    state.pendingDirectiveDisplayBuffer = "";
  }

  // Persist pending tool results
  if (state.pendingToolResults.size > 0) {
    const toolResultBlocks = Array.from(state.pendingToolResults.entries()).map(
      ([toolUseId, result]) => ({
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
      }),
    );
    const toolResultMetadata = {
      ...provenanceFromTrustContext(deps.ctx.trustContext),
      userMessageChannel: deps.turnChannelContext.userMessageChannel,
      assistantMessageChannel: deps.turnChannelContext.assistantMessageChannel,
      userMessageInterface: deps.turnInterfaceContext.userMessageInterface,
      assistantMessageInterface:
        deps.turnInterfaceContext.assistantMessageInterface,
    };
    // Route the add + disk-view sync through the `persistence` pipeline so
    // plugins can observe or override both operations together. The default
    // plugin's terminal performs the add and, when `syncToDisk` is true,
    // immediately calls `syncMessageToDisk` against the just-persisted row.
    // `getConversation` returns `ConversationRow | null`, so `!= null`
    // gates on a real row (skipping the sync when the conversation was
    // not found rather than asking the disk-view to resolve a missing id).
    const convForToolResult = getConversation(deps.ctx.conversationId);
    await runPipeline<PersistArgs, PersistResult>(
      "persistence",
      getMiddlewaresFor("persistence"),
      defaultPersistenceTerminal,
      {
        op: "add",
        conversationId: deps.ctx.conversationId,
        role: "user",
        content: JSON.stringify(toolResultBlocks),
        metadata: toolResultMetadata,
        syncToDisk: convForToolResult != null,
        createdAtMs: convForToolResult?.createdAt,
      },
      buildHandlerTurnContext(deps),
      DEFAULT_TIMEOUTS.persistence,
    );
    for (const id of state.pendingToolResults.keys()) {
      state.persistedToolUseIds.add(id);
    }
    state.pendingToolResults.clear();
  }

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
  const contentForPersistence = buildPersistedAssistantContent(
    event.message.content as ContentBlock[],
    deps.ctx.currentTurnSurfaces,
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
  await runPipeline<PersistArgs, PersistResult>(
    "persistence",
    getMiddlewaresFor("persistence"),
    defaultPersistenceTerminal,
    {
      op: "updateContent",
      messageId: assistantMessageId,
      content: contentJson,
    },
    buildHandlerTurnContext(deps),
    DEFAULT_TIMEOUTS.persistence,
  );
  state.assistantRowAwaitingFinalization = false;
  // Reset the partial-persist mirror so subsequent calls in this turn
  // start with an empty running view.
  state.currentMessageContent = [];

  // ── Indexing + attention projection (restored from the pre-B3 `add` path) ──
  // `reserveMessage` + `updateMessageContent` are CRUD-only: they don't run
  // the memory indexer or the attention-cursor projector. The pre-B3 path
  // wrote the row via `addMessage`, which ran both as side-effects of the
  // insert. Calling them here keeps the assistant row's external state
  // (Qdrant segments, conversation attention cursor) in lockstep with the
  // finalized content. Both are non-fatal — a memory hiccup must not
  // escalate a successful generation into a turn-level throw. Indexing
  // intentionally fires AFTER `updateContent` succeeds so we never index
  // the empty reserved placeholder.
  const finalizedRow = getMessageById(
    assistantMessageId,
    deps.ctx.conversationId,
  );
  if (finalizedRow) {
    let provenanceTrustClass:
      | "guardian"
      | "trusted_contact"
      | "unknown"
      | undefined;
    let automated: boolean | undefined;
    if (finalizedRow.metadata) {
      try {
        const parsedMeta = messageMetadataSchema.safeParse(
          JSON.parse(finalizedRow.metadata),
        );
        if (parsedMeta.success) {
          provenanceTrustClass = parsedMeta.data.provenanceTrustClass;
          automated = parsedMeta.data.automated;
        }
      } catch {
        // Malformed metadata JSON — fall through with undefined fields,
        // matching the legacy behavior in `addMessage`.
      }
    }
    try {
      await indexMessageNow(
        {
          messageId: assistantMessageId,
          conversationId: deps.ctx.conversationId,
          role: "assistant",
          content: contentJson,
          createdAt: finalizedRow.createdAt,
          scopeId: "default",
          provenanceTrustClass,
          automated,
        },
        getConfig().memory,
      );
    } catch (err) {
      deps.rlog.warn(
        {
          err,
          conversationId: deps.ctx.conversationId,
          messageId: assistantMessageId,
        },
        "Failed to index assistant message for memory (non-fatal)",
      );
    }
    try {
      const attentionStateChanged = projectAssistantMessage({
        conversationId: deps.ctx.conversationId,
        messageId: assistantMessageId,
        messageAt: finalizedRow.createdAt,
      });
      if (attentionStateChanged) {
        void publishSyncInvalidation([
          conversationMetadataSyncTag(deps.ctx.conversationId),
        ]);
      }
    } catch (err) {
      deps.rlog.warn(
        {
          err,
          conversationId: deps.ctx.conversationId,
          messageId: assistantMessageId,
        },
        "Failed to project assistant message for attention tracking (non-fatal)",
      );
    }
  }

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

  deps.ctx.currentTurnSurfaces = [];

  // Emit trace event. Char count is computed from the cleaned +
  // redacted text blocks (UI surface blocks filtered out via the
  // type guard) — same shape as what was just persisted.
  const charCount = contentForPersistence
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .reduce((sum, b) => sum + b.text.length, 0);
  const toolUseCount = event.message.content.filter(
    (b) => b.type === "tool_use",
  ).length;
  deps.ctx.traceEmitter.emit(
    "assistant_message",
    "Assistant message complete",
    {
      requestId: deps.reqId,
      status: "success",
      attributes: { charCount, toolUseCount },
    },
  );
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

  if (event.rawRequest && event.rawResponse) {
    try {
      recordRequestLog(
        deps.ctx.conversationId,
        JSON.stringify(event.rawRequest),
        JSON.stringify(event.rawResponse),
        undefined,
        providerName,
        "mainAgent",
      );
    } catch (err) {
      deps.rlog.warn({ err }, "Failed to persist LLM request log (non-fatal)");
    }
  }

  // Pass providerName so that if text_delta never fired (tool-call-only
  // responses), the started event uses the same resolved name as finished.
  emitLlmCallStartedIfNeeded(state, deps, providerName);

  deps.ctx.traceEmitter.emit(
    "llm_call_finished",
    `LLM call to ${providerName} finished`,
    {
      requestId: deps.reqId,
      status: "success",
      attributes: {
        provider: providerName,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        latencyMs: event.providerDurationMs,
      },
    },
  );
  state.llmCallStartedEmitted = false;

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
        handleToolResult(state, deps, event);
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

        const errorMessage = event.isError
          ? (event.errorMessage ?? event.errorCode ?? "Search failed")
          : undefined;

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
        deps.ctx.emitActivityState("thinking", "context_compacting", {
          requestId: deps.reqId,
          statusText: "Compacting context",
        });
        break;
      case "compaction_timed_out":
        // A compaction-pipeline timeout is recorded against this
        // conversation's durable compaction circuit breaker, which trips
        // after repeated timeouts to suspend auto-compaction.
        await deps.ctx.agentLoop.compactionCircuit.recordOutcome(
          deps.ctx,
          true,
          deps.onEvent,
        );
        break;
      case "compaction_circuit_open":
      case "compaction_circuit_closed":
        // Circuit-breaker transitions are already in wire-contract shape
        // (a subset of ServerMessage), so forward them to the client sink
        // unchanged. They drive the client's "auto-compaction paused"
        // banner.
        deps.onEvent(event);
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
    }
  } catch (err) {
    log.error(
      { err, eventType: event.type, conversationId: deps.ctx.conversationId },
      "Event dispatch failed; suppressing to keep agent loop alive",
    );
    // Re-throw errors from critical handlers that must not be silently swallowed:
    // - message_complete: persists assistant message to DB, sets state flags
    // - error: sets recovery flags (contextTooLargeDetected, orderingErrorDetected)
    // - usage: records token accounting
    if (
      event.type === "message_complete" ||
      event.type === "error" ||
      event.type === "usage"
    ) {
      throw err;
    }
  }
}
