/**
 * Agent loop execution extracted from Conversation.runAgentLoop.
 *
 * This module contains the core agent loop orchestration: pre-flight
 * setup, event handling, retry logic, history reconstruction, and
 * completion event emission.  The Conversation class delegates its
 * runAgentLoop method here via the AgentLoopConversationContext interface.
 */

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
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import { postTurnTruncateToolResults, derefToolResultReReads } from "../context/post-turn-tool-result-truncation.js";
import { estimatePromptTokens } from "../context/token-estimator.js";
import type { ContextWindowManager } from "../context/window-manager.js";
import type { ToolProfiler } from "../events/tool-profiling-listener.js";
import { getHookManager } from "../hooks/manager.js";
import {
  clearSentryConversationContext,
  setSentryConversationContext,
} from "../instrument.js";
import { commitAppTurnChanges } from "../memory/app-git-service.js";
import { getApp, listAppFiles, resolveAppDir } from "../memory/app-store.js";
import {
  addMessage,
  deleteMessageById,
  getConversation,
  getConversationOriginChannel,
  getConversationOriginInterface,
  provenanceFromTrustContext,
  updateConversationContextWindow,
  updateConversationTitle,
  updateMessageMetadata,
} from "../memory/conversation-crud.js";
import { getResolvedConversationDirPath } from "../memory/conversation-directories.js";
import { syncMessageToDisk } from "../memory/conversation-disk-view.js";
import {
  isReplaceableTitle,
  queueGenerateConversationTitle,
  queueRegenerateConversationTitle,
  UNTITLED_FALLBACK,
} from "../memory/conversation-title-service.js";
import type { ConversationGraphMemory } from "../memory/graph/conversation-graph-memory.js";
import { recordMemoryRecallLog } from "../memory/memory-recall-log-store.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { ContentBlock, Message } from "../providers/types.js";
import type { Provider } from "../providers/types.js";
import { resolveActorTrust } from "../runtime/actor-trust-resolver.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getSubagentManager } from "../subagent/index.js";
import type { UsageActor } from "../usage/actors.js";
import { getLogger } from "../util/logger.js";
import { truncate } from "../util/truncate.js";
import { getWorkspaceGitService } from "../workspace/git-service.js";
import { commitTurnChanges } from "../workspace/turn-commit.js";
import {
  type AssistantAttachmentDraft,
  cleanAssistantContent,
} from "./assistant-attachments.js";
import { requestCompressionApproval } from "./context-overflow-approval.js";
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
  TrustContext,
} from "./conversation-runtime-assembly.js";
import {
  applyRuntimeInjections,
  buildSubagentStatusBlock,
  buildUnifiedTurnContextBlock,
  findLastInjectedNowContent,
  inboundActorContextFromTrust,
  inboundActorContextFromTrustContext,
  readNowScratchpad,
  readPkbContext,
  stripInjectionsForCompaction,
} from "./conversation-runtime-assembly.js";
import type { SkillProjectionCache } from "./conversation-skill-tools.js";
import { markSurfaceCompleted } from "./conversation-surfaces.js";
import { resolveTrustClass } from "./conversation-tool-setup.js";
import { recordUsage } from "./conversation-usage.js";
import { formatTurnTimestamp } from "./date-context.js";
import { deepRepairHistory, repairHistory } from "./history-repair.js";
import type {
  DynamicPageSurfaceData,
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UsageStats,
} from "./message-protocol.js";
import type { MemoryRecalled } from "./message-types/memory.js";
import type { TraceEmitter } from "./trace-emitter.js";

const log = getLogger("conversation-agent-loop");

/**
 * Parse the actual token count reported by the provider in a context-too-large
 * error message. Providers typically include the prompt size, e.g.:
 *   "prompt is too long: 242201 tokens > 200000 maximum"
 *   "too many input tokens: 242201 > 200000"
 *
 * Returns the actual token count or null if it cannot be parsed.
 */
export function parseActualTokensFromError(
  errorMessage: string | null,
): number | null {
  if (!errorMessage) return null;

  // Match patterns like "242201 tokens > 200000" or "242201 > 200000 maximum"
  const match = errorMessage.match(
    /(\d[\d,]*)\s*tokens?\s*[>≥]|:\s*(\d[\d,]*)\s*[>≥]/i,
  );
  if (match) {
    const raw = (match[1] || match[2]).replace(/,/g, "");
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  // Fallback: match "too many input tokens: N > M"
  const fallback = errorMessage.match(/(\d[\d,]*)\s*[>≥]\s*\d/);
  if (fallback) {
    const raw = fallback[1].replace(/,/g, "");
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  return null;
}

/** Title-cased friendly labels for tool names, used in confirmation chips. */
const TOOL_FRIENDLY_LABEL: Record<string, string> = {
  bash: "Run Command",
  web_search: "Web Search",
  web_fetch: "Web Fetch",
  file_read: "Read File",
  file_write: "Write File",
  file_edit: "Edit File",
  browser_navigate: "Browser",
  browser_click: "Browser",
  browser_type: "Browser",
  browser_screenshot: "Browser",
  browser_scroll: "Browser",
  browser_wait: "Browser",
  app_create: "Create App",
  app_refresh: "Refresh App",
  skill_load: "Load Skill",
  skill_execute: "Run Skill Tool",
};

type GitServiceInitializer = {
  ensureInitialized(): Promise<void>;
};

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

  readonly memoryPolicy: { scopeId: string; includeDefaultFallback: boolean };
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
  currentTurnSurfaces: Array<{
    surfaceId: string;
    surfaceType: SurfaceType;
    title?: string;
    data: SurfaceData;
    actions?: Array<{ id: string; label: string; style?: string }>;
    display?: string;
  }>;

  workingDir: string;
  workspaceTopLevelContext: string | null;
  workspaceTopLevelDirty: boolean;
  channelCapabilities?: ChannelCapabilities;
  /** Per-turn snapshot of trustContext, frozen at message-processing start. */
  currentTurnTrustContext?: TrustContext;
  /** Per-turn snapshot of channelCapabilities, frozen at message-processing start. */
  currentTurnChannelCapabilities?: ChannelCapabilities;
  commandIntent?: { type: string; payload?: string; languageCode?: string };
  trustContext?: TrustContext;
  assistantId?: string;
  voiceCallControlPrompt?: string;
  transportHints?: string[];

  readonly coreToolNames: Set<string>;
  allowedToolNames?: Set<string>;
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
    params: import("./message-types/messages.js").ConfirmationStateChanged extends {
      type: infer _;
    }
      ? Omit<
          import("./message-types/messages.js").ConfirmationStateChanged,
          "type"
        >
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
    skipPreMessageRollback?: boolean;
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
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
      userMessageInterface: "vellum" as InterfaceId,
      assistantMessageInterface: "vellum" as InterfaceId,
    };
  })();

  ctx.lastAssistantAttachments = [];
  ctx.lastAttachmentWarnings = [];

  // Ensure workspace git repo is initialized before any tools run.
  try {
    const getWorkspaceGitServiceFn =
      ctx.getWorkspaceGitService ?? getWorkspaceGitService;
    const gitService = getWorkspaceGitServiceFn(ctx.workingDir);
    await gitService.ensureInitialized();
  } catch (err) {
    rlog.warn({ err }, "Failed to initialize workspace git repo (non-fatal)");
  }

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

    const preMessageResult = await getHookManager().trigger("pre-message", {
      conversationId: ctx.conversationId,
      messagePreview: truncate(content, 200, ""),
    });

    if (preMessageResult.blocked) {
      if (!options?.skipPreMessageRollback) {
        ctx.messages.pop();
        deleteMessageById(userMessageId);
      }
      // Replace loading placeholder so the conversation isn't stuck as "Generating title..."
      const currentConv = getConversation(ctx.conversationId);
      if (
        isReplaceableTitle(currentConv?.title ?? null) &&
        currentConv?.title !== UNTITLED_FALLBACK
      ) {
        updateConversationTitle(ctx.conversationId, UNTITLED_FALLBACK);
        onEvent({
          type: "conversation_title_updated",
          conversationId: ctx.conversationId,
          title: UNTITLED_FALLBACK,
        });
      }
      onEvent({
        type: "error",
        message: `Message blocked by hook "${preMessageResult.blockedBy}"`,
      });
      return;
    }

    // Generate title early — the user message alone is sufficient context.
    // Firing after hook gating but before the main LLM call removes the
    // delay of waiting for the full assistant response. The second-pass
    // regeneration at turn 3 will refine the title with more context.
    // No abort signal — title generation should complete even if the user
    // cancels the response, since the user message is already persisted.
    // Deferred via setTimeout so the main agent loop LLM call enqueues
    // first, avoiding rate-limit slot contention on strict configs.
    if (
      isReplaceableTitle(getConversation(ctx.conversationId)?.title ?? null)
    ) {
      setTimeout(() => {
        queueGenerateConversationTitle({
          conversationId: ctx.conversationId,
          provider: ctx.provider,
          userMessage: options?.titleText ?? content,
          onTitleUpdated: (title) => {
            onEvent({
              type: "conversation_title_updated",
              conversationId: ctx.conversationId,
              title,
            });
          },
        });
      }, 0);
    }

    const isFirstMessage = ctx.messages.length === 1;
    let shouldInjectWorkspace = isFirstMessage;
    let compactedThisTurn = false;

    const compactCheck = ctx.contextWindowManager.shouldCompact(ctx.messages);
    if (compactCheck.needed) {
      ctx.emitActivityState(
        "thinking",
        "context_compacting",
        "assistant_turn",
        reqId,
      );
    }
    const compacted = await ctx.contextWindowManager.maybeCompact(
      ctx.messages,
      abortController.signal,
      {
        lastCompactedAt: ctx.contextCompactedAt ?? undefined,
        precomputedEstimate: compactCheck.estimatedTokens,
      },
    );
    if (compacted.compacted) {
      ctx.messages = compacted.messages;
      ctx.contextCompactedMessageCount += compacted.compactedPersistedMessages;
      ctx.contextCompactedAt = Date.now();
      // Notify memory graph that compaction happened — triggers full context
      // reload on the next turn to replenish lost memory context.
      ctx.graphMemory.onCompacted(compacted.compactedPersistedMessages);
      updateConversationContextWindow(
        ctx.conversationId,
        compacted.summaryText,
        ctx.contextCompactedMessageCount,
      );
      onEvent({
        type: "context_compacted",
        previousEstimatedInputTokens: compacted.previousEstimatedInputTokens,
        estimatedInputTokens: compacted.estimatedInputTokens,
        maxInputTokens: compacted.maxInputTokens,
        thresholdTokens: compacted.thresholdTokens,
        compactedMessages: compacted.compactedMessages,
        summaryCalls: compacted.summaryCalls,
        summaryInputTokens: compacted.summaryInputTokens,
        summaryOutputTokens: compacted.summaryOutputTokens,
        summaryModel: compacted.summaryModel,
      });
      emitUsage(
        ctx,
        compacted.summaryInputTokens,
        compacted.summaryOutputTokens,
        compacted.summaryModel,
        onEvent,
        "context_compactor",
        reqId,
        compacted.summaryCacheCreationInputTokens ?? 0,
        compacted.summaryCacheReadInputTokens ?? 0,
        collapseRawResponses(compacted.summaryRawResponses),
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

    // Memory graph retrieval — dispatches to context-load / per-turn based on
    // conversation state.
    const isTrustedActor = resolveTrustClass(ctx.trustContext) === "guardian";
    if (isTrustedActor) {
      const graphResult = await ctx.graphMemory.prepareMemory(
        ctx.messages,
        getConfig(),
        abortController.signal,
        onEvent,
      );
      runMessages = graphResult.runMessages;

      // Persist the injected block text in message metadata so it survives
      // conversation reloads (eviction, restart, fork). loadFromDb re-injects
      // from metadata.
      if (graphResult.injectedBlockText) {
        try {
          updateMessageMetadata(userMessageId, {
            memoryInjectedBlock: graphResult.injectedBlockText,
          });
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
    // date semantics prefer configured user timezone, then recalled memory.
    const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const configuredUserTimeZone = getConfig().ui.userTimezone ?? null;
    const recalledUserTimeZone = null;
    const timestamp = formatTurnTimestamp({
      hostTimeZone,
      configuredUserTimeZone,
      userTimeZone: recalledUserTimeZone,
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
    const unifiedTurnContextStr = buildUnifiedTurnContextBlock(
      isGuardian
        ? { timestamp, interfaceName, channelName }
        : {
            timestamp,
            interfaceName,
            channelName,
            actorContext: resolvedInboundActorContext,
          },
    );

    // The `remember` tool handles scratchpad-style memory writes directly to the graph.

    const isInteractiveResolved =
      options?.isInteractive ?? (!ctx.hasNoClient && !ctx.headlessLock);

    // Inject NOW.md and PKB content only on the first turn (or after
    // compaction re-strips them).  Old injections persist in history and
    // are never stripped on normal turns — this preserves the cached prefix.
    const currentNowContent = readNowScratchpad();
    const shouldInjectNowAndPkb = isFirstMessage || compactedThisTurn;
    const nowScratchpad = shouldInjectNowAndPkb ? currentNowContent : null;

    const currentPkbContent = readPkbContext();
    const pkbContext = shouldInjectNowAndPkb ? currentPkbContent : null;
    const pkbActive = currentPkbContent !== null;

    // Subagent status injection — gives the parent LLM visibility into active/completed children.
    // Skipped when this conversation IS a subagent (no nesting) or has no children.
    const subagentStatusBlock = ctx.isSubagent
      ? null
      : buildSubagentStatusBlock(
          getSubagentManager().getChildrenOf(ctx.conversationId),
        );

    // Shared injection options — reused whenever we need to re-inject after reduction.
    const injectionOpts = {
      activeSurface,
      workspaceTopLevelContext: shouldInjectWorkspace
        ? ctx.workspaceTopLevelContext
        : null,
      channelCapabilities: ctx.channelCapabilities ?? null,
      channelCommandContext: ctx.commandIntent ?? null,
      unifiedTurnContext: unifiedTurnContextStr,
      pkbContext,
      pkbActive,
      nowScratchpad,
      voiceCallControlPrompt: ctx.voiceCallControlPrompt ?? null,
      transportHints: ctx.transportHints ?? null,
      isNonInteractive: !isInteractiveResolved,
      subagentStatusBlock,
    } as const;

    let currentInjectionMode: InjectionMode = "full";

    runMessages = applyRuntimeInjections(runMessages, {
      ...injectionOpts,
      mode: currentInjectionMode,
    });

    // ── Preflight budget evaluation ──────────────────────────────
    // After runtime injections are applied, estimate the prompt token count
    // and proactively invoke the reducer if already above budget. This avoids
    // a wasted provider round-trip that would just fail with context_too_large.
    const config = getConfig();
    const overflowRecovery = config.contextWindow.overflowRecovery;
    const providerMaxTokens = config.contextWindow.maxInputTokens;
    // Widen safety margin for large conversations where estimation error
    // compounds across many messages with tool results.
    const baseSafetyMargin = overflowRecovery.safetyMarginRatio;
    const messageCount = ctx.messages.length;
    const safetyMargin =
      messageCount > 50 ? Math.max(baseSafetyMargin, 0.15) : baseSafetyMargin;
    const preflightBudget = Math.floor(providerMaxTokens * (1 - safetyMargin));
    let reducerState: ReducerState | undefined;

    const toolTokenBudget = ctx.agentLoop.getToolTokenBudget(runMessages);
    const preflightTokens = estimatePromptTokens(
      runMessages,
      ctx.systemPrompt,
      { providerName: ctx.provider.name, toolTokenBudget },
    );

    if (overflowRecovery.enabled && preflightTokens > preflightBudget) {
      rlog.warn(
        {
          phase: "preflight",
          estimatedTokens: preflightTokens,
          budget: preflightBudget,
        },
        "Preflight budget exceeded — running overflow reducer before provider call",
      );

      reducerState = createInitialReducerState();
      let preflightAttempts = 0;

      while (
        preflightAttempts < overflowRecovery.maxAttempts &&
        !reducerState.exhausted
      ) {
        preflightAttempts++;
        ctx.emitActivityState(
          "thinking",
          "context_compacting",
          "assistant_turn",
          reqId,
        );
        const step = await reduceContextOverflow(
          ctx.messages,
          {
            providerName: ctx.provider.name,
            systemPrompt: ctx.systemPrompt,
            contextWindow: config.contextWindow,
            targetTokens: preflightBudget,
            toolTokenBudget,
          },
          reducerState,
          (msgs, signal, opts) =>
            ctx.contextWindowManager.maybeCompact(msgs, signal!, opts),
          abortController.signal,
        );

        reducerState = step.state;
        ctx.messages = step.messages;
        currentInjectionMode = step.state.injectionMode;

        if (step.compactionResult?.compacted) {
          ctx.contextCompactedMessageCount +=
            step.compactionResult.compactedPersistedMessages;
          ctx.contextCompactedAt = Date.now();
          updateConversationContextWindow(
            ctx.conversationId,
            step.compactionResult.summaryText,
            ctx.contextCompactedMessageCount,
          );
          onEvent({
            type: "context_compacted",
            previousEstimatedInputTokens:
              step.compactionResult.previousEstimatedInputTokens,
            estimatedInputTokens: step.compactionResult.estimatedInputTokens,
            maxInputTokens: step.compactionResult.maxInputTokens,
            thresholdTokens: step.compactionResult.thresholdTokens,
            compactedMessages: step.compactionResult.compactedMessages,
            summaryCalls: step.compactionResult.summaryCalls,
            summaryInputTokens: step.compactionResult.summaryInputTokens,
            summaryOutputTokens: step.compactionResult.summaryOutputTokens,
            summaryModel: step.compactionResult.summaryModel,
          });
          emitUsage(
            ctx,
            step.compactionResult.summaryInputTokens,
            step.compactionResult.summaryOutputTokens,
            step.compactionResult.summaryModel,
            onEvent,
            "context_compactor",
            reqId,
            step.compactionResult.summaryCacheCreationInputTokens ?? 0,
            step.compactionResult.summaryCacheReadInputTokens ?? 0,
            collapseRawResponses(step.compactionResult.summaryRawResponses),
          );
          ctx.graphMemory.onCompacted(
            step.compactionResult.compactedPersistedMessages,
          );
          shouldInjectWorkspace = true;
        }

        // Re-inject with potentially downgraded injection mode.
        // When compaction ran it strips existing NOW.md / PKB blocks, so we
        // must re-inject the current content. Otherwise rely on the deduplicated
        // value from injectionOpts to avoid duplicate injection.
        runMessages = applyRuntimeInjections(ctx.messages, {
          ...injectionOpts,
          ...(step.compactionResult?.compacted && { pkbContext: currentPkbContent }),
          ...(step.compactionResult?.compacted && { nowScratchpad: currentNowContent }),
          workspaceTopLevelContext: shouldInjectWorkspace
            ? ctx.workspaceTopLevelContext
            : null,
          mode: currentInjectionMode,
        });
        if (isTrustedActor && currentInjectionMode !== "minimal") {
          const memResult = ctx.graphMemory.reinjectCachedMemory(runMessages);
          runMessages = memResult.runMessages;
        }

        // Re-estimate with injections included — step.estimatedTokens was
        // computed on bare history (ctx.messages) and doesn't account for
        // tokens added by runtime injections.
        const postInjectionTokens = estimatePromptTokens(
          runMessages,
          ctx.systemPrompt,
          { providerName: ctx.provider.name, toolTokenBudget },
        );

        if (postInjectionTokens <= preflightBudget) break;
      }
    }

    // Pre-run repair
    let preRepairMessages = runMessages;
    const preRunRepair = repairHistory(runMessages);
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
      runMessages = preRunRepair.messages;
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

    const onCheckpoint = (checkpoint: CheckpointInfo): CheckpointDecision => {
      const turnTools = state.currentTurnToolNames;
      state.currentTurnToolNames = [];

      if (ctx.canHandoffAtCheckpoint()) {
        const inBrowserFlow =
          turnTools.length > 0 &&
          turnTools.every((n) => n.startsWith("browser_"));
        if (!inBrowserFlow) {
          yieldedForHandoff = true;
          return "yield";
        }
      }

      // Mid-loop token budget check: estimate current context size and
      // yield if we're approaching the preflight budget. This lets the
      // conversation-agent-loop run compaction before the provider rejects.
      if (overflowRecovery.enabled) {
        const midLoopThreshold = preflightBudget * 0.85;
        const estimated = estimatePromptTokens(
          checkpoint.history,
          ctx.systemPrompt,
          { providerName: ctx.provider.name, toolTokenBudget },
        );
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

    let denyCompressionMessage: Message | null = null;

    let updatedHistory = await ctx.agentLoop.run(
      runMessages,
      eventHandler,
      abortController.signal,
      reqId,
      onCheckpoint,
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

      ctx.emitActivityState(
        "thinking",
        "context_compacting",
        "assistant_turn",
        reqId,
        "Compacting context",
      );
      const midLoopCompact = await ctx.contextWindowManager.maybeCompact(
        ctx.messages,
        abortController.signal,
        {
          lastCompactedAt: ctx.contextCompactedAt ?? undefined,
          force: true,
          targetInputTokensOverride: preflightBudget,
        },
      );
      if (midLoopCompact.compacted) {
        ctx.messages = midLoopCompact.messages;
        ctx.contextCompactedMessageCount +=
          midLoopCompact.compactedPersistedMessages;
        ctx.contextCompactedAt = Date.now();
        updateConversationContextWindow(
          ctx.conversationId,
          midLoopCompact.summaryText,
          ctx.contextCompactedMessageCount,
        );
        onEvent({
          type: "context_compacted",
          previousEstimatedInputTokens:
            midLoopCompact.previousEstimatedInputTokens,
          estimatedInputTokens: midLoopCompact.estimatedInputTokens,
          maxInputTokens: midLoopCompact.maxInputTokens,
          thresholdTokens: midLoopCompact.thresholdTokens,
          compactedMessages: midLoopCompact.compactedMessages,
          summaryCalls: midLoopCompact.summaryCalls,
          summaryInputTokens: midLoopCompact.summaryInputTokens,
          summaryOutputTokens: midLoopCompact.summaryOutputTokens,
          summaryModel: midLoopCompact.summaryModel,
        });
        emitUsage(
          ctx,
          midLoopCompact.summaryInputTokens,
          midLoopCompact.summaryOutputTokens,
          midLoopCompact.summaryModel,
          onEvent,
          "context_compactor",
          reqId,
          midLoopCompact.summaryCacheCreationInputTokens ?? 0,
          midLoopCompact.summaryCacheReadInputTokens ?? 0,
          collapseRawResponses(midLoopCompact.summaryRawResponses),
        );
        ctx.graphMemory.onCompacted(midLoopCompact.compactedPersistedMessages);
        shouldInjectWorkspace = true;
      }

      // Re-inject runtime context and re-enter the agent loop.
      // stripInjectionsForCompaction() unconditionally removed the existing
      // NOW.md block from ctx.messages above, so we must always re-inject
      // the current content regardless of whether compaction actually ran.
      runMessages = applyRuntimeInjections(ctx.messages, {
        ...injectionOpts,
        pkbContext: currentPkbContent,
        nowScratchpad: currentNowContent,
        workspaceTopLevelContext: shouldInjectWorkspace
          ? ctx.workspaceTopLevelContext
          : null,
        mode: currentInjectionMode,
      });
      if (isTrustedActor && currentInjectionMode !== "minimal") {
        const memResult = ctx.graphMemory.reinjectCachedMemory(runMessages);
        runMessages = memResult.runMessages;
      }
      preRepairMessages = runMessages;
      preRunHistoryLength = runMessages.length;

      updatedHistory = await ctx.agentLoop.run(
        runMessages,
        eventHandler,
        abortController.signal,
        reqId,
        onCheckpoint,
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
      const retryRepair = deepRepairHistory(runMessages);
      runMessages = retryRepair.messages;
      preRepairMessages = retryRepair.messages;
      preRunHistoryLength = runMessages.length;
      state.orderingErrorDetected = false;
      state.deferredOrderingError = null;

      updatedHistory = await ctx.agentLoop.run(
        runMessages,
        eventHandler,
        abortController.signal,
        reqId,
        onCheckpoint,
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
    // stubbing, injection downgrade) with optional approval gating for
    // interactive latest-turn compression.
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
      // uncorrected preflightBudget would still be too high.
      const actualTokens = parseActualTokensFromError(
        state.contextTooLargeErrorMessage,
      );
      const estimatedTokensAtOverflow = estimatePromptTokens(
        ctx.messages,
        ctx.systemPrompt,
        { providerName: ctx.provider.name, toolTokenBudget },
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
        const step = await reduceContextOverflow(
          ctx.messages,
          {
            providerName: ctx.provider.name,
            systemPrompt: ctx.systemPrompt,
            contextWindow: config.contextWindow,
            targetTokens: correctedTarget,
            toolTokenBudget,
          },
          reducerState,
          (msgs, signal, opts) =>
            ctx.contextWindowManager.maybeCompact(msgs, signal!, opts),
          abortController.signal,
        );

        reducerState = step.state;
        ctx.messages = step.messages;
        currentInjectionMode = step.state.injectionMode;

        if (step.compactionResult?.compacted) {
          ctx.contextCompactedMessageCount +=
            step.compactionResult.compactedPersistedMessages;
          ctx.contextCompactedAt = Date.now();
          updateConversationContextWindow(
            ctx.conversationId,
            step.compactionResult.summaryText,
            ctx.contextCompactedMessageCount,
          );
          onEvent({
            type: "context_compacted",
            previousEstimatedInputTokens:
              step.compactionResult.previousEstimatedInputTokens,
            estimatedInputTokens: step.compactionResult.estimatedInputTokens,
            maxInputTokens: step.compactionResult.maxInputTokens,
            thresholdTokens: step.compactionResult.thresholdTokens,
            compactedMessages: step.compactionResult.compactedMessages,
            summaryCalls: step.compactionResult.summaryCalls,
            summaryInputTokens: step.compactionResult.summaryInputTokens,
            summaryOutputTokens: step.compactionResult.summaryOutputTokens,
            summaryModel: step.compactionResult.summaryModel,
          });
          emitUsage(
            ctx,
            step.compactionResult.summaryInputTokens,
            step.compactionResult.summaryOutputTokens,
            step.compactionResult.summaryModel,
            onEvent,
            "context_compactor",
            reqId,
            step.compactionResult.summaryCacheCreationInputTokens ?? 0,
            step.compactionResult.summaryCacheReadInputTokens ?? 0,
            collapseRawResponses(step.compactionResult.summaryRawResponses),
          );
          ctx.graphMemory.onCompacted(
            step.compactionResult.compactedPersistedMessages,
          );
          shouldInjectWorkspace = true;
        }

        // Only re-inject NOW.md when ctx.messages was actually stripped;
        // otherwise the existing NOW.md block is still present and
        // re-injecting would duplicate it.
        runMessages = applyRuntimeInjections(ctx.messages, {
          ...injectionOpts,
          pkbContext: currentPkbContent,
          nowScratchpad: convergenceStripped ? currentNowContent : null,
          workspaceTopLevelContext: shouldInjectWorkspace
            ? ctx.workspaceTopLevelContext
            : null,
          mode: currentInjectionMode,
        });
        if (isTrustedActor && currentInjectionMode !== "minimal") {
          const memResult = ctx.graphMemory.reinjectCachedMemory(runMessages);
          runMessages = memResult.runMessages;
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
            convergenceStripped = true;
            preRepairMessages = updatedHistory;
            preRunHistoryLength = updatedHistory.length;
          }
        }
      }

      // All reducer tiers exhausted but provider still rejects —
      // consult the overflow policy for latest-turn compression.
      // Emergency compaction is deferred to the policy-gated paths below
      // so that `request_user_approval` sessions collect consent first.
      if (state.contextTooLargeDetected) {
        const action = resolveOverflowAction({
          overflowRecovery,
          isInteractive: isInteractiveResolved,
        });

        if (action === "request_user_approval") {
          const approval = await requestCompressionApproval(ctx.prompter, {
            signal: abortController.signal,
          });

          if (approval.approved) {
            // User approved — force emergency compaction with aggressive settings
            const emergencyCompact =
              await ctx.contextWindowManager.maybeCompact(
                ctx.messages,
                abortController.signal,
                {
                  lastCompactedAt: ctx.contextCompactedAt ?? undefined,
                  force: true,
                  minKeepRecentUserTurns: 0,
                  targetInputTokensOverride: correctedTarget,
                },
              );
            if (emergencyCompact.compacted) {
              ctx.messages = emergencyCompact.messages;
              ctx.contextCompactedMessageCount +=
                emergencyCompact.compactedPersistedMessages;
              ctx.contextCompactedAt = Date.now();
              updateConversationContextWindow(
                ctx.conversationId,
                emergencyCompact.summaryText,
                ctx.contextCompactedMessageCount,
              );
              onEvent({
                type: "context_compacted",
                previousEstimatedInputTokens:
                  emergencyCompact.previousEstimatedInputTokens,
                estimatedInputTokens: emergencyCompact.estimatedInputTokens,
                maxInputTokens: emergencyCompact.maxInputTokens,
                thresholdTokens: emergencyCompact.thresholdTokens,
                compactedMessages: emergencyCompact.compactedMessages,
                summaryCalls: emergencyCompact.summaryCalls,
                summaryInputTokens: emergencyCompact.summaryInputTokens,
                summaryOutputTokens: emergencyCompact.summaryOutputTokens,
                summaryModel: emergencyCompact.summaryModel,
              });
              emitUsage(
                ctx,
                emergencyCompact.summaryInputTokens,
                emergencyCompact.summaryOutputTokens,
                emergencyCompact.summaryModel,
                onEvent,
                "context_compactor",
                reqId,
                emergencyCompact.summaryCacheCreationInputTokens ?? 0,
                emergencyCompact.summaryCacheReadInputTokens ?? 0,
                collapseRawResponses(emergencyCompact.summaryRawResponses),
              );
              ctx.graphMemory.onCompacted(
                emergencyCompact.compactedPersistedMessages,
              );
              shouldInjectWorkspace = true;
            }

            // Only re-inject NOW.md when ctx.messages was actually stripped;
            // otherwise the existing block is still present.
            runMessages = applyRuntimeInjections(ctx.messages, {
              ...injectionOpts,
              pkbContext: currentPkbContent,
              nowScratchpad: convergenceStripped ? currentNowContent : null,
              workspaceTopLevelContext: shouldInjectWorkspace
                ? ctx.workspaceTopLevelContext
                : null,
              mode: currentInjectionMode,
            });
            if (isTrustedActor && currentInjectionMode !== "minimal") {
              const memResult =
                ctx.graphMemory.reinjectCachedMemory(runMessages);
              runMessages = memResult.runMessages;
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
            );
          } else {
            // User denied compression — emit a graceful assistant explanation
            // instead of a conversation_error, and end the turn cleanly.
            state.contextTooLargeDetected = false;
            const denyText =
              "The conversation has grown too long for the model to process, " +
              "and compression was declined. Please start a new conversation " +
              "or manually shorten the conversation to continue.";
            const loopChannelMeta = {
              ...provenanceFromTrustContext(ctx.trustContext),
              userMessageChannel: capturedTurnChannelContext.userMessageChannel,
              assistantMessageChannel:
                capturedTurnChannelContext.assistantMessageChannel,
              userMessageInterface:
                capturedTurnInterfaceContext.userMessageInterface,
              assistantMessageInterface:
                capturedTurnInterfaceContext.assistantMessageInterface,
            };
            const denyMessage = createAssistantMessage(denyText);
            await addMessage(
              ctx.conversationId,
              "assistant",
              JSON.stringify(denyMessage.content),
              loopChannelMeta,
            );
            denyCompressionMessage = denyMessage;
            onEvent({
              type: "assistant_text_delta",
              text: denyText,
              conversationId: ctx.conversationId,
            });
            // Prevent the final error fallback from firing
            state.providerErrorUserMessage = null;
          }
        } else if (action === "auto_compress_latest_turn") {
          // Non-interactive — auto-compress without asking
          ctx.emitActivityState(
            "thinking",
            "context_compacting",
            "assistant_turn",
            reqId,
          );
          const emergencyCompact = await ctx.contextWindowManager.maybeCompact(
            ctx.messages,
            abortController.signal,
            {
              lastCompactedAt: ctx.contextCompactedAt ?? undefined,
              force: true,
              minKeepRecentUserTurns: 0,
              targetInputTokensOverride: correctedTarget,
            },
          );
          if (emergencyCompact.compacted) {
            ctx.messages = emergencyCompact.messages;
            ctx.contextCompactedMessageCount +=
              emergencyCompact.compactedPersistedMessages;
            ctx.contextCompactedAt = Date.now();
            updateConversationContextWindow(
              ctx.conversationId,
              emergencyCompact.summaryText,
              ctx.contextCompactedMessageCount,
            );
            onEvent({
              type: "context_compacted",
              previousEstimatedInputTokens:
                emergencyCompact.previousEstimatedInputTokens,
              estimatedInputTokens: emergencyCompact.estimatedInputTokens,
              maxInputTokens: emergencyCompact.maxInputTokens,
              thresholdTokens: emergencyCompact.thresholdTokens,
              compactedMessages: emergencyCompact.compactedMessages,
              summaryCalls: emergencyCompact.summaryCalls,
              summaryInputTokens: emergencyCompact.summaryInputTokens,
              summaryOutputTokens: emergencyCompact.summaryOutputTokens,
              summaryModel: emergencyCompact.summaryModel,
            });
            emitUsage(
              ctx,
              emergencyCompact.summaryInputTokens,
              emergencyCompact.summaryOutputTokens,
              emergencyCompact.summaryModel,
              onEvent,
              "context_compactor",
              reqId,
              emergencyCompact.summaryCacheCreationInputTokens ?? 0,
              emergencyCompact.summaryCacheReadInputTokens ?? 0,
              collapseRawResponses(emergencyCompact.summaryRawResponses),
            );
            ctx.graphMemory.onCompacted(
              emergencyCompact.compactedPersistedMessages,
            );
            shouldInjectWorkspace = true;
          }

          // Only re-inject NOW.md when ctx.messages was actually stripped;
          // otherwise the existing block is still present.
          runMessages = applyRuntimeInjections(ctx.messages, {
            ...injectionOpts,
            pkbContext: currentPkbContent,
            nowScratchpad: convergenceStripped ? currentNowContent : null,
            workspaceTopLevelContext: shouldInjectWorkspace
              ? ctx.workspaceTopLevelContext
              : null,
            mode: currentInjectionMode,
          });
          if (isTrustedActor && currentInjectionMode !== "minimal") {
            const memResult = ctx.graphMemory.reinjectCachedMemory(runMessages);
            runMessages = memResult.runMessages;
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
        content: result.content,
        is_error: result.isError,
        ...(result.contentBlocks
          ? { contentBlocks: result.contentBlocks }
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
      await addMessage(
        ctx.conversationId,
        "user",
        JSON.stringify(toolResultBlocks),
        toolResultMetadata,
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

    if (denyCompressionMessage) {
      newMessages.push(denyCompressionMessage);
    }

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
      await addMessage(
        ctx.conversationId,
        "assistant",
        JSON.stringify(errorAssistantMessage.content),
        errChannelMeta,
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
    if (isAssistantFeatureFlagEnabled("tool-result-truncation", config)) {
      const conv = getConversation(ctx.conversationId);
      if (conv) {
        const convDir = getResolvedConversationDirPath(ctx.conversationId, conv.createdAt);
        const { messages: derefMessages, dereferencedCount } = derefToolResultReReads(restoredHistory);
        const { messages: truncatedMessages, truncatedCount } = postTurnTruncateToolResults(derefMessages, { conversationDir: convDir });
        if (truncatedCount > 0 || dereferencedCount > 0) {
          rlog.info(
            { truncatedCount, dereferencedCount },
            "Post-turn tool result truncation applied",
          );
        }
        restoredHistory = truncatedMessages;
      }
    }

    const postLoopContextEstimate = estimatePromptTokens(
      restoredHistory,
      ctx.systemPrompt,
      { providerName: ctx.provider.name, toolTokenBudget },
    );

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
        tokens: postLoopContextEstimate,
        maxTokens: config.contextWindow.maxInputTokens,
      },
    );

    void getHookManager().trigger("post-message", {
      conversationId: ctx.conversationId,
    });

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
        });
      }
    }

    // Second title pass: after 3 completed turns, re-generate the title
    // using the last 3 messages for better context. Only fires when the
    // current title was auto-generated (isAutoTitle = 1).
    if (ctx.turnCount === 2) {
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
      onEvent({ type: "error", message: classified.userMessage });
      onEvent(buildConversationErrorMessage(ctx.conversationId, classified));
      void getHookManager().trigger("on-error", {
        error: err instanceof Error ? err.name : "Error",
        message,
        stack: err instanceof Error ? err.stack : undefined,
        conversationId: ctx.conversationId,
      });
    }
  } finally {
    if (turnStarted) {
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
    }

    ctx.profiler.emitSummary(ctx.traceEmitter, reqId);

    ctx.abortController = null;
    ctx.processing = false;
    ctx.onConfirmationOutcome = undefined;
    ctx.surfaceActionRequestIds.delete(ctx.currentRequestId ?? "");
    ctx.currentRequestId = undefined;
    ctx.currentActiveSurfaceId = undefined;
    ctx.allowedToolNames = undefined;
    ctx.preactivatedSkillIds = undefined;
    // Channel command intents (e.g. Telegram /start) are single-turn metadata.
    // Clear at turn end so they never leak into subsequent unrelated messages.
    ctx.commandIntent = undefined;

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
  );
}

function collapseRawResponses(rawResponses?: unknown[]): unknown | undefined {
  if (!rawResponses || rawResponses.length === 0) return undefined;
  return rawResponses.length === 1 ? rawResponses[0] : rawResponses;
}
