/**
 * Agent loop execution extracted from Conversation.runAgentLoop.
 *
 * This module contains the core agent loop orchestration: pre-flight
 * setup, event handling, retry logic, history reconstruction, and
 * completion event emission.  The Conversation class delegates its
 * runAgentLoop method here via the AgentLoopConversationContext interface.
 */

import { join } from "node:path";

import { v4 as uuid } from "uuid";

import type {
  AgentEvent,
  AgentLoop,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import { createAssistantMessage } from "../agent/message-types.js";
import type {
  ChannelId,
  InterfaceId,
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import {
  contextWindowConfigFromEffective,
  resolveEffectiveContextWindow,
} from "../config/llm-context-resolution.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type { ContextWindowConfig } from "../config/types.js";
import {
  derefToolResultReReads,
  postTurnTruncateToolResults,
} from "../context/post-turn-tool-result-truncation.js";
import {
  estimatePromptTokens,
  getCalibrationProviderKey,
} from "../context/token-estimator.js";
import type { ContextWindowManager } from "../context/window-manager.js";
import type { ToolProfiler } from "../events/tool-profiling-listener.js";
import { emitFeedEvent } from "../home/emit-feed-event.js";
import { writeRelationshipState } from "../home/relationship-state-writer.js";
import { rewriteFeedTitle } from "../home/rewrite-feed-title.js";
import {
  clearSentryConversationContext,
  setSentryConversationContext,
} from "../instrument.js";
import { commitAppTurnChanges } from "../memory/app-git-service.js";
import { getApp, listAppFiles, resolveAppDir } from "../memory/app-store.js";
import { enqueueAutoAnalysisOnCompaction } from "../memory/auto-analysis-enqueue.js";
import {
  clearStrippedInjectionMetadataForConversation,
  getConversation,
  getConversationOriginChannel,
  getConversationOriginInterface,
  getConversationOverrideProfileFromRow,
  getLastUserTimestampBefore,
  getMessageById,
  provenanceFromTrustContext,
  updateConversationContextWindow,
  updateConversationSlackContextWatermark,
} from "../memory/conversation-crud.js";
import { getResolvedConversationDirPath } from "../memory/conversation-directories.js";
import { syncMessageToDisk } from "../memory/conversation-disk-view.js";
import {
  isReplaceableTitle,
  queueRegenerateConversationTitle,
} from "../memory/conversation-title-service.js";
import type { ConversationGraphMemory } from "../memory/graph/conversation-graph-memory.js";
import { recordMemoryRecallLog } from "../memory/memory-recall-log-store.js";
import { PKB_WORKSPACE_SCOPE } from "../memory/pkb/types.js";
import type { QdrantSparseVector } from "../memory/qdrant-client.js";
import {
  readMemoryV2StaticContent,
  shouldLoadMemoryV2Static,
} from "../memory/v2/static-context.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import { defaultCompactionTerminal } from "../plugins/defaults/compaction.js";
import { defaultHistoryRepairTerminal } from "../plugins/defaults/history-repair.js";
import {
  asDefaultGraphPayload,
  type DefaultMemoryRetrievalDeps,
  type GraphMemoryPayload,
  runDefaultMemoryRetrieval,
} from "../plugins/defaults/memory-retrieval.js";
import { defaultPersistenceTerminal } from "../plugins/defaults/persistence.js";
import { defaultTitleGenerateTerminal } from "../plugins/defaults/title-generate.js";
import { defaultTokenEstimateTerminal } from "../plugins/defaults/token-estimate.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import { getMiddlewaresFor } from "../plugins/registry.js";
import type {
  CircuitBreakerArgs,
  CircuitBreakerResult,
  CompactionArgs,
  CompactionResult,
  EstimateArgs,
  EstimateResult,
  HistoryRepairArgs,
  HistoryRepairResult,
  MemoryArgs,
  MemoryResult,
  OverflowReduceArgs,
  OverflowReduceResult,
  PersistArgs,
  PersistResult,
  TurnContext as PluginTurnContext,
} from "../plugins/types.js";
import { PluginExecutionError, PluginTimeoutError } from "../plugins/types.js";
import {
  hasProactiveArtifactCompleted,
  runProactiveArtifactJob,
  tryClaimProactiveArtifactTrigger,
} from "../proactive-artifact/index.js";
import type {
  ContentBlock,
  Message,
  ToolDefinition,
} from "../providers/types.js";
import type { Provider } from "../providers/types.js";
import { resolveActorTrust } from "../runtime/actor-trust-resolver.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { redactSecrets } from "../security/secret-scanner.js";
import { getSubagentManager } from "../subagent/index.js";
import type { UsageActor } from "../usage/actors.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { timeAgo } from "../util/time.js";
import { truncate } from "../util/truncate.js";
import { getWorkspaceGitService } from "../workspace/git-service.js";
import { commitTurnChanges } from "../workspace/turn-commit.js";
import {
  type AssistantAttachmentDraft,
  cleanAssistantContent,
} from "./assistant-attachments.js";
import { cleanupBootstrapAfterTurnThreshold } from "./bootstrap-turn-cleanup.js";
import { resolveOverflowAction } from "./context-overflow-policy.js";
import {
  createInitialReducerState,
  reduceContextOverflow,
  type ReducerState,
} from "./context-overflow-reducer.js";
import {
  createEventHandlerState,
  dispatchAgentEvent,
  type EventHandlerDeps,
  getClientDisplayMessageId,
} from "./conversation-agent-loop-handlers.js";
import {
  approveHostAttachmentRead,
  resolveAssistantAttachments,
} from "./conversation-attachments.js";
import {
  buildConversationErrorMessage,
  classifyConversationError,
  isUserCancellation,
} from "./conversation-error.js";
import { raceWithTimeout } from "./conversation-media-retry.js";
import type { MessageQueue } from "./conversation-queue-manager.js";
import type { QueueDrainReason } from "./conversation-queue-manager.js";
import type {
  ActiveSurfaceContext,
  ChannelCapabilities,
  InboundActorContext,
  InjectionMode,
} from "./conversation-runtime-assembly.js";
import {
  applyRuntimeInjections,
  buildSubagentStatusBlock,
  buildUnifiedTurnContextBlock,
  findLastInjectedNowContent,
  getPkbAutoInjectList,
  getSlackCompactionWatermarkForPrefix,
  inboundActorContextFromTrust,
  inboundActorContextFromTrustContext,
  loadSlackActiveThreadFocusBlock,
  loadSlackChronologicalContext,
  type SlackChronologicalContext,
  stripInjectionsForCompaction,
} from "./conversation-runtime-assembly.js";
import type { SkillProjectionCache } from "./conversation-skill-tools.js";
import { markSurfaceCompleted } from "./conversation-surfaces.js";
import { resolveTrustClass } from "./conversation-tool-setup.js";
import { recordUsage } from "./conversation-usage.js";
import {
  formatTurnTimestamp,
  resolveTurnTimezoneContext,
} from "./date-context.js";
import { getDiskPressureStatus } from "./disk-pressure-guard.js";
import { classifyDiskPressureTurnPolicy } from "./disk-pressure-policy.js";
import { deepRepairHistory } from "./history-repair.js";
import type {
  DynamicPageSurfaceData,
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UsageStats,
} from "./message-protocol.js";
import type { MemoryRecalled } from "./message-types/memory.js";
import type { ConfirmationStateChanged } from "./message-types/messages.js";
import { parseActualTokensFromError } from "./parse-actual-tokens-from-error.js";
import type { TraceEmitter } from "./trace-emitter.js";
import type { TrustContext } from "./trust-context.js";
import { stripHistoricalWebSearchResults } from "./web-search-history.js";

const log = getLogger("conversation-agent-loop");
const DISK_PRESSURE_ERROR_CODE = "DISK_SPACE_CRITICAL" as const;
const DISK_PRESSURE_ERROR_CATEGORY = "disk_pressure";

/** Title-cased friendly labels for tool names, used in confirmation chips. */
const TOOL_FRIENDLY_LABEL: Record<string, string> = {
  bash: "Run Command",
  web_search: "Web Search",
  web_fetch: "Web Fetch",
  file_read: "Read File",
  file_write: "Write File",
  file_edit: "Edit File",
  app_create: "Create App",
  app_refresh: "Refresh App",
  skill_load: "Load Skill",
  skill_execute: "Run Skill Tool",
};

type GitServiceInitializer = {
  ensureInitialized(): Promise<void>;
};

function formatDiskPressureBlockedMessage(): string {
  return "Storage is critically low, so background processes are paused and remote messages are ignored until the guardian frees enough space. Remote senders should try again later.";
}

// ── Compaction circuit-breaker pipeline helpers ─────────────────────
//
// The circuit-breaker behavior (3 consecutive summary-LLM failures trips a
// 1-hour cooldown) is now implemented by the `circuitBreaker` plugin
// pipeline. The default plugin (`plugins/defaults/circuit-breaker.ts`)
// replicates the legacy threshold/cooldown constants and event-emission
// semantics exactly — it operates on the `consecutiveCompactionFailures` /
// `compactionCircuitOpenUntil` fields the conversation still owns so the
// dev-only playground routes (`POST /playground/reset-compaction-circuit`,
// `POST /playground/inject-compaction-failures`) continue to read and
// mutate those fields directly.
//
// The helpers below build the pipeline inputs and invoke the runner. They
// are the sole entry points the rest of the daemon uses to query or update
// the compaction circuit.

/** Circuit-breaker key for a specific conversation's compaction pipeline. */
function compactionCircuitKey(conversationId: string): string {
  return `compaction:${conversationId}`;
}

/**
 * Build the minimal {@link TurnContext} the pipeline runner requires. Called
 * both from inside the agent loop (where turn identifiers are available) and
 * from non-turn invocations like `Conversation.forceCompact` (which falls
 * back to stable placeholders so the runner's log records still carry the
 * conversation identifier).
 */
function buildCircuitTurnContext(ctx: {
  readonly conversationId: string;
  currentRequestId?: string;
  currentTurnTrustContext?: TrustContext;
  trustContext?: TrustContext;
  turnCount: number;
}): PluginTurnContext {
  const trust: TrustContext =
    ctx.currentTurnTrustContext ?? ctx.trustContext ?? FALLBACK_TURN_TRUST;
  return {
    requestId: ctx.currentRequestId ?? "circuit-breaker",
    conversationId: ctx.conversationId,
    turnIndex: ctx.turnCount,
    trust,
  };
}

/**
 * Run the `circuitBreaker` pipeline for the compaction circuit on this
 * conversation. When `outcome` is provided, state is updated (and transition
 * events emit via `onEvent`); when omitted the call is query-only.
 *
 * Returns the post-call decision from the pipeline. Callers gate auto-paths
 * on `!result.open` and admit forced paths regardless of the decision.
 */
async function runCompactionCircuitPipeline(
  ctx: {
    readonly conversationId: string;
    consecutiveCompactionFailures: number;
    compactionCircuitOpenUntil: number | null;
    currentRequestId?: string;
    currentTurnTrustContext?: TrustContext;
    trustContext?: TrustContext;
    turnCount: number;
  },
  args: {
    outcome?: "success" | "failure";
    onEvent?: (msg: ServerMessage) => void;
  },
): Promise<CircuitBreakerResult> {
  const turnContext = buildCircuitTurnContext(ctx);
  return runPipeline<CircuitBreakerArgs, CircuitBreakerResult>(
    "circuitBreaker",
    getMiddlewaresFor("circuitBreaker"),
    async (terminalArgs) => {
      // No plugin in the chain produced a decision. This should be
      // unreachable in production because the default plugin registers a
      // `circuitBreaker` middleware that always returns a decision, but we
      // defensively derive the state here so test setups that intentionally
      // omit the default plugin still get a sensible response.
      const openUntil = terminalArgs.state.compactionCircuitOpenUntil;
      const now = Date.now();
      if (openUntil !== null && now < openUntil) {
        return { open: true, cooldownRemainingMs: openUntil - now };
      }
      return { open: false };
    },
    {
      key: compactionCircuitKey(ctx.conversationId),
      // Pass the ctx directly as the mutable state container. The
      // `CircuitBreakerArgs.state` shape deliberately matches the subset of
      // fields the conversation owns so plugins mutate the same object the
      // playground routes read and write.
      state: ctx,
      ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
      ...(args.onEvent ? { onEvent: args.onEvent } : {}),
    },
    turnContext,
    DEFAULT_TIMEOUTS.circuitBreaker,
  );
}

/**
 * Query-only: is the compaction circuit breaker currently open for this
 * conversation? Thin wrapper around {@link runCompactionCircuitPipeline}
 * with no outcome. Async because the pipeline runner is async, but the
 * default plugin resolves synchronously on its microtask.
 */
async function isCompactionCircuitOpen(ctx: {
  readonly conversationId: string;
  consecutiveCompactionFailures: number;
  compactionCircuitOpenUntil: number | null;
  currentRequestId?: string;
  currentTurnTrustContext?: TrustContext;
  trustContext?: TrustContext;
  turnCount: number;
}): Promise<boolean> {
  const decision = await runCompactionCircuitPipeline(ctx, {});
  return decision.open;
}

/**
 * Update the compaction circuit breaker with the outcome of a `maybeCompact`
 * call and emit any transition event. A `summaryFailed` value of `undefined`
 * means the summary LLM never ran (early return) — callers must guard with
 * `summaryFailed !== undefined` before invoking this helper so early-return
 * paths don't silently reset the 3-strike counter.
 *
 * The default plugin handles threshold-based tripping and cooldown reset;
 * see `plugins/defaults/circuit-breaker.ts` for the canonical semantics.
 */
export async function trackCompactionOutcome(
  ctx: {
    readonly conversationId: string;
    consecutiveCompactionFailures: number;
    compactionCircuitOpenUntil: number | null;
    currentRequestId?: string;
    currentTurnTrustContext?: TrustContext;
    trustContext?: TrustContext;
    turnCount: number;
  },
  summaryFailed: boolean,
  onEvent: (msg: ServerMessage) => void,
): Promise<void> {
  await runCompactionCircuitPipeline(ctx, {
    outcome: summaryFailed ? "failure" : "success",
    onEvent,
  });
}

// ── Plugin pipeline helpers ──────────────────────────────────────────
//
// Canonical {@link PluginTurnContext} builder threaded into every
// `runPipeline` call inside `runAgentLoopImpl`. The orchestrator composes
// the context on demand at each call site from ambient state rather than
// carrying a persistent `TurnContext` instance across the turn.

/**
 * Synthetic fallback trust context used when the orchestrator fires a pipeline
 * before the per-turn trust snapshot has been captured (e.g. invocations that
 * bypass `processMessage` / `drainQueue`). We bias to `unknown` rather than
 * `guardian` so a missing snapshot cannot accidentally grant elevated trust
 * to a custom plugin reading `ctx.trust`.
 */
const FALLBACK_TURN_TRUST: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "unknown",
};

/**
 * Build the {@link TurnContext} passed to {@link runPipeline}.
 *
 * Canonical source of truth for every pipeline call site inside the agent
 * loop. Every `runPipeline` invocation in `runAgentLoopImpl` (and in the
 * handlers that share its ambient state) must route through this helper
 * rather than constructing a `TurnContext` literal inline — this keeps
 * `turnIndex`, trust resolution, and the `contextWindowManager` attachment
 * consistent across pipeline slots, which in turn keeps structured logs
 * filtered by `conversationId`/`turnIndex` coherent across slots.
 *
 * Behavior:
 * - `turnIndex` is always `ctx.turnCount` — the orchestrator-owned
 *   0-based turn counter. Reading from a single source avoids the
 *   earlier inconsistency (`ctx.turnCount`, `ctx.messages.length - 1`,
 *   `ctx.messages.length`, and `0` were all used for the same turn).
 * - Trust pulls from the per-turn snapshot first, then the conversation-
 *   level context, then {@link FALLBACK_TURN_TRUST}. The cascade matches
 *   the one inside the orchestrator's inline injection assembly so
 *   middleware reads the same trust class the runtime sees.
 * - `contextWindowManager` is attached unconditionally. Pipelines that
 *   don't need it can ignore it; the default compaction plugin reads it
 *   via the typed optional field on `TurnContext`.
 */
function buildPluginTurnContext(
  ctx: AgentLoopConversationContext,
  requestId: string,
): PluginTurnContext {
  const trust =
    ctx.currentTurnTrustContext ?? ctx.trustContext ?? FALLBACK_TURN_TRUST;
  return {
    requestId,
    conversationId: ctx.conversationId,
    turnIndex: ctx.turnCount,
    trust,
    contextWindowManager: ctx.contextWindowManager,
  };
}

// ── Context Interface ────────────────────────────────────────────────

export interface AgentLoopConversationContext {
  readonly conversationId: string;
  messages: Message[];
  processing: boolean;
  abortController: AbortController | null;
  currentRequestId?: string;

  readonly agentLoop: AgentLoop;
  readonly provider: Provider;
  readonly systemPrompt: string;

  readonly contextWindowManager: ContextWindowManager;
  contextCompactedMessageCount: number;
  contextCompactedAt: number | null;
  /** Tracks consecutive compaction failures (summary LLM call threw). */
  consecutiveCompactionFailures: number;
  /** Timestamp (ms since epoch) until which the circuit breaker is open. */
  compactionCircuitOpenUntil: number | null;

  readonly graphMemory: ConversationGraphMemory;

  currentActiveSurfaceId?: string;
  currentPage?: string;
  readonly surfaceState: Map<
    string,
    {
      surfaceType: SurfaceType;
      data: SurfaceData;
      title?: string;
      actions?: Array<{
        id: string;
        label: string;
        style?: string;
        data?: Record<string, unknown>;
      }>;
    }
  >;
  pendingSurfaceActions: Map<string, { surfaceType: SurfaceType }>;
  surfaceActionRequestIds: Set<string>;
  approvedViaPromptThisTurn?: boolean;
  currentTurnSurfaces: Array<{
    surfaceId: string;
    surfaceType: SurfaceType;
    title?: string;
    data: SurfaceData;
    actions?: Array<{ id: string; label: string; style?: string }>;
    display?: string;
    persistent?: boolean;
  }>;

  workingDir: string;
  workspaceTopLevelContext: string | null;
  workspaceTopLevelDirty: boolean;
  channelCapabilities?: ChannelCapabilities;
  /** Per-turn snapshot of trustContext, frozen at message-processing start. */
  currentTurnTrustContext?: TrustContext;
  /** Per-turn snapshot of channelCapabilities, frozen at message-processing start. */
  currentTurnChannelCapabilities?: ChannelCapabilities;
  /**
   * Per-turn snapshot of the resolved inference-profile override. Read by
   * `createToolExecutor` so `ToolContext.overrideProfile` carries the same
   * profile the agent loop is sending to the provider. Without this, a tool
   * that spawns nested subagents (e.g. `subagent_spawn`) cannot recover the
   * override from a row read because the in-flight subagent's own row never
   * had `inferenceProfile` set.
   */
  currentTurnOverrideProfile?: string;
  commandIntent?: { type: string; payload?: string; languageCode?: string };
  trustContext?: TrustContext;
  /** Task-run scope for the current turn. Cleared at turn end so queued/drained turns don't inherit it. */
  taskRunId?: string;
  assistantId?: string;
  voiceCallControlPrompt?: string;
  transportHints?: string[];
  slackRuntimeContextNotice?: string;
  clientTimezone?: string;

  readonly coreToolNames: Set<string>;
  allowedToolNames?: Set<string>;
  diskPressureCleanupModeActive?: boolean;
  toolsDisabledDepth: number;
  preactivatedSkillIds?: string[];
  readonly skillProjectionState: Map<string, string>;
  readonly skillProjectionCache: SkillProjectionCache;

  readonly traceEmitter: TraceEmitter;
  readonly profiler: ToolProfiler;
  usageStats: UsageStats;
  turnCount: number;

  lastAssistantAttachments: AssistantAttachmentDraft[];
  lastAttachmentWarnings: string[];

  hasNoClient: boolean;
  /** True when this conversation is itself a subagent (suppresses subagent status injection). */
  isSubagent?: boolean;
  headlessLock?: boolean;
  readonly streamThinking: boolean;
  readonly prompter: PermissionPrompter;
  readonly queue: MessageQueue;

  emitActivityState(
    phase:
      | "idle"
      | "thinking"
      | "streaming"
      | "tool_running"
      | "awaiting_confirmation",
    reason:
      | "message_dequeued"
      | "thinking_delta"
      | "first_text_delta"
      | "tool_use_start"
      | "preview_start"
      | "tool_result_received"
      | "confirmation_requested"
      | "confirmation_resolved"
      | "context_compacting"
      | "message_complete"
      | "generation_cancelled"
      | "error_terminal",
    anchor?: "assistant_turn" | "user_turn" | "global",
    requestId?: string,
    statusText?: string,
  ): void;
  emitConfirmationStateChanged(
    params: ConfirmationStateChanged extends {
      type: infer _;
    }
      ? Omit<ConfirmationStateChanged, "type">
      : never,
  ): void;

  /**
   * Optional callback invoked by the Conversation when a confirmation state changes.
   * The agent loop registers this to track requestId → toolUseId mappings
   * and record confirmation outcomes for persistence.
   */
  onConfirmationOutcome?: (
    requestId: string,
    state: string,
    toolName?: string,
    toolUseId?: string,
  ) => void;

  getWorkspaceGitService?: (workspaceDir: string) => GitServiceInitializer;
  commitTurnChanges?: typeof commitTurnChanges;

  refreshWorkspaceTopLevelContextIfNeeded(): void;
  markWorkspaceTopLevelDirty(): void;
  getQueueDepth(): number;
  hasQueuedMessages(): boolean;
  canHandoffAtCheckpoint(): boolean;
  drainQueue(reason: QueueDrainReason): Promise<void>;
  getTurnChannelContext(): TurnChannelContext | null;
  getTurnInterfaceContext(): TurnInterfaceContext | null;
}

// ── runAgentLoop ─────────────────────────────────────────────────────

export async function runAgentLoopImpl(
  ctx: AgentLoopConversationContext,
  content: string,
  userMessageId: string,
  onEvent: (msg: ServerMessage) => void,
  options?: {
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
    /**
     * LLM call-site identifier threaded into the per-call provider config.
     * Adapter callers (heartbeat, filing, scheduler, etc.) pass their own
     * call-site id so the resolver picks `llm.callSites.<id>`. When unset,
     * the agent loop defaults to `'mainAgent'` for user-initiated turns.
     */
    callSite?: LLMCallSite;
    /**
     * Optional ad-hoc inference-profile override applied to every LLM call
     * the loop issues. When set, the agent loop sets
     * `SendMessageOptions.config.overrideProfile` on each provider call so
     * the resolver layers `llm.profiles[<name>]` between the workspace's
     * `activeProfile` and the call-site's named profile. Used by
     * per-conversation pinned profiles (and inherited by subagents the loop
     * spawns).
     */
    overrideProfile?: string;
  },
): Promise<void> {
  if (!ctx.abortController) {
    throw new Error("runAgentLoop called without prior persistUserMessage");
  }

  // Initialize per-turn persona snapshots for callers (subagent manager,
  // voice-session-bridge, regenerate, etc.) that invoke runAgentLoop directly
  // without going through processMessage/drainQueue. This ensures the system
  // prompt callback always reads a valid snapshot rather than undefined.
  // processMessage/drainQueue set these fields before calling runAgentLoop;
  // those existing assignments remain correct and are merely redundant here.
  ctx.currentTurnTrustContext = ctx.trustContext;
  ctx.currentTurnChannelCapabilities = ctx.channelCapabilities;

  const abortController = ctx.abortController;
  const reqId = ctx.currentRequestId ?? uuid();
  const rlog = log.child({
    conversationId: ctx.conversationId,
    requestId: reqId,
  });
  let yieldedForHandoff = false;

  // Default user-initiated turns to the `mainAgent` call site. Other
  // invocation contexts (heartbeat, filing, analyze, etc.) pass their own
  // `callSite`. The provider layer resolves provider/model/maxTokens via
  // `resolveCallSiteConfig`, picking up any user overrides under
  // `llm.callSites.mainAgent` (falling back to `llm.default` when absent).
  const turnCallSite: LLMCallSite = options?.callSite ?? "mainAgent";

  // Read the conversation row once for both the override-profile derivation
  // below and the title-replaceability check at turn start. Later reads in
  // this function (post-turn truncation, disk sync, home-feed emission)
  // intentionally re-read because state can change during the turn.
  const turnStartConversation = getConversation(ctx.conversationId);

  // Optional per-turn inference-profile override. Plumbed through to every
  // LLM call the loop emits and inherited by any subagents spawned during
  // this turn. Caller-supplied `options.overrideProfile` (e.g.
  // SubagentManager forwarding the parent's pinned profile into the
  // spawned subagent's background conversation) wins over the row read
  // so the agent loop's own background-skip rule doesn't zero out an
  // explicitly inherited override.
  const turnOverrideProfile =
    options?.overrideProfile ??
    getConversationOverrideProfileFromRow(turnStartConversation);

  const config = getConfig();
  const effectiveContextWindow = resolveEffectiveContextWindow({
    llm: config.llm,
    callSite: turnCallSite,
    overrideProfile: turnOverrideProfile ?? undefined,
  });
  const turnContextWindowConfig = contextWindowConfigFromEffective(
    config.llm.default.contextWindow,
    effectiveContextWindow,
  );
  (
    ctx.contextWindowManager as ContextWindowManager & {
      updateConfig?: (config: ContextWindowConfig) => void;
    }
  ).updateConfig?.(turnContextWindowConfig);

  // Snapshot for `createToolExecutor` to read into `ToolContext.overrideProfile`
  // — see field doc on `AgentLoopConversationContext` for why the tool needs
  // it (nested subagent spawns can't recover the override from a row read).
  ctx.currentTurnOverrideProfile = turnOverrideProfile;

  // Capture the turn channel context *before* any awaits so a second
  // message from a different channel can't overwrite it mid-flight.
  // When context is unavailable (e.g. regenerate after daemon restart),
  // fall back to the conversation's persisted origin channel.
  const capturedTurnChannelContext: TurnChannelContext = (() => {
    const live = ctx.getTurnChannelContext();
    if (live) return live;
    const origin = getConversationOriginChannel(ctx.conversationId);
    if (origin)
      return { userMessageChannel: origin, assistantMessageChannel: origin };
    return {
      userMessageChannel: "vellum" as ChannelId,
      assistantMessageChannel: "vellum" as ChannelId,
    };
  })();

  // Capture interface context with the same anti-race snapshot pattern.
  // Interface and channel are orthogonal dimensions, so when interface
  // context is missing we default explicitly to 'vellum' instead of
  // deriving from channel.
  const capturedTurnInterfaceContext: TurnInterfaceContext = (() => {
    const live = ctx.getTurnInterfaceContext();
    if (live) return live;
    const origin = getConversationOriginInterface(ctx.conversationId);
    if (origin)
      return {
        userMessageInterface: origin,
        assistantMessageInterface: origin,
      };
    return {
      userMessageInterface: "web" as InterfaceId,
      assistantMessageInterface: "web" as InterfaceId,
    };
  })();

  const isInteractiveResolved =
    options?.isInteractive ?? (!ctx.hasNoClient && !ctx.headlessLock);
  const diskPressureDecision = classifyDiskPressureTurnPolicy(
    getDiskPressureStatus(),
    {
      conversationType: turnStartConversation?.conversationType ?? null,
      conversationSource: turnStartConversation?.source ?? null,
      callSite: turnCallSite,
      isInteractive: isInteractiveResolved,
      sourceChannel:
        ctx.trustContext?.sourceChannel ??
        capturedTurnChannelContext.userMessageChannel,
      sourceInterface:
        ctx.channelCapabilities?.clientOS ??
        capturedTurnInterfaceContext.userMessageInterface,
      trustContext: ctx.trustContext
        ? {
            sourceChannel: ctx.trustContext.sourceChannel,
            trustClass: ctx.trustContext.trustClass,
          }
        : null,
    },
  );
  const diskPressureContext =
    diskPressureDecision.action === "allow-cleanup-mode"
      ? { cleanupModeActive: true }
      : null;
  ctx.diskPressureCleanupModeActive =
    diskPressureDecision.action === "allow-cleanup-mode";

  ctx.lastAssistantAttachments = [];
  ctx.lastAttachmentWarnings = [];

  ctx.profiler.startRequest();
  let turnStarted = false;

  // Populate Sentry scope with conversation-specific tags so any exception
  // captured during this turn (e.g. inside agent/loop.ts) can be
  // filtered by conversation, assistant, or user in the dashboard.
  setSentryConversationContext({
    assistantId: ctx.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
    conversationId: ctx.conversationId,
    messageCount: ctx.messages.length,
    userIdentifier:
      ctx.trustContext?.guardianPrincipalId ??
      ctx.trustContext?.requesterExternalUserId,
  });

  try {
    if (diskPressureDecision.action === "block") {
      const message = formatDiskPressureBlockedMessage();
      rlog.warn(
        { reason: diskPressureDecision.reason },
        "Blocked turn during disk pressure cleanup mode",
      );
      ctx.emitActivityState("idle", "error_terminal", "global", reqId);
      ctx.traceEmitter.emit("request_error", message, {
        requestId: reqId,
        status: "error",
        attributes: {
          errorCategory: DISK_PRESSURE_ERROR_CATEGORY,
          errorCode: DISK_PRESSURE_ERROR_CODE,
          diskPressureReason: diskPressureDecision.reason,
        },
      });
      onEvent({
        type: "error",
        conversationId: ctx.conversationId,
        requestId: reqId,
        code: DISK_PRESSURE_ERROR_CODE,
        message,
        category: DISK_PRESSURE_ERROR_CATEGORY,
        errorCategory: DISK_PRESSURE_ERROR_CATEGORY,
      });
      onEvent({
        type: "conversation_error",
        conversationId: ctx.conversationId,
        code: DISK_PRESSURE_ERROR_CODE,
        userMessage: message,
        retryable: true,
        errorCategory: DISK_PRESSURE_ERROR_CATEGORY,
      });
      return;
    }

    // Ensure workspace git repo is initialized before any tools run.
    try {
      const getWorkspaceGitServiceFn =
        ctx.getWorkspaceGitService ?? getWorkspaceGitService;
      const gitService = getWorkspaceGitServiceFn(ctx.workingDir);
      await gitService.ensureInitialized();
    } catch (err) {
      rlog.warn({ err }, "Failed to initialize workspace git repo (non-fatal)");
    }

    // Auto-complete stale interactive surfaces from previous turns.
    // Only dismiss when the user sends a new message (not a surface action
    // response), so internal turns (subagent notifications, lifecycle
    // instructions) don't accidentally clear active interactive prompts.
    // Placed inside try so the finally block still runs if onEvent throws.
    if (options?.isUserMessage && !ctx.surfaceActionRequestIds.has(reqId)) {
      for (const [surfaceId, entry] of ctx.pendingSurfaceActions) {
        if (entry.surfaceType === "dynamic_page") continue;
        onEvent({
          type: "ui_surface_complete",
          conversationId: ctx.conversationId,
          surfaceId,
          summary: "Dismissed",
        });
        markSurfaceCompleted(ctx, surfaceId, "Dismissed");
        ctx.pendingSurfaceActions.delete(surfaceId);
      }
    }

    // Generate title early — the user message alone is sufficient context.
    // Firing before the main LLM call removes the delay of waiting for the
    // full assistant response. The second-pass regeneration at turn 3 will
    // refine the title with more context.
    // No abort signal — title generation should complete even if the user
    // cancels the response, since the user message is already persisted.
    // Deferred via setTimeout so the main agent loop LLM call enqueues
    // first, avoiding rate-limit slot contention on strict configs.
    if (isReplaceableTitle(turnStartConversation?.title ?? null)) {
      // TurnContext routed through the canonical builder so the pipeline's
      // log record reports the same `conversationId`/`turnIndex` shape as
      // every other slot in this turn. Title generation does not depend on
      // the context-window manager attached by the builder, but sharing the
      // builder keeps the invariant enforced in one place.
      const titlePipelineCtx = buildPluginTurnContext(ctx, reqId);
      const titleArgs = {
        conversationId: ctx.conversationId,
        provider: ctx.provider,
        userMessage: options?.titleText ?? content,
        onTitleUpdated: (title: string) => {
          onEvent({
            type: "conversation_title_updated",
            conversationId: ctx.conversationId,
            title,
          });
        },
      };
      setTimeout(() => {
        runPipeline(
          "titleGenerate",
          getMiddlewaresFor("titleGenerate"),
          defaultTitleGenerateTerminal,
          titleArgs,
          titlePipelineCtx,
          DEFAULT_TIMEOUTS.titleGenerate,
        ).catch((err) => {
          // Fire-and-forget — keep previous non-propagating semantics.
          // queueGenerateConversationTitle already swallows internal
          // errors; this catch covers pipeline-layer errors (timeouts,
          // middleware throws) without surfacing them to the agent loop.
          rlog.warn({ err }, "titleGenerate pipeline failed (non-fatal)");
        });
      }, 0);
    }

    const isFirstMessage = ctx.messages.length === 1;
    let shouldInjectWorkspace = isFirstMessage;
    let compactedThisTurn = false;
    let slackCompactedThisTurn = false;
    const isSlackConversation = ctx.channelCapabilities?.channel === "slack";
    let currentSlackContextSummary =
      turnStartConversation?.contextSummary ?? null;
    let currentSlackContextCompactedMessageCount =
      turnStartConversation?.contextCompactedMessageCount ?? 0;
    let currentSlackContextCompactionWatermarkTs =
      turnStartConversation?.slackContextCompactionWatermarkTs ?? null;
    const loadCurrentSlackChronologicalContext =
      (): SlackChronologicalContext | null => {
        if (!isSlackConversation) return null;
        return loadSlackChronologicalContext(
          ctx.conversationId,
          ctx.channelCapabilities!,
          {
            trustClass: ctx.trustContext?.trustClass,
            contextSummary: currentSlackContextSummary,
            contextCompactedMessageCount:
              currentSlackContextCompactedMessageCount,
            slackContextCompactionWatermarkTs:
              currentSlackContextCompactionWatermarkTs,
          },
        );
      };
    let slackChronologicalContext: SlackChronologicalContext | null =
      loadCurrentSlackChronologicalContext();
    const messagesForStartOfTurnCompaction =
      slackChronologicalContext?.messages ?? ctx.messages;
    const getSlackProvenanceContextForCompactionBasis = (
      messages: Message[],
      compactedMessages: number,
    ): SlackChronologicalContext | null => {
      if (!isSlackConversation || compactedMessages <= 0) return null;
      const context = slackChronologicalContext;
      if (!context) return null;
      if (messages !== context.messages) return null;
      const end = context.compactableStartIndex + compactedMessages;
      if (
        end <= context.compactableStartIndex ||
        end > context.renderedMessages.length ||
        context.renderedMessages.length !== context.messages.length
      ) {
        return null;
      }
      return context;
    };
    const projectSlackProvenanceAfterCompaction = (
      context: SlackChronologicalContext | null,
      compactedBasis: Message[] | undefined,
      result: Awaited<ReturnType<typeof ctx.contextWindowManager.maybeCompact>>,
    ): SlackChronologicalContext | null => {
      if (
        !isSlackConversation ||
        !context ||
        !compactedBasis ||
        compactedBasis !== context.messages ||
        result.compactedMessages <= 0 ||
        result.messages.length === 0 ||
        context.renderedMessages.length !== context.messages.length
      ) {
        return null;
      }

      const keptStart =
        context.compactableStartIndex + result.compactedMessages;
      if (keptStart > context.renderedMessages.length) {
        return null;
      }

      const retainedRenderedMessages =
        context.renderedMessages.slice(keptStart);
      const retainedResultMessages = result.messages.slice(1);
      if (retainedResultMessages.length !== retainedRenderedMessages.length) {
        return null;
      }
      for (let index = 0; index < retainedResultMessages.length; index++) {
        if (
          retainedResultMessages[index] !==
          retainedRenderedMessages[index]!.message
        ) {
          return null;
        }
      }

      return {
        renderedMessages: [
          {
            message: result.messages[0]!,
            sourceChannelTs: null,
          },
          ...retainedRenderedMessages,
        ],
        messages: result.messages,
        compactableStartIndex: 1,
      };
    };
    const applySuccessfulCompaction = async (
      result: Awaited<ReturnType<typeof ctx.contextWindowManager.maybeCompact>>,
      compactedBasis?: Message[],
    ) => {
      const provenanceContext = compactedBasis
        ? getSlackProvenanceContextForCompactionBasis(
            compactedBasis,
            result.compactedMessages,
          )
        : null;
      const slackWatermarkTs = getSlackCompactionWatermarkForPrefix(
        provenanceContext,
        result.compactedMessages,
      );
      await applyCompactionResult(ctx, result, onEvent, reqId, {
        slackContextCompactionWatermarkTs: slackWatermarkTs,
      });
      currentSlackContextSummary = result.summaryText;
      currentSlackContextCompactedMessageCount =
        ctx.contextCompactedMessageCount;
      if (slackWatermarkTs) {
        currentSlackContextCompactionWatermarkTs = slackWatermarkTs;
      }
      if (isSlackConversation) {
        slackCompactedThisTurn = true;
      }
      slackChronologicalContext = projectSlackProvenanceAfterCompaction(
        provenanceContext,
        compactedBasis,
        result,
      );
    };

    const compactCheck = ctx.contextWindowManager.shouldCompact(
      messagesForStartOfTurnCompaction,
    );
    // Skip auto-compaction while the circuit breaker is open. Force paths
    // and user-initiated /compact bypass this check.
    const autoCompactAllowed = !(await isCompactionCircuitOpen(ctx));
    if (compactCheck.needed && autoCompactAllowed) {
      ctx.emitActivityState(
        "thinking",
        "context_compacting",
        "assistant_turn",
        reqId,
      );
    }
    const compactionOptions = {
      lastCompactedAt: ctx.contextCompactedAt ?? undefined,
      precomputedEstimate: compactCheck.estimatedTokens,
      conversationOriginChannel:
        getConversationOriginChannel(ctx.conversationId) ?? undefined,
      overrideProfile: turnOverrideProfile ?? null,
    };
    let compacted: Awaited<
      ReturnType<typeof ctx.contextWindowManager.maybeCompact>
    > | null = null;
    if (autoCompactAllowed) {
      try {
        compacted = (await runPipeline<CompactionArgs, CompactionResult>(
          "compaction",
          getMiddlewaresFor("compaction"),
          (args) =>
            defaultCompactionTerminal(args, buildPluginTurnContext(ctx, reqId)),
          {
            messages: messagesForStartOfTurnCompaction,
            signal: abortController.signal,
            options: compactionOptions,
          },
          buildPluginTurnContext(ctx, reqId),
          DEFAULT_TIMEOUTS.compaction,
        )) as Awaited<ReturnType<typeof ctx.contextWindowManager.maybeCompact>>;
      } catch (err) {
        if (err instanceof PluginTimeoutError) {
          // Pipeline exceeded its budget. Record the failure so the circuit
          // breaker tracks consecutive timeouts (it trips after three),
          // then degrade gracefully by skipping compaction this turn —
          // the turn proceeds with the un-compacted history rather than
          // hard-failing. The inner summary call has been aborted by the
          // runner's signal-linking, so updateSummary's local fallback
          // also ran before this catch block is reached.
          rlog.warn(
            { err, phase: "start-of-turn-compaction" },
            "Compaction pipeline timed out — skipping compaction this turn",
          );
          await trackCompactionOutcome(ctx, true, onEvent);
          compacted = null;
        } else {
          throw err;
        }
      }
    }
    // Only track circuit-breaker state when a summary LLM call actually ran.
    // `summaryFailed` is `undefined` on early returns (compaction disabled,
    // below threshold, cooldown active, no eligible messages, truncation-only
    // path) — treating those as "successful" compactions would silently reset
    // the 3-strike counter and break the invariant.
    if (compacted && compacted.summaryFailed !== undefined) {
      await trackCompactionOutcome(ctx, compacted.summaryFailed, onEvent);
    }
    if (compacted?.compacted) {
      await applySuccessfulCompaction(
        compacted,
        messagesForStartOfTurnCompaction,
      );
      shouldInjectWorkspace = true;
      if (compacted.compactedPersistedMessages > 0) {
        compactedThisTurn = true;
      }
    }

    const state = createEventHandlerState();

    // Register confirmation outcome tracker so the agent loop can link
    // confirmation decisions to tool_use_ids for persistence.
    ctx.onConfirmationOutcome = (
      requestId,
      confirmationState,
      toolName,
      toolUseId,
    ) => {
      if (confirmationState === "pending") {
        // Use the toolUseId passed from the prompter (which knows which tool
        // requested confirmation) instead of the ambient state.currentToolUseId,
        // which is unreliable when multiple tools execute in parallel.
        const resolvedToolUseId = toolUseId ?? state.currentToolUseId;
        if (resolvedToolUseId) {
          state.requestIdToToolUseId.set(requestId, resolvedToolUseId);
        }
      } else if (
        confirmationState === "approved" ||
        confirmationState === "denied" ||
        confirmationState === "timed_out"
      ) {
        const resolvedId =
          state.requestIdToToolUseId.get(requestId) ?? toolUseId;
        if (resolvedId) {
          const name = state.toolUseIdToName.get(resolvedId) ?? toolName ?? "";
          // Build a friendly label from the tool name
          const label =
            TOOL_FRIENDLY_LABEL[name] ??
            name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
          state.toolConfirmationOutcomes.set(resolvedId, {
            decision: confirmationState,
            label,
          });
        }
      }
    };

    let runMessages = ctx.messages;

    // Memory retrieval pipeline — fetches PKB, NOW.md, and memory-graph
    // outputs through a single `memoryRetrieval` pipeline. Plugins may
    // replace the terminal behavior by registering a middleware that
    // short-circuits with its own `MemoryResult`; the default terminal
    // below runs `runDefaultMemoryRetrieval` which reproduces the prior
    // in-lined behavior (PKB/NOW reads + gated graph call).
    const isTrustedActor = resolveTrustClass(ctx.trustContext) === "guardian";
    // Canonical builder — pulls trust from per-turn snapshot, then
    // conversation-level, then the synthetic fallback. Memory retrieval
    // does not need the context-window handle the builder attaches, but
    // keeping every call site on one helper is load-bearing for log
    // coherence across pipeline slots.
    const memoryPluginTurnCtx = buildPluginTurnContext(ctx, reqId);
    const memoryArgs: MemoryArgs = {
      conversationId: ctx.conversationId,
      trustContext: ctx.trustContext,
      turnIndex: ctx.turnCount,
      // Pass the abort signal via `args` (not `deps`) so the pipeline
      // runner's `linkAbortSignal` can swap it for a signal linked to the
      // pipeline's internal controller — on a plugin-set timeout or
      // external cancel, the linked signal aborts and `prepareMemory`
      // stops mutating graph state / emitting events after the pipeline
      // has already errored.
      signal: abortController.signal,
    };
    const memoryDeps: DefaultMemoryRetrievalDeps = {
      messages: ctx.messages,
      graphMemory: ctx.graphMemory,
      config: getConfig(),
      onEvent,
      isTrustedActor,
    };
    const memoryResult: MemoryResult = await runPipeline(
      "memoryRetrieval",
      getMiddlewaresFor("memoryRetrieval"),
      (args) => runDefaultMemoryRetrieval(args, memoryDeps),
      memoryArgs,
      memoryPluginTurnCtx,
      DEFAULT_TIMEOUTS.memoryRetrieval,
    );

    // Consume the memory-graph block when the default retriever emitted
    // one. Custom plugins that substitute their own blocks without the
    // default discriminator are expected to handle their own side effects
    // (event emission, metric persistence) inside their middleware; this
    // block short-circuits to the original no-op behavior in that case.
    const defaultGraphPayload: GraphMemoryPayload | null =
      asDefaultGraphPayload(memoryResult.memoryGraphBlocks);
    let pkbQueryVector: number[] | undefined;
    let pkbSparseVector: QdrantSparseVector | undefined;
    if (defaultGraphPayload) {
      const graphResult = defaultGraphPayload.result;
      runMessages = graphResult.runMessages;
      // Select dense+sparse as a matched pair so RRF fusion combines two
      // signals aligned to the same query text:
      //   1. Context-load with a user query: user-query dense + user-query
      //      sparse — the cleanest pairing.
      //   2. Otherwise (context-load without a user query, or per-turn):
      //      whatever `queryVector` / `sparseVector` the retriever produced,
      //      which are themselves co-aligned (both summary-derived in
      //      context-load, both user-last-message-derived in per-turn).
      // Never pair a user-query dense with a summary-aligned sparse.
      if (graphResult.userQueryVector) {
        pkbQueryVector = graphResult.userQueryVector;
        pkbSparseVector = graphResult.userQuerySparseVector;
      } else {
        pkbQueryVector = graphResult.queryVector;
        pkbSparseVector = graphResult.sparseVector;
      }

      // Persist the injected block text in message metadata so it survives
      // conversation reloads (eviction, restart, fork). loadFromDb re-injects
      // from metadata. Routed through the `persistence` pipeline so plugins
      // can observe or override metadata updates alongside add/delete.
      if (graphResult.injectedBlockText) {
        try {
          await runPipeline<PersistArgs, PersistResult>(
            "persistence",
            getMiddlewaresFor("persistence"),
            defaultPersistenceTerminal,
            {
              op: "update",
              messageId: userMessageId,
              updates: {
                memoryInjectedBlock: graphResult.injectedBlockText,
              },
            },
            buildPluginTurnContext(ctx, reqId),
            DEFAULT_TIMEOUTS.persistence,
          );
        } catch (err) {
          rlog.warn(
            { err },
            "Failed to persist memory injection to metadata (non-fatal)",
          );
        }
      }

      const m = graphResult.metrics;

      try {
        recordMemoryRecallLog({
          conversationId: ctx.conversationId,
          enabled: true,
          degraded: false,
          provider: m?.embeddingProvider ?? undefined,
          model: m?.embeddingModel ?? undefined,
          semanticHits: m?.semanticHits ?? 0,
          mergedCount: m?.mergedCount ?? 0,
          selectedCount: m?.selectedCount ?? 0,
          tier1Count: m?.tier1Count ?? 0,
          tier2Count: m?.tier2Count ?? 0,
          hybridSearchLatencyMs: m?.hybridSearchLatencyMs ?? 0,
          sparseVectorUsed: m?.sparseVectorUsed ?? false,
          injectedTokens: graphResult.injectedTokens,
          latencyMs: graphResult.latencyMs,
          topCandidatesJson: (m?.topCandidates ?? []).map((c) => ({
            key: c.nodeId,
            type: c.type,
            kind: "graph",
            finalScore: c.score,
            semantic: c.semanticSimilarity,
            recency: c.recencyBoost,
          })),
          injectedText: graphResult.injectedBlockText ?? undefined,
          reason: `graph:${graphResult.mode}`,
          queryContext: m?.queryContext ?? undefined,
        });
      } catch (err) {
        log.warn({ err }, "Failed to persist memory recall log (non-fatal)");
      }

      if (m) {
        const memoryRecalledEvent: MemoryRecalled = {
          type: "memory_recalled",
          provider: m.embeddingProvider ?? "unknown",
          model: m.embeddingModel ?? "unknown",
          semanticHits: m.semanticHits,
          mergedCount: m.mergedCount,
          selectedCount: m.selectedCount,
          tier1Count: m.tier1Count,
          tier2Count: m.tier2Count,
          hybridSearchLatencyMs: m.hybridSearchLatencyMs,
          sparseVectorUsed: m.sparseVectorUsed,
          injectedTokens: graphResult.injectedTokens,
          latencyMs: graphResult.latencyMs,
          topCandidates: m.topCandidates.map((c) => ({
            key: c.nodeId,
            type: c.type,
            kind: "graph",
            finalScore: c.score,
            semantic: c.semanticSimilarity,
            recency: c.recencyBoost,
          })),
        };
        onEvent(memoryRecalledEvent);
      }
    }

    // Build active surface context
    let activeSurface: ActiveSurfaceContext | null = null;
    if (ctx.currentActiveSurfaceId) {
      const stored = ctx.surfaceState.get(ctx.currentActiveSurfaceId);
      if (stored && stored.surfaceType === "dynamic_page") {
        const data = stored.data as DynamicPageSurfaceData;
        activeSurface = {
          surfaceId: ctx.currentActiveSurfaceId,
          html: data.html,
          currentPage: ctx.currentPage,
        };
        if (data.appId) {
          const app = getApp(data.appId);
          if (app) {
            activeSurface.appId = app.id;
            activeSurface.appName = app.name;
            activeSurface.appDirName = resolveAppDir(app.id).dirName;
            activeSurface.appSchemaJson = app.schemaJson;
            activeSurface.appFiles = listAppFiles(app.id);
            if (app.pages && Object.keys(app.pages).length > 0) {
              activeSurface.appPages = app.pages;
            }
          }
        }
      }
    }

    ctx.refreshWorkspaceTopLevelContextIfNeeded();

    // Compute fresh turn timestamp for date grounding.
    // Absolute "now" is always anchored to assistant host clock, while local
    // date semantics prefer configured user timezone, then device timezones.
    const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timezoneContext = resolveTurnTimezoneContext({
      configuredUserTimeZone: config.ui.userTimezone ?? null,
      clientTimezone: ctx.clientTimezone ?? null,
      detectedTimezone: config.ui.detectedTimezone ?? null,
      hostTimeZone,
    });
    const timestamp = formatTurnTimestamp({
      timeZone: timezoneContext.effectiveTimezone,
    });

    // Resolve the inbound actor context for the unified <turn_context> block.
    // When the conversation carries enough identity info, use the unified
    // actor trust resolver so member status/policy and guardian binding details
    // are fresh for this turn. The conversation runtime context remains the source
    // for policy gating; this block is model-facing grounding metadata.
    let resolvedInboundActorContext: InboundActorContext | null = null;
    if (ctx.trustContext) {
      const gc = ctx.trustContext;
      if (gc.requesterExternalUserId && gc.requesterChatId) {
        const actorTrust = resolveActorTrust({
          assistantId: ctx.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
          sourceChannel: gc.sourceChannel,
          conversationExternalId: gc.requesterChatId,
          actorExternalId: gc.requesterExternalUserId,
          actorDisplayName: gc.requesterSenderDisplayName,
        });
        resolvedInboundActorContext = inboundActorContextFromTrust(actorTrust);
      } else {
        resolvedInboundActorContext = inboundActorContextFromTrustContext(gc);
      }
    }

    // Build unified turn context block that replaces the separate temporal,
    // channel, interface, and actor context blocks.
    const interfaceName =
      capturedTurnInterfaceContext.userMessageInterface ?? undefined;
    const channelName =
      capturedTurnChannelContext?.userMessageChannel ?? undefined;
    const isGuardian =
      resolvedInboundActorContext?.trustClass === "guardian" ||
      !resolvedInboundActorContext;

    // Surface long gaps between user messages so the model can acknowledge
    // the absence naturally. Gated at >12h to avoid noisy injection during
    // normal back-and-forth turns.
    const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
    let timeSinceLastMessage: string | null = null;
    const currentUserMessage = getMessageById(userMessageId);
    if (currentUserMessage) {
      const prevUserTs = getLastUserTimestampBefore(
        ctx.conversationId,
        currentUserMessage.createdAt,
      );
      if (
        prevUserTs > 0 &&
        currentUserMessage.createdAt - prevUserTs > TWELVE_HOURS_MS
      ) {
        timeSinceLastMessage = timeAgo(prevUserTs);
      }
    }

    const baseTurnContext = {
      timestamp,
      interfaceName,
      channelName,
      configuredUserTimezone: timezoneContext.configuredUserTimezone,
      clientTimezone: timezoneContext.clientTimezone,
      detectedTimezone: timezoneContext.detectedTimezone,
      timeSinceLastMessage,
    };
    const unifiedTurnContextStr = buildUnifiedTurnContextBlock(
      isGuardian
        ? baseTurnContext
        : {
            ...baseTurnContext,
            actorContext: resolvedInboundActorContext,
          },
    );

    // The `remember` tool handles scratchpad-style memory writes directly to the graph.

    // Inject NOW.md and PKB content only on the first turn (or after
    // compaction re-strips them).  Old injections persist in history and
    // are never stripped on normal turns — this preserves the cached prefix.
    // PKB/NOW content is sourced from the `memoryRetrieval` pipeline above
    // so plugins can override either source without touching the agent loop.
    const currentNowContent = memoryResult.nowContent;
    const shouldInjectNowAndPkb = isFirstMessage || compactedThisTurn;
    const nowScratchpad = shouldInjectNowAndPkb ? currentNowContent : null;

    const currentPkbContent = memoryResult.pkbContent;
    const pkbContext = shouldInjectNowAndPkb ? currentPkbContent : null;
    const pkbActive = currentPkbContent !== null;

    // V2 static memory block (essentials/threads/recent/buffer).
    // `currentMemoryV2Static` is the trust-gated content reused by every
    // re-injection path — it stays non-null on non-full-mode turns so
    // that mid-turn reducer compaction (which strips the prior `<memory>`
    // block) can restore the freshest content. `memoryV2Static` is the
    // first-turn / post-compaction cadence-gated value for initial
    // injection only. `readMemoryV2StaticContent` self-gates on the v2
    // flag + config and returns null when v2 is off.
    const currentMemoryV2Static = shouldLoadMemoryV2Static({
      sourceChannel: ctx.trustContext?.sourceChannel,
      isTrustedActor,
    })
      ? readMemoryV2StaticContent()
      : null;
    const memoryV2Static = shouldInjectNowAndPkb ? currentMemoryV2Static : null;

    // PKB relevance-hint inputs. Resolved once per turn and reused across
    // re-injections so post-compaction rebuilds pick up fresh hints against
    // the updated conversation history.
    const pkbRoot = pkbActive ? join(getWorkspaceDir(), "pkb") : undefined;
    const pkbAutoInjectList = pkbRoot
      ? getPkbAutoInjectList(pkbRoot)
      : undefined;
    // Pass `ctx` directly — `PkbContextConversation` is structural and
    // `getInContextPkbPaths` re-reads `conversation.messages` on each call,
    // so post-compaction re-injects see the updated history.
    const pkbConversation = pkbActive ? ctx : undefined;
    // PKB points live under a single workspace sentinel scope.
    // See `PKB_WORKSPACE_SCOPE` for why.
    const pkbScopeId = pkbActive ? PKB_WORKSPACE_SCOPE : undefined;

    // Subagent status injection — gives the parent LLM visibility into active/completed children.
    // Skipped when this conversation IS a subagent (no nesting) or has no children.
    const subagentStatusBlock = ctx.isSubagent
      ? null
      : buildSubagentStatusBlock(
          getSubagentManager().getChildrenOf(ctx.conversationId),
        );

    // For any Slack conversation (channels and DMs alike), build a
    // chronological transcript from the persisted message rows so the
    // model sees one channel-wide view instead of the gateway's per-turn
    // hints. DMs render as a flat sequence (no thread tags), channels
    // include sibling threads.
    const slackConversationForInjection = isSlackConversation
      ? (getConversation(ctx.conversationId) ?? turnStartConversation)
      : turnStartConversation;
    if (isSlackConversation && !slackCompactedThisTurn) {
      slackChronologicalContext ??= loadSlackChronologicalContext(
        ctx.conversationId,
        ctx.channelCapabilities!,
        {
          trustClass: ctx.trustContext?.trustClass,
          contextSummary: slackConversationForInjection?.contextSummary,
          contextCompactedMessageCount:
            slackConversationForInjection?.contextCompactedMessageCount,
          slackContextCompactionWatermarkTs:
            slackConversationForInjection?.slackContextCompactionWatermarkTs,
        },
      );
    }
    const slackChronologicalMessages =
      slackChronologicalContext?.messages ?? null;

    // Active-thread focus block: when the inbound user message belongs to
    // a Slack thread, append a non-persisted `<active_thread>` tail block
    // to the final user turn listing the thread's parent + replies. Helps
    // the model orient when the channel transcript is long and
    // interleaved. Replays strip the block via RUNTIME_INJECTION_PREFIXES.
    // DMs short-circuit to null inside `loadSlackActiveThreadFocusBlock`
    // since DMs do not have threads.
    const slackActiveThreadFocusBlock = isSlackConversation
      ? loadSlackActiveThreadFocusBlock(
          ctx.conversationId,
          ctx.channelCapabilities!,
          {
            trustClass: ctx.trustContext?.trustClass,
            contextCompactedMessageCount:
              slackConversationForInjection?.contextCompactedMessageCount,
            slackContextCompactionWatermarkTs:
              slackConversationForInjection?.slackContextCompactionWatermarkTs,
          },
        )
      : null;

    // Guards the chronological-transcript override on re-injection after
    // the reducer compacts `ctx.messages`. The captured transcript is the
    // full persisted history; blindly replaying it on every re-inject would
    // overwrite the reducer's compacted messages and undo compaction. Flip
    // to `true` after any compaction so subsequent re-injections fall back
    // to the reduced `ctx.messages`.
    let reducerCompacted = compactedThisTurn;

    // Shared injection options — reused whenever we need to re-inject after reduction.
    const injectionOpts = {
      diskPressureContext,
      activeSurface,
      workspaceTopLevelContext: shouldInjectWorkspace
        ? ctx.workspaceTopLevelContext
        : null,
      channelCapabilities: ctx.channelCapabilities ?? null,
      channelCommandContext: ctx.commandIntent ?? null,
      unifiedTurnContext: unifiedTurnContextStr,
      pkbContext,
      pkbActive,
      pkbQueryVector,
      pkbSparseVector,
      pkbScopeId,
      pkbConversation,
      pkbAutoInjectList,
      pkbRoot,
      pkbWorkingDir: pkbActive ? ctx.workingDir : undefined,
      memoryV2Static,
      nowScratchpad,
      voiceCallControlPrompt: ctx.voiceCallControlPrompt ?? null,
      transportHints: ctx.transportHints ?? null,
      slackRuntimeContextNotice: ctx.slackRuntimeContextNotice ?? null,
      isNonInteractive: !isInteractiveResolved,
      subagentStatusBlock,
      slackChronologicalMessages,
      slackActiveThreadFocusBlock,
    } as const;

    let currentInjectionMode: InjectionMode = "full";

    // Canonical per-turn TurnContext forwarded to the injector chain. The
    // per-turn injection inputs are built inside `applyRuntimeInjections`
    // from the `injectionOpts` bag; we only need to hand in identity +
    // trust here so third-party injectors see the real turn metadata.
    const injectionTurnCtx = buildPluginTurnContext(ctx, reqId);

    const injection = await applyRuntimeInjections(runMessages, {
      ...injectionOpts,
      slackChronologicalMessages: reducerCompacted
        ? null
        : injectionOpts.slackChronologicalMessages,
      mode: currentInjectionMode,
      turnContext: injectionTurnCtx,
    });
    runMessages = injection.messages;

    // Persist injected blocks in message metadata so they survive conversation
    // reloads (eviction, restart, fork). loadFromDb re-injects from metadata.
    // Only the first call site persists — the overflow-recovery re-entry sites
    // send identical bytes and the tail row may not correspond to
    // `userMessageId`. All blocks are written in a single call to avoid
    // doubling SQLite SELECT+UPDATE work on every turn.
    if (
      injection.blocks.unifiedTurnContext ||
      injection.blocks.pkbSystemReminder ||
      injection.blocks.workspaceBlock ||
      injection.blocks.nowScratchpadBlock ||
      injection.blocks.pkbContextBlock
    ) {
      try {
        const metadataUpdates: Record<string, unknown> = {};
        if (injection.blocks.unifiedTurnContext) {
          metadataUpdates.turnContextBlock =
            injection.blocks.unifiedTurnContext;
        }
        if (injection.blocks.pkbSystemReminder) {
          metadataUpdates.pkbSystemReminderBlock =
            injection.blocks.pkbSystemReminder;
        }
        if (injection.blocks.workspaceBlock) {
          metadataUpdates.workspaceBlock = injection.blocks.workspaceBlock;
        }
        if (injection.blocks.nowScratchpadBlock) {
          metadataUpdates.nowScratchpadBlock =
            injection.blocks.nowScratchpadBlock;
        }
        if (injection.blocks.pkbContextBlock) {
          metadataUpdates.pkbContextBlock = injection.blocks.pkbContextBlock;
        }
        await runPipeline<PersistArgs, PersistResult>(
          "persistence",
          getMiddlewaresFor("persistence"),
          defaultPersistenceTerminal,
          {
            op: "update",
            messageId: userMessageId,
            updates: metadataUpdates,
          },
          buildPluginTurnContext(ctx, reqId),
          DEFAULT_TIMEOUTS.persistence,
        );
      } catch (err) {
        rlog.warn({ err }, "Failed to persist injection metadata (non-fatal)");
      }
    }

    // ── Preflight budget evaluation ──────────────────────────────
    // After runtime injections are applied, estimate the prompt token count
    // and proactively invoke the reducer if already above budget. This avoids
    // a wasted provider round-trip that would just fail with context_too_large.
    const overflowRecovery = effectiveContextWindow.overflowRecovery;
    const providerMaxTokens = effectiveContextWindow.maxInputTokens;
    // Widen safety margin for large conversations where estimation error
    // compounds across many messages with tool results.
    const baseSafetyMargin = overflowRecovery.safetyMarginRatio;
    const messageCount = ctx.messages.length;
    const safetyMargin =
      messageCount > 50 ? Math.max(baseSafetyMargin, 0.15) : baseSafetyMargin;
    const preflightBudget = Math.floor(providerMaxTokens * (1 - safetyMargin));
    let reducerState: ReducerState | undefined;

    const toolTokenBudget = ctx.agentLoop.getToolTokenBudget(runMessages);
    // Canonical calibration key — passed to the `tokenEstimate` pipeline for
    // every preflight/mid-loop estimate, the overflow reducer config, and the
    // convergence-path `estimatePromptTokens` call. Matches the key recorded
    // by `handleUsage` for wrapper providers (OpenRouter routing to
    // Anthropic → key is `"anthropic"`).
    const estimationProviderName = getCalibrationProviderKey(ctx.provider);

    // Shared `TurnContext` for every `tokenEstimate` pipeline invocation in
    // this turn. The pipeline is the extension point for plugins that want
    // to substitute an alternate estimator (e.g. provider-native tokenization)
    // without touching orchestrator code.
    //
    // Routed through the canonical builder — `turnIndex` is `ctx.turnCount`,
    // trust cascades through per-turn/conversation-level/fallback, and the
    // context-window handle rides along so any middleware that wants to
    // reuse the manager (e.g. to compute compaction-aware estimates) can.
    const pipelineTurnCtx = buildPluginTurnContext(ctx, reqId);

    const runTokenEstimatePipeline = (
      history: Message[],
    ): Promise<EstimateResult> =>
      runPipeline<EstimateArgs, EstimateResult>(
        "tokenEstimate",
        getMiddlewaresFor("tokenEstimate"),
        defaultTokenEstimateTerminal,
        {
          // Shallow-frozen copies so a misbehaving middleware that mutates
          // `args.history` or `args.tools` in place (e.g. trims the array
          // before calling next) can't silently strip prompt context from
          // the orchestrator's live `runMessages` / resolved-tools arrays.
          // TypeScript `readonly` on `EstimateArgs` does not prevent
          // `push`/`splice` at runtime; the frozen wrapper throws in strict
          // mode and isolates any mutation attempts from the call-site state.
          history: Object.freeze([...history]) as Message[],
          systemPrompt: ctx.systemPrompt,
          tools: Object.freeze([
            ...ctx.agentLoop.getResolvedTools(history),
          ]) as ToolDefinition[],
          providerName: estimationProviderName,
        },
        pipelineTurnCtx,
        DEFAULT_TIMEOUTS.tokenEstimate,
      );

    const preflightTokens = await runTokenEstimatePipeline(runMessages);

    if (overflowRecovery.enabled && preflightTokens > preflightBudget) {
      rlog.warn(
        {
          phase: "preflight",
          estimatedTokens: preflightTokens,
          budget: preflightBudget,
        },
        "Preflight budget exceeded — running overflow reducer before provider call",
      );

      // Overflow reduction runs through the plugin pipeline. The default
      // middleware (`default-overflow-reduce`, registered at bootstrap)
      // contains the historical tier loop — forced compaction → tool-result
      // truncation → media stubbing → injection downgrade — plus the
      // re-inject/re-estimate convergence check. The callbacks below are
      // the orchestrator-specific side effects that the plugin coordinates
      // per iteration (activity emission, compaction application, runtime
      // injection reassembly, token re-estimation). Registered plugins that
      // wrap the `overflowReduce` slot see each iteration through their own
      // middleware `next` callback.
      const messagesForPreflightOverflowReduction =
        slackChronologicalContext?.messages ?? ctx.messages;
      const overflowArgs: OverflowReduceArgs = {
        messages: messagesForPreflightOverflowReduction,
        runMessages,
        systemPrompt: ctx.systemPrompt,
        providerName: estimationProviderName,
        contextWindow: turnContextWindowConfig,
        preflightBudget,
        toolTokenBudget,
        maxAttempts: overflowRecovery.maxAttempts,
        abortSignal: abortController.signal,
        compactFn: async (msgs, signal, opts) => {
          // Route the reducer's forced-compaction tier through the
          // `compaction` pipeline so registered plugins observe these
          // invocations. Without this, custom compaction middleware only
          // sees the three orchestrator-owned call sites and misses the
          // reducer-initiated forced compactions entirely.
          //
          // Pipeline timeouts must be caught locally — a `PluginTimeoutError`
          // bubbling out of here would abort the overflow-reducer tier loop
          // entirely, skipping fallback tiers (tool-result truncation, media
          // stubbing, injection downgrade) and bypassing circuit-breaker
          // bookkeeping. On timeout, record the failure and return a
          // `compacted: false` result so the reducer falls through to the
          // next tier.
          try {
            return (await runPipeline<CompactionArgs, CompactionResult>(
              "compaction",
              getMiddlewaresFor("compaction"),
              (args) =>
                defaultCompactionTerminal(
                  args,
                  buildPluginTurnContext(ctx, reqId),
                ),
              {
                messages: msgs,
                signal,
                options: {
                  ...(opts ?? {}),
                  overrideProfile: turnOverrideProfile ?? null,
                },
              },
              buildPluginTurnContext(ctx, reqId),
              DEFAULT_TIMEOUTS.compaction,
            )) as Awaited<
              ReturnType<typeof ctx.contextWindowManager.maybeCompact>
            >;
          } catch (err) {
            if (err instanceof PluginTimeoutError) {
              rlog.warn(
                { err, phase: "overflow-reducer-forced-compaction" },
                "Compaction pipeline timed out — falling through to next reducer tier",
              );
              await trackCompactionOutcome(ctx, true, onEvent);
              return {
                messages: msgs,
                compacted: false,
                previousEstimatedInputTokens: 0,
                estimatedInputTokens: 0,
                maxInputTokens: 0,
                thresholdTokens: 0,
                compactedMessages: 0,
                compactedPersistedMessages: 0,
                summaryCalls: 0,
                summaryInputTokens: 0,
                summaryOutputTokens: 0,
                summaryModel: "",
                summaryText: "",
                reason: "compaction pipeline timed out",
              };
            }
            throw err;
          }
        },
        emitActivityState: () => {
          ctx.emitActivityState(
            "thinking",
            "context_compacting",
            "assistant_turn",
            reqId,
          );
        },
        onCompactionResult: async (result, compactedBasis) => {
          // Track circuit-breaker state whenever the reducer invoked
          // compaction. The reducer's forced_compaction tier uses
          // force:true, so it bypasses the open-circuit check, but we
          // still want failure tracking to detect a run of broken
          // summaries and clear the counter on success. Only track when
          // the summary LLM actually ran — `summaryFailed === undefined`
          // indicates an early return (no eligible messages,
          // truncation-only path, etc.) that shouldn't influence the
          // breaker.
          if (result.summaryFailed !== undefined) {
            await trackCompactionOutcome(ctx, result.summaryFailed, onEvent);
          }
          if (result.compacted) {
            await applySuccessfulCompaction(result, compactedBasis);
            shouldInjectWorkspace = true;
          }
        },
        reinjectForMode: async (
          reducedMessages,
          mode,
          stepCompacted,
          accumulatedCompacted,
        ) => {
          // Mirror the pre-PR-23 behavior: `ctx.messages` must track the
          // reducer's latest output before re-injection runs, because other
          // sites consulted through `injectionOpts` (`workspaceTopLevelContext`,
          // slack history, etc.) depend on it and `applyCompactionResult`
          // only updates `ctx.messages` on a compaction tier. Assigning here
          // keeps non-compaction tiers (tool-result truncation, media
          // stubbing, injection downgrade) observable to downstream
          // injection assembly on the same turn.
          ctx.messages = reducedMessages;

          // When THIS iteration compacted, it stripped existing NOW.md /
          // PKB blocks — so we re-inject current content. A later iteration
          // that only truncates or downgrades must NOT re-force PKB/NOW,
          // or each round would grow the token count.
          // Gate: only the iteration that actually compacted re-injects.
          const injection = await applyRuntimeInjections(reducedMessages, {
            ...injectionOpts,
            ...(stepCompacted && { pkbContext: currentPkbContent }),
            ...(stepCompacted && { memoryV2Static: currentMemoryV2Static }),
            ...(stepCompacted && { nowScratchpad: currentNowContent }),
            workspaceTopLevelContext: shouldInjectWorkspace
              ? ctx.workspaceTopLevelContext
              : null,
            // Once ANY iteration has compacted `ctx.messages`, the captured
            // `slackChronologicalMessages` snapshot (built from the full
            // persisted transcript) would overwrite the compacted history
            // and undo compaction. Suppress the override from here on —
            // sticky across subsequent non-compacting iterations.
            slackChronologicalMessages: accumulatedCompacted
              ? null
              : injectionOpts.slackChronologicalMessages,
            mode,
            turnContext: buildPluginTurnContext(ctx, reqId),
          });
          let next = injection.messages;
          if (isTrustedActor && mode !== "minimal") {
            const memResult = ctx.graphMemory.reinjectCachedMemory(next);
            next = memResult.runMessages;
          }
          return next;
        },
        estimatePostInjection: (runMsgs) =>
          estimatePromptTokens(runMsgs, ctx.systemPrompt, {
            providerName: estimationProviderName,
            toolTokenBudget,
          }),
      };

      const overflowResult = await runPipeline<
        OverflowReduceArgs,
        OverflowReduceResult
      >(
        "overflowReduce",
        getMiddlewaresFor("overflowReduce"),
        // Terminal — only reached when every registered middleware calls
        // `next` and delegates past the innermost layer. The default plugin
        // is a terminal itself (it doesn't call `next`), so in practice
        // this fallback fires only when the default has been explicitly
        // deregistered (tests) and no user plugin replaces it. Strict-fail
        // semantics: throw so the missing terminal surfaces as a visible
        // error instead of silently returning the history untouched.
        async () => {
          throw new PluginExecutionError(
            "overflowReduce pipeline has no terminal handler — every reducer middleware called next() without providing a replacement",
            "overflowReduce",
          );
        },
        overflowArgs,
        buildPluginTurnContext(ctx, reqId),
        DEFAULT_TIMEOUTS.overflowReduce,
      );

      ctx.messages = overflowResult.messages;
      runMessages = overflowResult.runMessages;
      currentInjectionMode = overflowResult.injectionMode;
      reducerState = overflowResult.reducerState;
      if (overflowResult.reducerCompacted) {
        reducerCompacted = true;
      }
    }

    // Pre-run repair — routed through the `historyRepair` plugin pipeline so
    // plugins can observe or override repair behavior. The default plugin's
    // middleware is a passthrough; the actual repair runs in the terminal
    // (`defaultHistoryRepairTerminal`).
    let preRepairMessages = runMessages;
    let preRunRepair: HistoryRepairResult | null = null;
    try {
      preRunRepair = await runPipeline<HistoryRepairArgs, HistoryRepairResult>(
        "historyRepair",
        getMiddlewaresFor("historyRepair"),
        async (args) => defaultHistoryRepairTerminal(args),
        { history: runMessages, provider: ctx.provider.name },
        buildPluginTurnContext(ctx, reqId),
        DEFAULT_TIMEOUTS.historyRepair,
      );
    } catch (err) {
      if (err instanceof PluginTimeoutError) {
        // Pipeline exceeded its budget — likely a misbehaving third-party
        // middleware. Degrade gracefully by proceeding with the un-repaired
        // history rather than turn-fatal-erroring; un-repaired history is
        // strictly better than no turn at all, and the provider call itself
        // will still error visibly if the drift is unrecoverable.
        rlog.warn(
          { err, phase: "pre_run" },
          "historyRepair pipeline timed out — proceeding with un-repaired history",
        );
      } else {
        throw err;
      }
    }
    if (preRunRepair !== null) {
      // Always adopt the pipeline's output history — a user `historyRepair`
      // middleware may rewrite `messages` (e.g. provider-specific
      // normalization) without incrementing any of the built-in repair
      // counters. Gating the assignment on `stats` would silently discard
      // those edits and send the un-rewritten history to the provider.
      runMessages = preRunRepair.messages;
      if (
        preRunRepair.stats.assistantToolResultsMigrated > 0 ||
        preRunRepair.stats.missingToolResultsInserted > 0 ||
        preRunRepair.stats.orphanToolResultsDowngraded > 0 ||
        preRunRepair.stats.consecutiveSameRoleMerged > 0
      ) {
        rlog.warn(
          { phase: "pre_run", ...preRunRepair.stats },
          "Repaired runtime history before provider call",
        );
      }
    }

    // Replace historical web_search_tool_result blocks with text summaries.
    // The opaque `encrypted_content` tokens Anthropic attaches to each result
    // expire / are route-scoped; replaying a stale token is rejected with
    // `Invalid encrypted_content in search_result block`. Titles + URLs
    // preserve enough context for the model on follow-up turns.
    const webSearchStrip = stripHistoricalWebSearchResults(runMessages);
    if (webSearchStrip.stats.blocksStripped > 0) {
      rlog.info(
        { phase: "pre_run", ...webSearchStrip.stats },
        "Converted historical web_search_tool_result blocks to text summaries",
      );
      runMessages = webSearchStrip.messages;
    }

    let preRunHistoryLength = runMessages.length;

    const shouldGenerateTitle = isReplaceableTitle(
      getConversation(ctx.conversationId)?.title ?? null,
    );

    const deps: EventHandlerDeps = {
      ctx,
      onEvent,
      reqId,
      isFirstMessage,
      shouldGenerateTitle,
      rlog,
      turnChannelContext: capturedTurnChannelContext,
      turnInterfaceContext: capturedTurnInterfaceContext,
    };
    const eventHandler = (event: AgentEvent) =>
      dispatchAgentEvent(state, deps, event);

    let yieldedForBudget = false;

    const onCheckpoint = async (
      checkpoint: CheckpointInfo,
    ): Promise<CheckpointDecision> => {
      state.currentTurnToolNames = [];

      if (ctx.canHandoffAtCheckpoint()) {
        yieldedForHandoff = true;
        return "yield";
      }

      // Mid-loop token budget check: estimate current context size and
      // yield if we're approaching the preflight budget. This lets the
      // conversation-agent-loop run compaction before the provider rejects.
      if (overflowRecovery.enabled) {
        const midLoopThreshold = preflightBudget * 0.85;
        const estimated = await runTokenEstimatePipeline(checkpoint.history);
        if (estimated > midLoopThreshold) {
          rlog.warn(
            { phase: "mid-loop", estimated, threshold: midLoopThreshold },
            "Token estimate approaching budget — yielding for compaction",
          );
          yieldedForBudget = true;
          return "yield";
        }
      }

      return "continue";
    };

    turnStarted = true;

    rlog.info({ callSite: turnCallSite }, "Starting agent loop run");

    // Thread the orchestrator's canonical per-turn context into the agent
    // loop so its internal pipeline invocations (llmCall, emptyResponse,
    // toolError, toolResultTruncate, toolExecute) see the real
    // conversation identity / trust / contextWindowManager instead of the
    // synthesized `"agent-loop"` placeholder. The loop clones this value
    // and overwrites `turnIndex` with its own tool-use iteration counter.
    const loopTurnCtx = buildPluginTurnContext(ctx, reqId);

    let updatedHistory = await ctx.agentLoop.run(
      runMessages,
      eventHandler,
      abortController.signal,
      reqId,
      onCheckpoint,
      turnCallSite,
      loopTurnCtx,
      turnOverrideProfile,
      effectiveContextWindow.maxInputTokens,
    );

    rlog.info(
      { resultMessageCount: updatedHistory.length },
      "Agent loop run completed",
    );

    // ── Proactive mid-loop compaction ───────────────────────────────
    // When the agent loop yielded because the token budget check in
    // onCheckpoint detected approaching limits, run compaction on the
    // accumulated history and re-enter the agent loop. This is distinct
    // from the reactive convergence loop below that fires after a
    // provider rejection — here we compact *before* hitting the limit.
    let midLoopCompactAttempts = 0;
    while (
      yieldedForBudget &&
      midLoopCompactAttempts < overflowRecovery.maxAttempts &&
      !state.contextTooLargeDetected &&
      !abortController.signal.aborted
    ) {
      midLoopCompactAttempts++;
      yieldedForBudget = false;

      rlog.info(
        { phase: "mid-loop-compact" },
        "Running compaction after checkpoint yield",
      );

      // Strip injected context from updated history before compacting,
      // so we compact the "raw" persistent messages.
      const rawHistory = stripInjectionsForCompaction(updatedHistory);
      ctx.messages = rawHistory;
      try {
        clearStrippedInjectionMetadataForConversation(ctx.conversationId);
      } catch (err) {
        rlog.warn(
          { err },
          "Failed to clear stripped-injection metadata after compaction strip (non-fatal)",
        );
      }

      ctx.emitActivityState(
        "thinking",
        "context_compacting",
        "assistant_turn",
        reqId,
        "Compacting context",
      );
      let midLoopCompact: Awaited<
        ReturnType<typeof ctx.contextWindowManager.maybeCompact>
      >;
      try {
        midLoopCompact = (await runPipeline<CompactionArgs, CompactionResult>(
          "compaction",
          getMiddlewaresFor("compaction"),
          (args) =>
            defaultCompactionTerminal(args, buildPluginTurnContext(ctx, reqId)),
          {
            messages: ctx.messages,
            signal: abortController.signal,
            options: {
              lastCompactedAt: ctx.contextCompactedAt ?? undefined,
              force: true,
              targetInputTokensOverride: preflightBudget,
              conversationOriginChannel:
                getConversationOriginChannel(ctx.conversationId) ?? undefined,
              overrideProfile: turnOverrideProfile ?? null,
            },
          },
          buildPluginTurnContext(ctx, reqId),
          DEFAULT_TIMEOUTS.compaction,
        )) as Awaited<ReturnType<typeof ctx.contextWindowManager.maybeCompact>>;
      } catch (err) {
        if (err instanceof PluginTimeoutError) {
          // Mid-loop compaction timed out. Record the failure for the
          // circuit breaker and escalate to the convergence loop's more
          // aggressive reducer tiers (tool-result truncation, media
          // stubbing, injection downgrade) by flipping the overflow flag
          // and breaking out of the mid-loop retry. The existing
          // "exhausted all attempts" block further down handles the
          // escalation.
          rlog.warn(
            { err, phase: "mid-loop-compact" },
            "Compaction pipeline timed out — escalating to convergence loop",
          );
          await trackCompactionOutcome(ctx, true, onEvent);
          state.contextTooLargeDetected = true;
          break;
        }
        throw err;
      }
      // `force: true` bypasses the cooldown/threshold gates but early returns
      // for "no eligible messages" / "insufficient messages" still leave
      // `summaryFailed` undefined. Only track when the summary LLM actually ran.
      if (midLoopCompact.summaryFailed !== undefined) {
        await trackCompactionOutcome(
          ctx,
          midLoopCompact.summaryFailed,
          onEvent,
        );
      }
      if (midLoopCompact.compacted) {
        await applySuccessfulCompaction(midLoopCompact, rawHistory);
        reducerCompacted = true;
        shouldInjectWorkspace = true;
      }

      // Re-inject runtime context and re-enter the agent loop.
      // stripInjectionsForCompaction() unconditionally removed the existing
      // NOW.md block from ctx.messages above, so we must always re-inject
      // the current content regardless of whether compaction actually ran.
      const injection = await applyRuntimeInjections(ctx.messages, {
        ...injectionOpts,
        pkbContext: currentPkbContent,
        memoryV2Static: currentMemoryV2Static,
        nowScratchpad: currentNowContent,
        workspaceTopLevelContext: shouldInjectWorkspace
          ? ctx.workspaceTopLevelContext
          : null,
        // Suppress the chronological-transcript snapshot once the reducer
        // has collapsed `ctx.messages`; the captured snapshot reflects the
        // full persisted transcript and would overwrite compaction.
        slackChronologicalMessages: reducerCompacted
          ? null
          : injectionOpts.slackChronologicalMessages,
        mode: currentInjectionMode,
        turnContext: buildPluginTurnContext(ctx, reqId),
      });
      runMessages = injection.messages;
      if (isTrustedActor && currentInjectionMode !== "minimal") {
        ctx.graphMemory.retrackCachedNodes();
      }
      const midLoopCompactStrip = stripHistoricalWebSearchResults(runMessages);
      if (midLoopCompactStrip.stats.blocksStripped > 0) {
        rlog.info(
          { phase: "mid-loop-compact", ...midLoopCompactStrip.stats },
          "Converted historical web_search_tool_result blocks to text summaries",
        );
        runMessages = midLoopCompactStrip.messages;
      }
      preRepairMessages = runMessages;
      preRunHistoryLength = runMessages.length;

      updatedHistory = await ctx.agentLoop.run(
        runMessages,
        eventHandler,
        abortController.signal,
        reqId,
        onCheckpoint,
        turnCallSite,
        loopTurnCtx,
        turnOverrideProfile,
        effectiveContextWindow.maxInputTokens,
      );
    }

    // If mid-loop compaction exhausted all attempts but the agent loop
    // still yielded (yieldedForBudget is true), the turn is incomplete.
    // Escalate to the convergence loop's more aggressive reducer tiers
    // (tool-result truncation, media stubbing, injection downgrade)
    // instead of silently treating an incomplete turn as done.
    if (yieldedForBudget && !abortController.signal.aborted) {
      rlog.warn(
        {
          phase: "mid-loop-compact",
          midLoopCompactAttempts,
          maxAttempts: overflowRecovery.maxAttempts,
        },
        "Mid-loop compaction exhausted all attempts — escalating to convergence loop",
      );
      state.contextTooLargeDetected = true;
    }

    // One-shot ordering error retry
    if (
      state.orderingErrorDetected &&
      updatedHistory.length === preRunHistoryLength
    ) {
      rlog.warn(
        { phase: "retry" },
        "Provider ordering error detected, attempting one-shot deep-repair retry",
      );
      // Design note: deep-repair intentionally bypasses the `historyRepair`
      // plugin pipeline. Deep-repair is a recovery-only path triggered by a
      // provider ordering error — it must be deterministic and unaffected by
      // user middleware that might have caused (or be unable to recover from)
      // the original drift. Plugins can already observe / override the
      // pre-run repair via the `historyRepair` pipeline above; widening that
      // surface to deep-repair is intentionally deferred until there's a
      // concrete plugin-level use case. Do not route this call through
      // `runPipeline` without first revisiting that contract.
      const retryRepair = deepRepairHistory(runMessages);
      runMessages = retryRepair.messages;
      const retryStrip = stripHistoricalWebSearchResults(runMessages);
      runMessages = retryStrip.messages;
      preRepairMessages = runMessages;
      preRunHistoryLength = runMessages.length;
      state.orderingErrorDetected = false;
      state.deferredOrderingError = null;

      updatedHistory = await ctx.agentLoop.run(
        runMessages,
        eventHandler,
        abortController.signal,
        reqId,
        onCheckpoint,
        turnCallSite,
        loopTurnCtx,
        turnOverrideProfile,
        effectiveContextWindow.maxInputTokens,
      );

      if (state.orderingErrorDetected) {
        rlog.error(
          { phase: "retry" },
          "Deep-repair retry also failed with ordering error. Consider starting a new conversation if this persists.",
        );
      }
    }

    // ── Bounded context overflow convergence loop ──────────────────
    // When the provider rejects with context-too-large, iterate through
    // reducer tiers (forced compaction, tool-result truncation, media
    // stubbing, injection downgrade).
    //
    // When progress was made (agent added messages before hitting the
    // limit), incorporate those new messages into ctx.messages so the
    // convergence loop operates on the full (larger) history.
    if (state.contextTooLargeDetected) {
      // Detect whether ctx.messages currently lacks NOW.md so we know if
      // it needs to be re-injected.  Mid-loop compaction (line ~1067) may
      // have already stripped injections before escalating here, so we
      // check actual message state rather than tracking mutation sites.
      let convergenceStripped =
        findLastInjectedNowContent(ctx.messages) === null;

      if (updatedHistory.length > preRunHistoryLength) {
        ctx.messages = stripInjectionsForCompaction(updatedHistory);
        try {
          clearStrippedInjectionMetadataForConversation(ctx.conversationId);
        } catch (err) {
          rlog.warn(
            { err },
            "Failed to clear stripped-injection metadata after compaction strip (non-fatal)",
          );
        }
        convergenceStripped = true;
        preRepairMessages = updatedHistory;
        preRunHistoryLength = updatedHistory.length;
      }
      if (!reducerState) {
        reducerState = createInitialReducerState();
      }

      // When the provider reveals the actual token count in its error
      // message (e.g. "242201 tokens > 200000"), use it to correct the
      // compaction target. The estimator may significantly underestimate
      // (e.g. estimated 185k but actual was 242k), so using the
      // uncorrected preflightBudget would still be too high. Passes the raw
      // error so ContextOverflowError.actualTokens can short-circuit the
      // string-regex path for proxy-rewrapped untyped errors.
      const actualTokens = parseActualTokensFromError(
        state.contextTooLargeError,
      );
      const estimatedTokensAtOverflow = estimatePromptTokens(
        ctx.messages,
        ctx.systemPrompt,
        {
          providerName: estimationProviderName,
          toolTokenBudget,
        },
      );
      let correctedTarget = preflightBudget;
      if (actualTokens && estimatedTokensAtOverflow > 0) {
        const estimationErrorRatio = actualTokens / estimatedTokensAtOverflow;
        if (estimationErrorRatio > 1.0) {
          correctedTarget = Math.floor(preflightBudget / estimationErrorRatio);
          rlog.warn(
            {
              phase: "convergence",
              actualTokens,
              estimatedTokens: estimatedTokensAtOverflow,
              estimationErrorRatio: estimationErrorRatio.toFixed(2),
              preflightBudget,
              correctedTarget,
            },
            "Adjusting compaction target based on observed estimation error",
          );
        }
      }

      let convergenceAttempts = 0;
      const maxAttempts = overflowRecovery.maxAttempts;

      while (
        state.contextTooLargeDetected &&
        convergenceAttempts < maxAttempts &&
        !reducerState.exhausted
      ) {
        convergenceAttempts++;
        rlog.warn(
          {
            phase: "convergence",
            attempt: convergenceAttempts,
            appliedTiers: reducerState.appliedTiers,
          },
          "Context too large — applying next reducer tier",
        );

        ctx.emitActivityState(
          "thinking",
          "context_compacting",
          "assistant_turn",
          reqId,
        );
        const convergenceCompactionBasis = ctx.messages;
        const step = await reduceContextOverflow(
          convergenceCompactionBasis,
          {
            providerName: estimationProviderName,
            systemPrompt: ctx.systemPrompt,
            contextWindow: turnContextWindowConfig,
            targetTokens: correctedTarget,
            toolTokenBudget,
          },
          reducerState,
          (msgs, signal, opts) =>
            ctx.contextWindowManager.maybeCompact(msgs, signal!, {
              ...(opts ?? {}),
              overrideProfile: turnOverrideProfile ?? null,
            }),
          abortController.signal,
        );

        reducerState = step.state;
        ctx.messages = step.messages;
        currentInjectionMode = step.state.injectionMode;

        // See the preflight reducer call above for rationale. Only track when
        // the summary LLM actually ran — `summaryFailed === undefined`
        // indicates the reducer's forced compaction took an early-return path
        // without calling the summary LLM.
        if (
          step.compactionResult &&
          step.compactionResult.summaryFailed !== undefined
        ) {
          await trackCompactionOutcome(
            ctx,
            step.compactionResult.summaryFailed,
            onEvent,
          );
        }

        if (step.compactionResult?.compacted) {
          await applySuccessfulCompaction(
            step.compactionResult,
            convergenceCompactionBasis,
          );
          shouldInjectWorkspace = true;
          reducerCompacted = true;
        }

        // Only re-inject NOW.md when ctx.messages was actually stripped;
        // otherwise the existing NOW.md block is still present and
        // re-injecting would duplicate it.
        const injection = await applyRuntimeInjections(ctx.messages, {
          ...injectionOpts,
          pkbContext: currentPkbContent,
          memoryV2Static: convergenceStripped ? currentMemoryV2Static : null,
          nowScratchpad: convergenceStripped ? currentNowContent : null,
          workspaceTopLevelContext: shouldInjectWorkspace
            ? ctx.workspaceTopLevelContext
            : null,
          slackChronologicalMessages: reducerCompacted
            ? null
            : injectionOpts.slackChronologicalMessages,
          mode: currentInjectionMode,
          turnContext: buildPluginTurnContext(ctx, reqId),
        });
        runMessages = injection.messages;
        if (isTrustedActor && currentInjectionMode !== "minimal") {
          ctx.graphMemory.retrackCachedNodes();
        }
        const convergenceStrip = stripHistoricalWebSearchResults(runMessages);
        if (convergenceStrip.stats.blocksStripped > 0) {
          rlog.info(
            { phase: "convergence", ...convergenceStrip.stats },
            "Converted historical web_search_tool_result blocks to text summaries",
          );
          runMessages = convergenceStrip.messages;
        }
        preRepairMessages = runMessages;
        preRunHistoryLength = runMessages.length;
        state.contextTooLargeDetected = false;
        yieldedForBudget = false;

        updatedHistory = await ctx.agentLoop.run(
          runMessages,
          eventHandler,
          abortController.signal,
          reqId,
          onCheckpoint,
          turnCallSite,
          loopTurnCtx,
          turnOverrideProfile,
          effectiveContextWindow.maxInputTokens,
        );

        // If the rerun still yields at checkpoint, the turn is still
        // incomplete — continue reducing through the remaining tiers
        // instead of silently dropping the incomplete state.
        if (yieldedForBudget && !abortController.signal.aborted) {
          rlog.warn(
            {
              phase: "convergence",
              attempt: convergenceAttempts,
              appliedTiers: reducerState.appliedTiers,
            },
            "Post-convergence rerun still yielded at checkpoint — continuing reduction",
          );
          state.contextTooLargeDetected = true;

          // Fold rerun progress into ctx.messages so the next reducer
          // tier operates on up-to-date history instead of stale
          // pre-rerun messages.
          if (updatedHistory.length > preRunHistoryLength) {
            ctx.messages = stripInjectionsForCompaction(updatedHistory);
            try {
              clearStrippedInjectionMetadataForConversation(ctx.conversationId);
            } catch (err) {
              rlog.warn(
                { err },
                "Failed to clear stripped-injection metadata after compaction strip (non-fatal)",
              );
            }
            convergenceStripped = true;
            preRepairMessages = updatedHistory;
            preRunHistoryLength = updatedHistory.length;
          }
        }
      }

      // All reducer tiers exhausted but provider still rejects —
      // consult the overflow policy for latest-turn compression.
      // The policy either auto-compresses the latest turn or falls
      // through to the final graceful-error fallback below.
      if (state.contextTooLargeDetected) {
        const action = resolveOverflowAction({
          overflowRecovery,
          isInteractive: isInteractiveResolved,
        });

        if (action === "auto_compress_latest_turn") {
          // Auto-compress without asking — users opt out via the "drop" policy.
          ctx.emitActivityState(
            "thinking",
            "context_compacting",
            "assistant_turn",
            reqId,
          );
          let emergencyCompact: Awaited<
            ReturnType<typeof ctx.contextWindowManager.maybeCompact>
          > | null = null;
          try {
            emergencyCompact = (await runPipeline<
              CompactionArgs,
              CompactionResult
            >(
              "compaction",
              getMiddlewaresFor("compaction"),
              (args) =>
                defaultCompactionTerminal(
                  args,
                  buildPluginTurnContext(ctx, reqId),
                ),
              {
                messages: ctx.messages,
                signal: abortController.signal,
                options: {
                  lastCompactedAt: ctx.contextCompactedAt ?? undefined,
                  force: true,
                  minKeepRecentUserTurns: 0,
                  targetInputTokensOverride: correctedTarget,
                  overrideProfile: turnOverrideProfile ?? null,
                },
              },
              buildPluginTurnContext(ctx, reqId),
              DEFAULT_TIMEOUTS.compaction,
            )) as Awaited<
              ReturnType<typeof ctx.contextWindowManager.maybeCompact>
            >;
          } catch (err) {
            if (err instanceof PluginTimeoutError) {
              // Emergency compaction timed out. Record the circuit-breaker
              // failure and fall through to the graceful-error path below
              // (the unsuccessful-compaction fallback) rather than hard-
              // failing the turn.
              rlog.warn(
                { err, phase: "emergency-compaction" },
                "Emergency compaction pipeline timed out — continuing with overflow fallback",
              );
              await trackCompactionOutcome(ctx, true, onEvent);
              emergencyCompact = null;
            } else {
              throw err;
            }
          }
          // Only track when the summary LLM actually ran; `force: true`
          // bypasses the cooldown but not the early-return paths.
          if (
            emergencyCompact &&
            emergencyCompact.summaryFailed !== undefined
          ) {
            await trackCompactionOutcome(
              ctx,
              emergencyCompact.summaryFailed,
              onEvent,
            );
          }
          if (emergencyCompact?.compacted) {
            await applySuccessfulCompaction(emergencyCompact, ctx.messages);
            reducerCompacted = true;
            shouldInjectWorkspace = true;
          }

          // Only re-inject NOW.md when ctx.messages was actually stripped;
          // otherwise the existing block is still present.
          const injection = await applyRuntimeInjections(ctx.messages, {
            ...injectionOpts,
            pkbContext: currentPkbContent,
            memoryV2Static: convergenceStripped ? currentMemoryV2Static : null,
            nowScratchpad: convergenceStripped ? currentNowContent : null,
            workspaceTopLevelContext: shouldInjectWorkspace
              ? ctx.workspaceTopLevelContext
              : null,
            slackChronologicalMessages: reducerCompacted
              ? null
              : injectionOpts.slackChronologicalMessages,
            mode: currentInjectionMode,
            turnContext: buildPluginTurnContext(ctx, reqId),
          });
          runMessages = injection.messages;
          if (isTrustedActor && currentInjectionMode !== "minimal") {
            ctx.graphMemory.retrackCachedNodes();
          }
          const fallbackStrip = stripHistoricalWebSearchResults(runMessages);
          if (fallbackStrip.stats.blocksStripped > 0) {
            rlog.info(
              { phase: "fail_gracefully_compact", ...fallbackStrip.stats },
              "Converted historical web_search_tool_result blocks to text summaries",
            );
            runMessages = fallbackStrip.messages;
          }
          preRepairMessages = runMessages;
          preRunHistoryLength = runMessages.length;
          state.contextTooLargeDetected = false;

          updatedHistory = await ctx.agentLoop.run(
            runMessages,
            eventHandler,
            abortController.signal,
            reqId,
            onCheckpoint,
            turnCallSite,
            loopTurnCtx,
            turnOverrideProfile,
            effectiveContextWindow.maxInputTokens,
          );
        }
        // action === "fail_gracefully" falls through to the final error below
      }

      // Final fallback: all recovery paths exhausted
      if (state.contextTooLargeDetected) {
        const classified = classifyConversationError(
          new Error("context_length_exceeded"),
          { phase: "agent_loop" },
        );
        onEvent(buildConversationErrorMessage(ctx.conversationId, classified));
      }
    }

    if (state.deferredOrderingError) {
      const classified = classifyConversationError(
        new Error(state.deferredOrderingError),
        { phase: "agent_loop" },
      );
      onEvent(buildConversationErrorMessage(ctx.conversationId, classified));
    }

    // Reconcile synthesized cancellation tool_results
    for (let i = preRunHistoryLength; i < updatedHistory.length; i++) {
      const msg = updatedHistory[i];
      if (msg.role === "user") {
        for (const block of msg.content) {
          if (
            block.type === "tool_result" &&
            !state.pendingToolResults.has(block.tool_use_id) &&
            !state.persistedToolUseIds.has(block.tool_use_id)
          ) {
            state.pendingToolResults.set(block.tool_use_id, {
              content: block.content,
              isError: block.is_error ?? false,
            });
          }
        }
      }
    }

    // Flush remaining tool results
    if (state.pendingToolResults.size > 0) {
      const toolResultBlocks = Array.from(
        state.pendingToolResults.entries(),
      ).map(([toolUseId, result]) => ({
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
      const toolResultMetadata = {
        ...provenanceFromTrustContext(ctx.trustContext),
        userMessageChannel: capturedTurnChannelContext.userMessageChannel,
        assistantMessageChannel:
          capturedTurnChannelContext.assistantMessageChannel,
        userMessageInterface: capturedTurnInterfaceContext.userMessageInterface,
        assistantMessageInterface:
          capturedTurnInterfaceContext.assistantMessageInterface,
      };
      await runPipeline<PersistArgs, PersistResult>(
        "persistence",
        getMiddlewaresFor("persistence"),
        defaultPersistenceTerminal,
        {
          op: "add",
          conversationId: ctx.conversationId,
          role: "user",
          content: JSON.stringify(toolResultBlocks),
          metadata: toolResultMetadata,
        },
        buildPluginTurnContext(ctx, reqId),
        DEFAULT_TIMEOUTS.persistence,
      );
      state.pendingToolResults.clear();
    }

    // Reconstruct history
    const newMessages = updatedHistory.slice(preRunHistoryLength).map((msg) => {
      if (msg.role !== "assistant") return msg;
      const { cleanedContent } = cleanAssistantContent(msg.content);
      const cleanedBlocks = cleanedContent as ContentBlock[];
      return { ...msg, content: cleanedBlocks };
    });

    const hasAssistantResponse = newMessages.some(
      (msg) => msg.role === "assistant",
    );
    if (
      !hasAssistantResponse &&
      state.providerErrorUserMessage &&
      !abortController.signal.aborted &&
      !yieldedForHandoff
    ) {
      const errChannelMeta = {
        ...provenanceFromTrustContext(ctx.trustContext),
        userMessageChannel: capturedTurnChannelContext.userMessageChannel,
        assistantMessageChannel:
          capturedTurnChannelContext.assistantMessageChannel,
        userMessageInterface: capturedTurnInterfaceContext.userMessageInterface,
        assistantMessageInterface:
          capturedTurnInterfaceContext.assistantMessageInterface,
      };
      const errorAssistantMessage = createAssistantMessage(
        state.providerErrorUserMessage,
      );
      await runPipeline<PersistArgs, PersistResult>(
        "persistence",
        getMiddlewaresFor("persistence"),
        defaultPersistenceTerminal,
        {
          op: "add",
          conversationId: ctx.conversationId,
          role: "assistant",
          content: JSON.stringify(errorAssistantMessage.content),
          metadata: errChannelMeta,
        },
        buildPluginTurnContext(ctx, reqId),
        DEFAULT_TIMEOUTS.persistence,
      );
      newMessages.push(errorAssistantMessage);
      // Do NOT send assistant_text_delta here — handleProviderError already
      // emitted a conversation_error event for this same error text, and the
      // client renders it as an InlineChatErrorAlert. Sending a text delta
      // would create a duplicate plain-text bubble below the alert card.
    }

    let restoredHistory = [...preRepairMessages, ...newMessages];

    // Post-turn tool result truncation: save large results to disk and
    // replace in-context content with a prefix/suffix stub + file pointer.
    try {
      const conv = getConversation(ctx.conversationId);
      if (conv) {
        const convDir = getResolvedConversationDirPath(
          ctx.conversationId,
          conv.createdAt,
        );
        const { messages: derefMessages, dereferencedCount } =
          derefToolResultReReads(restoredHistory);
        const { messages: truncatedMessages, truncatedCount } =
          postTurnTruncateToolResults(derefMessages, {
            conversationDir: convDir,
          });
        if (truncatedCount > 0 || dereferencedCount > 0) {
          rlog.info(
            { truncatedCount, dereferencedCount },
            "Post-turn tool result truncation applied",
          );
        }
        restoredHistory = truncatedMessages;
      }
    } catch (err) {
      rlog.warn({ err }, "Post-turn tool result truncation failed (non-fatal)");
    }

    // Persist injections in history: runtime-injected context stays on
    // historical user messages so the conversation prefix is stable for
    // Anthropic's prefix caching.  Stripping only happens during
    // compaction/overflow recovery (where a cache miss is expected).
    ctx.messages = restoredHistory;

    emitUsage(
      ctx,
      state.exchangeInputTokens,
      state.exchangeOutputTokens,
      state.model,
      onEvent,
      "main_agent",
      reqId,
      state.exchangeCacheCreationInputTokens,
      state.exchangeCacheReadInputTokens,
      collapseRawResponses(state.exchangeRawResponses),
      state.exchangeProviderName,
      state.exchangeLlmCallCount,
      {
        tokens: state.lastCallInputTokens,
        maxTokens: effectiveContextWindow.maxInputTokens,
      },
      {
        callSite: turnCallSite,
        overrideProfile: turnOverrideProfile ?? null,
      },
    );

    const syncLastAssistantMessageToDisk = (): void => {
      if (!state.lastAssistantMessageId) return;
      const convForDisk = getConversation(ctx.conversationId);
      if (!convForDisk) return;
      syncMessageToDisk(
        ctx.conversationId,
        state.lastAssistantMessageId,
        convForDisk.createdAt,
      );
    };

    // Fast-path: when the user cancelled, skip expensive post-loop work
    // (attachment resolution) and emit the cancellation event immediately
    // so the client can re-enable the UI without delay.
    if (abortController.signal.aborted) {
      syncLastAssistantMessageToDisk();
      ctx.emitActivityState("idle", "generation_cancelled", "global", reqId);
      ctx.traceEmitter.emit(
        "generation_cancelled",
        "Generation cancelled by user",
        {
          requestId: reqId,
          status: "warning",
        },
      );
      onEvent({
        type: "generation_cancelled",
        conversationId: ctx.conversationId,
      });
    } else {
      // Resolve attachments (only when not cancelled — this is expensive async I/O)
      const attachmentResult = await resolveAssistantAttachments(
        state.accumulatedDirectives,
        state.accumulatedToolContentBlocks,
        state.directiveWarnings,
        ctx.workingDir,
        async (filePath) =>
          approveHostAttachmentRead(
            filePath,
            ctx.workingDir,
            ctx.prompter,
            ctx.conversationId,
            ctx.hasNoClient,
          ),
        state.lastAssistantMessageId,
        state.toolContentBlockToolNames,
      );
      const { assistantAttachments, emittedAttachments } = attachmentResult;

      ctx.lastAssistantAttachments = assistantAttachments;
      ctx.lastAttachmentWarnings = attachmentResult.directiveWarnings;
      syncLastAssistantMessageToDisk();
      const clientDisplayMessageId = getClientDisplayMessageId(state);

      // Re-check: the user may have cancelled during attachment resolution
      if (abortController.signal.aborted) {
        ctx.emitActivityState("idle", "generation_cancelled", "global", reqId);
        ctx.traceEmitter.emit(
          "generation_cancelled",
          "Generation cancelled by user",
          {
            requestId: reqId,
            status: "warning",
          },
        );
        onEvent({
          type: "generation_cancelled",
          conversationId: ctx.conversationId,
        });
      } else if (yieldedForHandoff) {
        ctx.traceEmitter.emit(
          "generation_handoff",
          "Handing off to next queued message",
          {
            requestId: reqId,
            status: "info",
            attributes: { queuedCount: ctx.getQueueDepth() },
          },
        );
        onEvent({
          type: "generation_handoff",
          conversationId: ctx.conversationId,
          requestId: reqId,
          queuedCount: ctx.getQueueDepth(),
          ...(emittedAttachments.length > 0
            ? { attachments: emittedAttachments }
            : {}),
          ...(ctx.lastAttachmentWarnings.length > 0
            ? { attachmentWarnings: ctx.lastAttachmentWarnings }
            : {}),
          ...(state.lastAssistantMessageId
            ? { messageId: state.lastAssistantMessageId }
            : {}),
          ...(clientDisplayMessageId
            ? { displayMessageId: clientDisplayMessageId }
            : {}),
        });
      } else {
        ctx.emitActivityState("idle", "message_complete", "global", reqId);
        ctx.traceEmitter.emit(
          "message_complete",
          "Message processing complete",
          {
            requestId: reqId,
            status: "success",
          },
        );
        onEvent({
          type: "message_complete",
          conversationId: ctx.conversationId,
          ...(emittedAttachments.length > 0
            ? { attachments: emittedAttachments }
            : {}),
          ...(ctx.lastAttachmentWarnings.length > 0
            ? { attachmentWarnings: ctx.lastAttachmentWarnings }
            : {}),
          ...(state.lastAssistantMessageId
            ? { messageId: state.lastAssistantMessageId }
            : {}),
          ...(clientDisplayMessageId
            ? { displayMessageId: clientDisplayMessageId }
            : {}),
        });

        // Emit a home-feed event for background/scheduled conversation completions.
        // Scoped to message_complete only (not cancelled/handoff), wrapped in
        // try-catch so malformed message content can never propagate errors.
        try {
          const conv = getConversation(ctx.conversationId);
          if (
            conv &&
            (conv.conversationType === "background" ||
              conv.conversationType === "scheduled")
          ) {
            const lastMsg = state.lastAssistantMessageId
              ? getMessageById(state.lastAssistantMessageId, ctx.conversationId)
              : undefined;
            let summary: string;
            if (lastMsg) {
              const parsed: unknown = JSON.parse(lastMsg.content);
              if (typeof parsed === "string") {
                summary = parsed.slice(0, 200);
              } else if (Array.isArray(parsed)) {
                const textBlock = parsed.find(
                  (b: { type?: string }) => b.type === "text",
                );
                summary =
                  typeof textBlock?.text === "string"
                    ? textBlock.text.slice(0, 200)
                    : (conv.title ?? "Background task completed.");
              } else {
                summary = conv.title ?? "Background task completed.";
              }
            } else {
              summary = conv.title ?? "Background task completed.";
            }
            const feedTitle =
              conv.title && !isReplaceableTitle(conv.title)
                ? conv.title
                : "Background task";
            const dedupKey = `bg-conv:${ctx.conversationId}`;
            void emitFeedEvent({
              source: "assistant",
              title: feedTitle,
              summary,
              dedupKey,
              conversationId: ctx.conversationId,
            }).catch((err) => {
              log.warn(
                { err, conversationId: ctx.conversationId },
                "Failed to emit background conversation feed event",
              );
            });

            if (isReplaceableTitle(conv.title ?? null)) {
              void rewriteFeedTitle(feedTitle)
                .then((prose) => {
                  if (prose && prose !== feedTitle) {
                    return emitFeedEvent({
                      source: "assistant",
                      title: prose,
                      summary,
                      dedupKey,
                      conversationId: ctx.conversationId,
                    });
                  }
                })
                .catch((err) => {
                  log.warn(
                    { err, conversationId: ctx.conversationId },
                    "Failed to update feed event with prose title rewrite",
                  );
                });
            }
          }
        } catch (feedErr) {
          log.warn(
            { err: feedErr, conversationId: ctx.conversationId },
            "Failed to build home-feed event for background conversation",
          );
        }

        // Proactive artifact: fire once when the processed turn was the 4th user message.
        // Only trigger for real user-authored turns (not subagent/system messages).
        {
          const paConv = getConversation(ctx.conversationId);
          if (
            paConv &&
            paConv.conversationType === "standard" &&
            options?.isUserMessage
          ) {
            void (async () => {
              try {
                if (hasProactiveArtifactCompleted()) return;
                const userMsg = getMessageById(
                  userMessageId,
                  ctx.conversationId,
                );
                if (!userMsg) return;
                if (!tryClaimProactiveArtifactTrigger(userMsg.createdAt))
                  return;
                await runProactiveArtifactJob({
                  conversationId: ctx.conversationId,
                  userMessageCutoff: userMsg.createdAt,
                  assistantMessageId: state.lastAssistantMessageId,
                  suppressAppBuild: state.appBuildToolUsedThisRun,
                  broadcastMessage,
                });
              } catch (err) {
                log.warn(
                  { err, conversationId: ctx.conversationId },
                  "Proactive artifact trigger failed",
                );
              }
            })();
          }
        }
      }
    }

    // Second title pass: after 3 completed turns, re-generate the title
    // using the last 3 messages for better context. Only fires when the
    // current title was auto-generated (isAutoTitle = 1) and the user
    // has not opted out via `conversations.skipAutoRetitling`.
    if (ctx.turnCount === 2 && !getConfig().conversations.skipAutoRetitling) {
      // turnCount is 0-indexed, incremented in finally; 2 = about to become 3rd turn
      queueRegenerateConversationTitle({
        conversationId: ctx.conversationId,
        provider: ctx.provider,
        onTitleUpdated: (title) => {
          onEvent({
            type: "conversation_title_updated",
            conversationId: ctx.conversationId,
            title,
          });
        },
        signal: abortController.signal,
      });
    }
  } catch (err) {
    const errorCtx = {
      phase: "agent_loop" as const,
      aborted: abortController.signal.aborted,
    };
    if (isUserCancellation(err, errorCtx)) {
      ctx.emitActivityState("idle", "generation_cancelled", "global", reqId);
      rlog.info("Generation cancelled by user");
      ctx.traceEmitter.emit(
        "generation_cancelled",
        "Generation cancelled by user",
        {
          requestId: reqId,
          status: "warning",
        },
      );
      onEvent({
        type: "generation_cancelled",
        conversationId: ctx.conversationId,
      });
    } else {
      ctx.emitActivityState("idle", "error_terminal", "global", reqId);
      const message = err instanceof Error ? err.message : String(err);
      const errorClass = err instanceof Error ? err.constructor.name : "Error";
      rlog.error({ err }, "Conversation processing error");
      const classified = classifyConversationError(err, errorCtx);
      ctx.traceEmitter.emit("request_error", truncate(message, 200, ""), {
        requestId: reqId,
        status: "error",
        attributes: {
          errorClass,
          message: truncate(message, 500, ""),
          errorCategory: classified.errorCategory,
          errorCode: classified.code,
        },
      });
      onEvent({
        type: "error",
        conversationId: ctx.conversationId,
        code: classified.code,
        message: classified.userMessage,
        errorCategory: classified.errorCategory,
      });
      onEvent(buildConversationErrorMessage(ctx.conversationId, classified));
    }
  } finally {
    if (turnStarted) {
      cleanupBootstrapAfterTurnThreshold(ctx.conversationId);

      ctx.turnCount++;
      const config = getConfig();
      const maxWait = config.workspaceGit?.turnCommitMaxWaitMs ?? 4000;
      const deadlineMs = Date.now() + maxWait;
      const commitTurnChangesFn = ctx.commitTurnChanges ?? commitTurnChanges;
      const commitPromise = commitTurnChangesFn(
        ctx.workingDir,
        ctx.conversationId,
        ctx.turnCount,
        undefined,
        deadlineMs,
      );
      const outcome = await raceWithTimeout(commitPromise, maxWait);
      if (outcome === "timed_out") {
        rlog.warn(
          {
            turnNumber: ctx.turnCount,
            maxWaitMs: maxWait,
            conversationId: ctx.conversationId,
          },
          "Turn-boundary commit timed out — continuing without waiting (commit still runs in background)",
        );
      }

      // Commit app changes (fire-and-forget — apps repo is separate from workspace)
      void commitAppTurnChanges(ctx.conversationId, ctx.turnCount);

      // Recompute relationship-state.json at turn boundary (fire-and-forget).
      // The writer swallows its own errors, but we still guard with catch()
      // here so a regression in the writer can never bubble out of the
      // agent loop and reject an otherwise-complete turn.
      void writeRelationshipState().catch(() => {});
    }

    ctx.profiler.emitSummary(ctx.traceEmitter, reqId);

    ctx.abortController = null;
    ctx.processing = false;
    ctx.onConfirmationOutcome = undefined;
    ctx.surfaceActionRequestIds.delete(ctx.currentRequestId ?? "");
    ctx.approvedViaPromptThisTurn = false;
    ctx.currentRequestId = undefined;
    ctx.currentActiveSurfaceId = undefined;
    ctx.allowedToolNames = undefined;
    ctx.diskPressureCleanupModeActive = false;
    ctx.preactivatedSkillIds = undefined;
    ctx.currentTurnOverrideProfile = undefined;
    ctx.slackRuntimeContextNotice = undefined;
    // Channel command intents (e.g. Telegram /start) are single-turn metadata.
    // Clear at turn end so they never leak into subsequent unrelated messages.
    ctx.commandIntent = undefined;
    // taskRunId scopes ephemeral task-run permissions to a single turn. Clear
    // before drainQueue so queued/drained turns on a reused conversation can't
    // inherit stale in-task-run scope from the turn that just finished.
    ctx.taskRunId = undefined;

    // Consolidation deferred to compaction: keeping assistant + tool_result
    // messages unconsolidated preserves the exact message structure sent to
    // the API, enabling stable prefix caching across turns.  Compaction
    // consolidates when it summarizes old messages (cache miss is expected).

    ctx.drainQueue(yieldedForHandoff ? "checkpoint_handoff" : "loop_complete");

    // Clear conversation tags so they don't leak into unrelated error captures
    // (e.g. unhandledRejection from a different async chain).
    clearSentryConversationContext();
  }
}

// ── Helper ───────────────────────────────────────────────────────────

function emitUsage(
  ctx: Pick<
    AgentLoopConversationContext,
    "conversationId" | "provider" | "usageStats"
  >,
  inputTokens: number,
  outputTokens: number,
  model: string,
  onEvent: (msg: ServerMessage) => void,
  actor: UsageActor,
  requestId: string | null = null,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0,
  rawResponse?: unknown,
  providerName?: string,
  llmCallCount = 1,
  contextWindow?: { tokens: number; maxTokens: number },
  attribution?: {
    callSite: LLMCallSite | null;
    overrideProfile?: string | null;
  },
): void {
  recordUsage(
    {
      conversationId: ctx.conversationId,
      providerName: providerName ?? ctx.provider.name,
      usageStats: ctx.usageStats,
    },
    inputTokens,
    outputTokens,
    model,
    onEvent,
    actor,
    requestId,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    rawResponse,
    llmCallCount,
    contextWindow,
    attribution,
  );
}

/**
 * Minimal context shape consumed by `applyCompactionResult`. Both
 * `AgentLoopConversationContext` and `Conversation` satisfy this via structural
 * typing, so the helper can back both the 5 agent-loop auto-compaction sites
 * and the single `forceCompact` user-initiated site.
 */
export interface CompactionApplyContext {
  readonly conversationId: string;
  messages: Message[];
  contextCompactedMessageCount: number;
  contextCompactedAt: number | null;
  readonly graphMemory: ConversationGraphMemory;
  readonly provider: Provider;
  usageStats: UsageStats;
  trustContext?: TrustContext;
}

/**
 * Applies a successful `ContextWindowResult` to a conversation: updates the
 * in-memory message buffer and compaction counters, notifies the graph memory
 * and conversation-summary store, enqueues auto-analysis, emits the
 * `context_compacted` event, and records a `context_compactor` usage event.
 *
 * The emitted `usage_update` intentionally omits `contextWindow` — the
 * `context_compacted` event already carries the fresh
 * `estimatedInputTokens` / `maxInputTokens` and is the single source of
 * truth for the UI indicator after compaction. Emitting both caused a
 * redundant SwiftUI invalidation on every compaction.
 */
export async function applyCompactionResult(
  ctx: CompactionApplyContext,
  result: {
    messages: Message[];
    compactedPersistedMessages: number;
    previousEstimatedInputTokens: number;
    estimatedInputTokens: number;
    maxInputTokens: number;
    thresholdTokens: number;
    compactedMessages: number;
    summaryCalls: number;
    summaryInputTokens: number;
    summaryOutputTokens: number;
    summaryModel: string;
    summaryText: string;
    summaryCacheCreationInputTokens?: number;
    summaryCacheReadInputTokens?: number;
    summaryRawResponses?: unknown[];
    summaryCallSite?: LLMCallSite;
    summaryOverrideProfile?: string | null;
  },
  onEvent: (msg: ServerMessage) => void,
  reqId: string | null,
  options: {
    slackContextCompactionWatermarkTs?: string | null;
  } = {},
): Promise<void> {
  ctx.messages = result.messages;
  ctx.contextCompactedMessageCount += result.compactedPersistedMessages;
  const compactedAt = Date.now();
  ctx.contextCompactedAt = compactedAt;
  await ctx.graphMemory.onCompacted(result.compactedPersistedMessages);
  updateConversationContextWindow(
    ctx.conversationId,
    result.summaryText,
    ctx.contextCompactedMessageCount,
  );
  if (options.slackContextCompactionWatermarkTs) {
    updateConversationSlackContextWatermark(
      ctx.conversationId,
      options.slackContextCompactionWatermarkTs,
      compactedAt,
    );
  }
  enqueueAutoAnalysisOnCompaction(
    ctx.conversationId,
    ctx.trustContext?.trustClass,
  );
  const summarySignals = computeSummaryQualitySignals(result.summaryText);
  onEvent({
    type: "context_compacted",
    conversationId: ctx.conversationId,
    previousEstimatedInputTokens: result.previousEstimatedInputTokens,
    estimatedInputTokens: result.estimatedInputTokens,
    maxInputTokens: result.maxInputTokens,
    thresholdTokens: result.thresholdTokens,
    compactedMessages: result.compactedMessages,
    summaryCalls: result.summaryCalls,
    summaryInputTokens: result.summaryInputTokens,
    summaryOutputTokens: result.summaryOutputTokens,
    summaryModel: result.summaryModel,
    summaryCharCount: summarySignals.charCount,
    summaryHeaderCount: summarySignals.headerCount,
    summaryHadMemoryEcho: summarySignals.hadMemoryEcho,
  });
  emitUsage(
    ctx,
    result.summaryInputTokens,
    result.summaryOutputTokens,
    result.summaryModel,
    onEvent,
    "context_compactor",
    reqId,
    result.summaryCacheCreationInputTokens ?? 0,
    result.summaryCacheReadInputTokens ?? 0,
    collapseRawResponses(result.summaryRawResponses),
    undefined /* providerName */,
    1 /* llmCallCount */,
    undefined /* contextWindow */,
    {
      callSite: result.summaryCallSite ?? null,
      overrideProfile: result.summaryOverrideProfile ?? null,
    },
  );
}

function collapseRawResponses(rawResponses?: unknown[]): unknown | undefined {
  if (!rawResponses || rawResponses.length === 0) return undefined;
  return rawResponses.length === 1 ? rawResponses[0] : rawResponses;
}

/**
 * Matches any runtime-injection tag that should never appear inside a
 * generated summary. If the regex hits, either the compaction strip logic
 * failed to drop an injected block from the summarizer input, or the
 * summarizer invented tag-like text on its own — both are quality bugs
 * worth surfacing via telemetry.
 */
const SUMMARY_MEMORY_ECHO_PATTERN =
  /<(?:memory|memory_context|memory_image|turn_context|workspace|workspace_top_level|knowledge_base|pkb|system_reminder|now_scratchpad|NOW\.md|active_thread|active_subagents|active_workspace|active_dynamic_page|channel_capabilities|transport_hints|system_notice|non_interactive_context|temporal_context|guardian_context|inbound_actor_context|channel_turn_context|interface_turn_context|channel_command_context|voice_call_control)\b/i;

/**
 * Compute light-weight quality signals for a compaction summary. Emitted
 * on every `context_compacted` event so regressions (short outputs,
 * header collapse, memory-injection leakage) are visible without having
 * to read the summary text from the DB.
 */
export function computeSummaryQualitySignals(summaryText: string): {
  charCount: number;
  headerCount: number;
  hadMemoryEcho: boolean;
} {
  const charCount = summaryText.length;
  const headerCount = (summaryText.match(/^## /gm) ?? []).length;
  const hadMemoryEcho = SUMMARY_MEMORY_ECHO_PATTERN.test(summaryText);
  return { charCount, headerCount, hadMemoryEcho };
}
