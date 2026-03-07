/**
 * Agent loop execution extracted from Session.runAgentLoop.
 *
 * This module contains the core agent loop orchestration: pre-flight
 * setup, event handling, retry logic, history reconstruction, and
 * completion event emission.  The Session class delegates its
 * runAgentLoop method here via the AgentLoopSessionContext interface.
 */

import { v4 as uuid } from "uuid";

import type {
  AgentEvent,
  AgentLoop,
  CheckpointDecision,
} from "../agent/loop.js";
import { createAssistantMessage } from "../agent/message-types.js";
import type {
  ChannelId,
  InterfaceId,
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { estimatePromptTokens } from "../context/token-estimator.js";
import type { ContextWindowManager } from "../context/window-manager.js";
import type { ToolProfiler } from "../events/tool-profiling-listener.js";
import { getHookManager } from "../hooks/manager.js";
import { commitAppTurnChanges } from "../memory/app-git-service.js";
import { getApp, listAppFiles } from "../memory/app-store.js";
import * as conversationStore from "../memory/conversation-store.js";
import {
  getConversationOriginChannel,
  getConversationOriginInterface,
  provenanceFromTrustContext,
} from "../memory/conversation-store.js";
import {
  isReplaceableTitle,
  queueGenerateConversationTitle,
  queueRegenerateConversationTitle,
  UNTITLED_FALLBACK,
} from "../memory/conversation-title-service.js";
import { stripMemoryRecallMessages } from "../memory/retriever.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { ContentBlock, Message } from "../providers/types.js";
import type { Provider } from "../providers/types.js";
import { resolveActorTrust } from "../runtime/actor-trust-resolver.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
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
  buildTemporalContext,
  extractUserTimeZoneFromDynamicProfile,
} from "./date-context.js";
import { deepRepairHistory, repairHistory } from "./history-repair.js";
import type {
  DynamicPageSurfaceData,
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UsageStats,
} from "./ipc-protocol.js";
import {
  createEventHandlerState,
  dispatchAgentEvent,
  type EventHandlerDeps,
} from "./session-agent-loop-handlers.js";
import {
  approveHostAttachmentRead,
  formatAttachmentWarnings,
  resolveAssistantAttachments,
} from "./session-attachments.js";
import type { ConflictGate } from "./session-conflict-gate.js";
import { stripDynamicProfileMessages } from "./session-dynamic-profile.js";
import {
  buildSessionErrorMessage,
  classifySessionError,
  isUserCancellation,
} from "./session-error.js";
import { consolidateAssistantMessages } from "./session-history.js";
import { raceWithTimeout } from "./session-media-retry.js";
import { prepareMemoryContext } from "./session-memory.js";
import type { MessageQueue } from "./session-queue-manager.js";
import type { QueueDrainReason } from "./session-queue-manager.js";
import type {
  ActiveSurfaceContext,
  ChannelCapabilities,
  ChannelTurnContextParams,
  InboundActorContext,
  InjectionMode,
  InterfaceTurnContextParams,
  TrustContext,
} from "./session-runtime-assembly.js";
import {
  applyRuntimeInjections,
  inboundActorContextFromTrust,
  inboundActorContextFromTrustContext,
  stripInjectedContext,
} from "./session-runtime-assembly.js";
import type { SkillProjectionCache } from "./session-skill-tools.js";
import { resolveTrustClass } from "./session-tool-setup.js";
import { recordUsage } from "./session-usage.js";
import type { TraceEmitter } from "./trace-emitter.js";

const log = getLogger("session-agent-loop");

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
  app_update: "Update App",
  skill_load: "Load Skill",
  app_file_edit: "Edit App File",
  app_file_write: "Write App File",
};

type GitServiceInitializer = {
  ensureInitialized(): Promise<void>;
};

// ── Context Interface ────────────────────────────────────────────────

export interface AgentLoopSessionContext {
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

  readonly conflictGate: ConflictGate;
  readonly memoryPolicy: { scopeId: string; includeDefaultFallback: boolean };

  currentActiveSurfaceId?: string;
  currentPage?: string;
  readonly surfaceState: Map<
    string,
    { surfaceType: SurfaceType; data: SurfaceData; title?: string }
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
  commandIntent?: { type: string; payload?: string; languageCode?: string };
  trustContext?: TrustContext;
  assistantId?: string;
  voiceCallControlPrompt?: string;

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
      | "tool_result_received"
      | "confirmation_requested"
      | "confirmation_resolved"
      | "message_complete"
      | "generation_cancelled"
      | "error_terminal",
    anchor?: "assistant_turn" | "user_turn" | "global",
    requestId?: string,
    statusText?: string,
  ): void;
  emitConfirmationStateChanged(
    params: import("./ipc-contract/messages.js").ConfirmationStateChanged extends {
      type: infer _;
    }
      ? Omit<
          import("./ipc-contract/messages.js").ConfirmationStateChanged,
          "type"
        >
      : never,
  ): void;

  /**
   * Optional callback invoked by the Session when a confirmation state changes.
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
  ctx: AgentLoopSessionContext,
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
          sessionId: ctx.conversationId,
          surfaceId,
          summary: "Dismissed",
        });
        ctx.pendingSurfaceActions.delete(surfaceId);
      }
    }

    const preMessageResult = await getHookManager().trigger("pre-message", {
      sessionId: ctx.conversationId,
      messagePreview: truncate(content, 200, ""),
    });

    if (preMessageResult.blocked) {
      if (!options?.skipPreMessageRollback) {
        ctx.messages.pop();
        conversationStore.deleteMessageById(userMessageId);
      }
      // Replace loading placeholder so the thread isn't stuck as "Generating title..."
      const currentConv = conversationStore.getConversation(ctx.conversationId);
      if (
        isReplaceableTitle(currentConv?.title ?? null) &&
        currentConv?.title !== UNTITLED_FALLBACK
      ) {
        conversationStore.updateConversationTitle(
          ctx.conversationId,
          UNTITLED_FALLBACK,
        );
        onEvent({
          type: "session_title_updated",
          sessionId: ctx.conversationId,
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
      isReplaceableTitle(
        conversationStore.getConversation(ctx.conversationId)?.title ?? null,
      )
    ) {
      setTimeout(() => {
        queueGenerateConversationTitle({
          conversationId: ctx.conversationId,
          provider: ctx.provider,
          userMessage: options?.titleText ?? content,
          onTitleUpdated: (title) => {
            onEvent({
              type: "session_title_updated",
              sessionId: ctx.conversationId,
              title,
            });
          },
        });
      }, 0);
    }

    const isFirstMessage = ctx.messages.length === 1;

    ctx.emitActivityState(
      "thinking",
      "thinking_delta",
      "assistant_turn",
      reqId,
      "Compacting context",
    );
    const compacted = await ctx.contextWindowManager.maybeCompact(
      ctx.messages,
      abortController.signal,
      { lastCompactedAt: ctx.contextCompactedAt ?? undefined },
    );
    if (compacted.compacted) {
      ctx.messages = compacted.messages;
      ctx.contextCompactedMessageCount += compacted.compactedPersistedMessages;
      ctx.contextCompactedAt = Date.now();
      conversationStore.updateConversationContextWindow(
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

    const memoryResult = await prepareMemoryContext(
      {
        conversationId: ctx.conversationId,
        messages: ctx.messages,
        systemPrompt: ctx.systemPrompt,
        provider: ctx.provider,
        conflictGate: ctx.conflictGate,
        scopeId: ctx.memoryPolicy.scopeId,
        includeDefaultFallback: ctx.memoryPolicy.includeDefaultFallback,
        trustClass: resolveTrustClass(ctx.trustContext),
        isInteractive:
          options?.isInteractive ?? (!ctx.hasNoClient && !ctx.headlessLock),
      },
      content,
      userMessageId,
      abortController.signal,
      onEvent,
    );

    const { recall, dynamicProfile, recallInjectionStrategy } = memoryResult;
    runMessages = memoryResult.runMessages;

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

    // Compute fresh temporal context each turn for date grounding.
    // Absolute "now" is always anchored to assistant host clock, while local
    // date semantics prefer configured user timezone, then profile memory.
    const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const userTimeZone = extractUserTimeZoneFromDynamicProfile(
      dynamicProfile.text,
    );
    const configuredUserTimeZone = getConfig().ui.userTimezone ?? null;
    const temporalContext = buildTemporalContext({
      hostTimeZone,
      configuredUserTimeZone,
      userTimeZone,
    });

    // Use the channel/interface context captured at the top of this function
    // so it reflects the channel/interface that originally sent *this* turn's
    // message, even if a newer message from a different channel arrived since.
    const channelTurnContext: ChannelTurnContextParams = {
      turnContext: capturedTurnChannelContext,
      conversationOriginChannel: getConversationOriginChannel(
        ctx.conversationId,
      ),
    };

    const interfaceTurnContext: InterfaceTurnContextParams = {
      turnContext: capturedTurnInterfaceContext,
      conversationOriginInterface: getConversationOriginInterface(
        ctx.conversationId,
      ),
    };

    // Resolve the inbound actor context for the model's <inbound_actor_context>
    // block. When the session carries enough identity info, use the unified
    // actor trust resolver so member status/policy and guardian binding details
    // are fresh for this turn. The session runtime context remains the source
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

    const isInteractiveResolved =
      options?.isInteractive ?? (!ctx.hasNoClient && !ctx.headlessLock);

    // Shared injection options — reused whenever we need to re-inject after reduction.
    const injectionOpts = {
      activeSurface,
      workspaceTopLevelContext: ctx.workspaceTopLevelContext,
      channelCapabilities: ctx.channelCapabilities ?? null,
      channelCommandContext: ctx.commandIntent ?? null,
      channelTurnContext,
      interfaceTurnContext,
      inboundActorContext: resolvedInboundActorContext,
      temporalContext,
      voiceCallControlPrompt: ctx.voiceCallControlPrompt ?? null,
      isNonInteractive: !isInteractiveResolved,
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
    const safetyMargin = overflowRecovery.safetyMarginRatio;
    const preflightBudget = Math.floor(providerMaxTokens * (1 - safetyMargin));
    let reducerState: ReducerState | undefined;

    const preflightTokens = estimatePromptTokens(
      runMessages,
      ctx.systemPrompt,
      { providerName: ctx.provider.name },
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
          "thinking_delta",
          "assistant_turn",
          reqId,
          "Compacting context",
        );
        const step = await reduceContextOverflow(
          ctx.messages,
          {
            providerName: ctx.provider.name,
            systemPrompt: ctx.systemPrompt,
            contextWindow: config.contextWindow,
            targetTokens: preflightBudget,
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
          conversationStore.updateConversationContextWindow(
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
        }

        // Re-inject with potentially downgraded injection mode
        runMessages = applyRuntimeInjections(ctx.messages, {
          ...injectionOpts,
          mode: currentInjectionMode,
        });

        if (step.estimatedTokens <= preflightBudget) break;
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
      conversationStore.getConversation(ctx.conversationId)?.title ?? null,
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

    const onCheckpoint = (): CheckpointDecision => {
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
    if (
      state.contextTooLargeDetected &&
      updatedHistory.length === preRunHistoryLength
    ) {
      if (!reducerState) {
        reducerState = createInitialReducerState();
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
          "thinking_delta",
          "assistant_turn",
          reqId,
          "Compacting context",
        );
        const step = await reduceContextOverflow(
          ctx.messages,
          {
            providerName: ctx.provider.name,
            systemPrompt: ctx.systemPrompt,
            contextWindow: config.contextWindow,
            targetTokens: preflightBudget,
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
          conversationStore.updateConversationContextWindow(
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
        }

        runMessages = applyRuntimeInjections(ctx.messages, {
          ...injectionOpts,
          mode: currentInjectionMode,
        });
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

      // All reducer tiers exhausted but provider still rejects —
      // consult the overflow policy for latest-turn compression.
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
                  targetInputTokensOverride: preflightBudget,
                },
              );
            if (emergencyCompact.compacted) {
              ctx.messages = emergencyCompact.messages;
              ctx.contextCompactedMessageCount +=
                emergencyCompact.compactedPersistedMessages;
              ctx.contextCompactedAt = Date.now();
              conversationStore.updateConversationContextWindow(
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
            }

            runMessages = applyRuntimeInjections(ctx.messages, {
              ...injectionOpts,
              mode: currentInjectionMode,
            });
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
            // instead of a session_error, and end the turn cleanly.
            state.contextTooLargeDetected = false;
            const denyText =
              "The conversation has grown too long for the model to process, " +
              "and compression was declined. Please start a new conversation " +
              "or manually shorten the thread to continue.";
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
            await conversationStore.addMessage(
              ctx.conversationId,
              "assistant",
              JSON.stringify(denyMessage.content),
              loopChannelMeta,
            );
            denyCompressionMessage = denyMessage;
            onEvent({
              type: "assistant_text_delta",
              text: denyText,
              sessionId: ctx.conversationId,
            });
            // Prevent the final error fallback from firing
            state.providerErrorUserMessage = null;
          }
        } else if (action === "auto_compress_latest_turn") {
          // Non-interactive — auto-compress without asking
          ctx.emitActivityState(
            "thinking",
            "thinking_delta",
            "assistant_turn",
            reqId,
            "Compacting context",
          );
          const emergencyCompact = await ctx.contextWindowManager.maybeCompact(
            ctx.messages,
            abortController.signal,
            {
              lastCompactedAt: ctx.contextCompactedAt ?? undefined,
              force: true,
              minKeepRecentUserTurns: 0,
              targetInputTokensOverride: preflightBudget,
            },
          );
          if (emergencyCompact.compacted) {
            ctx.messages = emergencyCompact.messages;
            ctx.contextCompactedMessageCount +=
              emergencyCompact.compactedPersistedMessages;
            ctx.contextCompactedAt = Date.now();
            conversationStore.updateConversationContextWindow(
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
          }

          runMessages = applyRuntimeInjections(ctx.messages, {
            ...injectionOpts,
            mode: currentInjectionMode,
          });
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
        const classified = classifySessionError(
          new Error("context_length_exceeded"),
          { phase: "agent_loop" },
        );
        onEvent(buildSessionErrorMessage(ctx.conversationId, classified));
      }
    } else if (state.contextTooLargeDetected) {
      // Progress was made (updatedHistory grew), so the retry path above was
      // skipped. Surface the error so clients are not left with a silent failure.
      rlog.warn(
        { phase: "post_run" },
        "Context too large after progress — surfacing error without retry",
      );
      const classified = classifySessionError(
        new Error("context_length_exceeded"),
        { phase: "agent_loop" },
      );
      onEvent(buildSessionErrorMessage(ctx.conversationId, classified));
      state.providerErrorUserMessage = classified.userMessage;
    }

    if (state.deferredOrderingError) {
      const classified = classifySessionError(
        new Error(state.deferredOrderingError),
        { phase: "agent_loop" },
      );
      onEvent(buildSessionErrorMessage(ctx.conversationId, classified));
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
      await conversationStore.addMessage(
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
      await conversationStore.addMessage(
        ctx.conversationId,
        "assistant",
        JSON.stringify(errorAssistantMessage.content),
        errChannelMeta,
      );
      newMessages.push(errorAssistantMessage);
      onEvent({
        type: "assistant_text_delta",
        text: state.providerErrorUserMessage,
        sessionId: ctx.conversationId,
      });
    }

    const restoredHistory = [...preRepairMessages, ...newMessages];
    ctx.messages = stripInjectedContext(restoredHistory, {
      stripRecall: (msgs) =>
        stripMemoryRecallMessages(
          msgs,
          recall.injectedText,
          recallInjectionStrategy,
        ),
      stripDynamicProfile: (msgs) =>
        stripDynamicProfileMessages(msgs, dynamicProfile.text),
    });

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
    );

    void getHookManager().trigger("post-message", {
      sessionId: ctx.conversationId,
    });

    // Resolve attachments
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

    const warningText = formatAttachmentWarnings(
      attachmentResult.directiveWarnings,
    );
    if (warningText) {
      onEvent({
        type: "assistant_text_delta",
        text: warningText,
        sessionId: ctx.conversationId,
      });
    }

    // Emit completion event
    if (yieldedForHandoff) {
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
        sessionId: ctx.conversationId,
        requestId: reqId,
        queuedCount: ctx.getQueueDepth(),
        ...(emittedAttachments.length > 0
          ? { attachments: emittedAttachments }
          : {}),
      });
    } else if (abortController.signal.aborted) {
      ctx.emitActivityState("idle", "generation_cancelled", "global", reqId);
      ctx.traceEmitter.emit(
        "generation_cancelled",
        "Generation cancelled by user",
        {
          requestId: reqId,
          status: "warning",
        },
      );
      onEvent({ type: "generation_cancelled", sessionId: ctx.conversationId });
    } else {
      ctx.emitActivityState("idle", "message_complete", "global", reqId);
      ctx.traceEmitter.emit("message_complete", "Message processing complete", {
        requestId: reqId,
        status: "success",
      });
      onEvent({
        type: "message_complete",
        sessionId: ctx.conversationId,
        ...(emittedAttachments.length > 0
          ? { attachments: emittedAttachments }
          : {}),
      });
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
            type: "session_title_updated",
            sessionId: ctx.conversationId,
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
      onEvent({ type: "generation_cancelled", sessionId: ctx.conversationId });
    } else {
      ctx.emitActivityState("idle", "error_terminal", "global", reqId);
      const message = err instanceof Error ? err.message : String(err);
      const errorClass = err instanceof Error ? err.constructor.name : "Error";
      rlog.error({ err }, "Session processing error");
      ctx.traceEmitter.emit("request_error", truncate(message, 200, ""), {
        requestId: reqId,
        status: "error",
        attributes: { errorClass, message: truncate(message, 500, "") },
      });
      const classified = classifySessionError(err, errorCtx);
      onEvent({ type: "error", message: classified.userMessage });
      onEvent(buildSessionErrorMessage(ctx.conversationId, classified));
      void getHookManager().trigger("on-error", {
        error: err instanceof Error ? err.name : "Error",
        message,
        stack: err instanceof Error ? err.stack : undefined,
        sessionId: ctx.conversationId,
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

    if (userMessageId) {
      consolidateAssistantMessages(ctx.conversationId, userMessageId);
    }

    ctx.drainQueue(yieldedForHandoff ? "checkpoint_handoff" : "loop_complete");
  }
}

// ── Helper ───────────────────────────────────────────────────────────

function emitUsage(
  ctx: Pick<
    AgentLoopSessionContext,
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
): void {
  recordUsage(
    {
      conversationId: ctx.conversationId,
      providerName: ctx.provider.name,
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
  );
}

function collapseRawResponses(rawResponses?: unknown[]): unknown | undefined {
  if (!rawResponses || rawResponses.length === 0) return undefined;
  return rawResponses.length === 1 ? rawResponses[0] : rawResponses;
}
