/**
 * Agent loop execution extracted from Conversation.runAgentLoop.
 *
 * This module contains the core agent loop orchestration: pre-flight
 * setup, event handling, retry logic, history reconstruction, and
 * completion event emission.  The Conversation class delegates its
 * runAgentLoop method here, passing itself as the loop context.
 */

import { v4 as uuid } from "uuid";

import { optimizeImageForTransport } from "../agent/image-optimize.js";
import type {
  AgentEvent,
  AgentLoopExitReason,
  CheckpointDecision,
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
  type EffectiveContextWindow,
  resolveEffectiveContextWindow,
} from "../config/llm-context-resolution.js";
import {
  resolveCallSiteConfig,
  resolveDefaultProfileKey,
} from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type { ContextWindowConfig } from "../config/types.js";
import { runEmergencyCompaction } from "../context/compactor.js";
import {
  derefToolResultReReads,
  postTurnTruncateToolResults,
} from "../context/post-turn-tool-result-truncation.js";
import {
  estimatePromptTokens,
  estimatePromptTokensWithTools,
  getCalibrationProviderKey,
} from "../context/token-estimator.js";
import type { ContextWindowCompactOptions } from "../context/window-manager.js";
import { writeRelationshipState } from "../home/relationship-state-writer.js";
import {
  clearSentryConversationContext,
  setSentryConversationContext,
} from "../instrument.js";
import { commitAppTurnChanges } from "../memory/app-git-service.js";
import { enqueueAutoAnalysisOnCompaction } from "../memory/auto-analysis-enqueue.js";
import {
  addMessage,
  deleteMessageById,
  getConversation,
  getConversationOriginChannel,
  getConversationOriginInterface,
  getLastUserTimestampBefore,
  getMessageById,
  provenanceFromTrustContext,
  resolveOverrideProfile,
  updateConversationContextWindow,
  updateConversationSlackContextWatermark,
  updateMessageMetadata,
} from "../memory/conversation-crud.js";
import { getResolvedConversationDirPath } from "../memory/conversation-directories.js";
import { syncMessageToDisk } from "../memory/conversation-disk-view.js";
import { isReplaceableTitle } from "../memory/conversation-title-service.js";
import type { ConversationGraphMemory } from "../memory/graph/conversation-graph-memory.js";
import {
  backfillMessageIdOnLogs,
  recordSyntheticAgentErrorMessageLog,
} from "../memory/llm-request-log-store.js";
import { enqueueMemoryRetrospectiveOnCompaction } from "../memory/memory-retrospective-enqueue.js";
import { HOOKS } from "../plugin-api/constants.js";
import type { UserPromptSubmitContext } from "../plugin-api/types.js";
import { defaultCompact } from "../plugins/defaults/compaction/compact.js";
import { deepRepairHistory } from "../plugins/defaults/history-repair/terminal.js";
import userPromptSubmitMemoryRetrieval, {
  type MemoryRetrievalHookContext,
} from "../plugins/defaults/memory-retrieval/hooks/user-prompt-submit-temp.js";
import { runHook } from "../plugins/pipeline.js";
import type { ContentBlock, Message } from "../providers/types.js";
import type { Provider } from "../providers/types.js";
import {
  isUntrustedTrustClass,
  resolveActorTrust,
} from "../runtime/actor-trust-resolver.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";
import type { UsageActor } from "../usage/actors.js";
import { getLogger } from "../util/logger.js";
import { timeAgo } from "../util/time.js";
import { truncate } from "../util/truncate.js";
import { getWorkspaceGitService } from "../workspace/git-service.js";
import { commitTurnChanges } from "../workspace/turn-commit.js";
import { cleanAssistantContent } from "./assistant-attachments.js";
import { resolveOverflowAction } from "./context-overflow-policy.js";
import {
  createInitialReducerState,
  reduceContextOverflow,
  type ReducerState,
} from "./context-overflow-reducer.js";
import type { Conversation } from "./conversation.js";
import {
  createEventHandlerState,
  dispatchAgentEvent,
  type EventHandlerDeps,
  finalizePendingToolResultRow,
  markHistoryStrippedBestEffort,
} from "./conversation-agent-loop-handlers.js";
import {
  approveHostAttachmentRead,
  resolveAssistantAttachments,
} from "./conversation-attachments.js";
import {
  budgetYieldUnrecoveredClassification,
  buildConversationErrorMessage,
  classifyConversationError,
  isUserCancellation,
} from "./conversation-error.js";
import { raceWithTimeout } from "./conversation-media-retry.js";
import type {
  InboundActorContext,
  InjectionMode,
} from "./conversation-runtime-assembly.js";
import {
  applyRuntimeInjections,
  getSlackCompactionWatermarkForPrefix,
  inboundActorContextFromTrust,
  inboundActorContextFromTrustContext,
  loadSlackChronologicalContext,
  type SlackChronologicalContext,
  stripInjectionsForCompaction,
} from "./conversation-runtime-assembly.js";
import { markSurfaceCompleted } from "./conversation-surfaces.js";
import { recordUsage } from "./conversation-usage.js";
import { resolveTurnTimezoneContext } from "./date-context.js";
import { getDiskPressureStatus } from "./disk-pressure-guard.js";
import { classifyDiskPressureTurnPolicy } from "./disk-pressure-policy.js";
import type {
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UsageStats,
} from "./message-protocol.js";
import {
  type OverflowReduceArgs,
  runOverflowReductionLoop,
} from "./overflow-reduction-loop.js";
import { parseActualTokensFromError } from "./parse-actual-tokens-from-error.js";
import {
  persistUnsendableImageDowngrades,
  UNSENDABLE_IMAGE_NOTE,
} from "./persist-unsendable-image.js";
import { resolveTrustClass, type TrustContext } from "./trust-context.js";
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

function formatDiskPressureBlockedMessage(): string {
  return "Storage is critically low, so background processes are paused and remote messages are ignored until the guardian frees enough space. Remote senders should try again later.";
}

// ── Plugin pipeline helpers ──────────────────────────────────────────

/**
 * Synthetic fallback trust context used when the orchestrator fires a hook
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
 * Trust class of the actor whose turn is in progress, for the compactor's
 * image manifest filter. Prefers the turn-start snapshot
 * ({@link Conversation.currentTurnTrustContext}) over the live
 * trust context so compaction running in a later tool iteration can't pick up
 * a concurrent request's actor.
 */
function resolveTurnActorTrustClass(
  ctx: Conversation,
): TrustContext["trustClass"] | undefined {
  return (ctx.currentTurnTrustContext ?? ctx.trustContext)?.trustClass;
}

/**
 * Per-surface entry tracked on the current turn. Inline shape kept stable so
 * routes and persistence helpers can consume it via a named import instead of
 * `infer`-extracting from {@link Conversation}.
 */
export interface AssistantSurface {
  surfaceId: string;
  surfaceType: SurfaceType;
  title?: string;
  data: SurfaceData;
  actions?: Array<{
    id: string;
    label: string;
    style?: string;
    data?: Record<string, unknown>;
  }>;
  display?: string;
  persistent?: boolean;
  /** Id of the tool call that produced this surface (the `ui_show` proxy tool). Persisted so app previews can gate on the tool result's arrival rather than whole-turn streaming state. */
  toolCallId?: string;
}

// ── runAgentLoop ─────────────────────────────────────────────────────

export async function runAgentLoopImpl(
  ctx: Conversation,
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
  let yieldedForBudget = false;
  // Whether the most recent agent-loop run produced at least one new assistant
  // message — the loop's own forward-progress signal, used by the ordering
  // retry gate and the overflow convergence fold.
  let lastRunAppendedNewMessages = false;
  // The messages the most recent agent-loop run appended on top of its base —
  // the loop's own new-output boundary, persisted as this turn's new messages.
  let lastRunNewMessages: Message[] = [];
  let pendingCheckpointYield: "budget" | "handoff" | null = null;
  // Captured when the auto_compress_latest_turn rerun yields at the mid-loop
  // budget checkpoint. SSE emission happens immediately at the detection site;
  // assistant-row persistence is deferred until after the pendingToolResults
  // flush so we don't orphan tool_use/tool_result pairs in the durable history.
  let budgetYieldClassification: ReturnType<
    typeof budgetYieldUnrecoveredClassification
  > | null = null;
  let emitTerminalExit:
    | ((reason: AgentLoopExitReason) => Promise<void>)
    | null = null;

  // Default user-initiated turns to the `mainAgent` call site. Other
  // invocation contexts (heartbeat, filing, analyze, etc.) pass their own
  // `callSite`. The provider layer resolves provider/model/maxTokens via
  // `resolveCallSiteConfig`, picking up any user overrides under
  // `llm.callSites.mainAgent` (falling back to `llm.default` when absent).
  const turnCallSite: LLMCallSite = options?.callSite ?? "mainAgent";
  // Expose the turn's call site on the live conversation so the runtime
  // injection assembly self-resolves it for the turn's plugin contexts.
  ctx.currentCallSite = turnCallSite;

  // Optional per-turn inference-profile override. Plumbed through to every
  // LLM call the loop emits and inherited by any subagents spawned during
  // this turn. Caller-supplied `options.overrideProfile` (e.g.
  // SubagentManager forwarding the parent's pinned profile into the
  // spawned subagent's background conversation) wins over the conversation's
  // own override so the agent loop's background-skip rule doesn't zero out an
  // explicitly inherited override. The override state is mirrored onto the
  // live conversation (hydrated on load, kept current by the HTTP setters and
  // the expiry reaper), so the derivation reads `ctx` rather than re-fetching
  // the row.
  const userExplicitOverride =
    options?.overrideProfile ?? resolveOverrideProfile(ctx);

  const config = getConfig();

  // Tool-based auto-routing: the switch_inference_profile tool lets the model
  // self-select a different profile mid-turn. Reset the per-turn slot so a
  // stale selection from a previous turn doesn't leak forward.
  ctx.toolRoutedProfile = undefined;

  const turnOverrideProfile = userExplicitOverride;

  const readCurrentOverrideProfile = (): string | undefined =>
    options?.overrideProfile ??
    resolveOverrideProfile(ctx) ??
    ctx.toolRoutedProfile;

  const effectiveContextWindow = resolveEffectiveContextWindow({
    llm: config.llm,
    callSite: turnCallSite,
    overrideProfile: turnOverrideProfile ?? undefined,
    selectionSeed: ctx.conversationId,
  });
  let currentEffectiveContextWindow: EffectiveContextWindow =
    effectiveContextWindow;
  let currentContextWindowConfig = contextWindowConfigFromEffective(
    resolveCallSiteConfig(turnCallSite, config.llm, {
      overrideProfile: turnOverrideProfile ?? undefined,
      selectionSeed: ctx.conversationId,
    }).contextWindow,
    currentEffectiveContextWindow,
  );
  ctx.contextWindowManager.updateConfig(currentContextWindowConfig);

  let appliedOverrideProfile = turnOverrideProfile;
  let emittedToolRoutedProfile: string | undefined;
  const refreshCurrentProfileState = (): string | undefined => {
    const currentOverrideProfile = readCurrentOverrideProfile();
    if (currentOverrideProfile !== appliedOverrideProfile) {
      currentEffectiveContextWindow = resolveEffectiveContextWindow({
        llm: config.llm,
        callSite: turnCallSite,
        overrideProfile: currentOverrideProfile,
        selectionSeed: ctx.conversationId,
      });
      currentContextWindowConfig = contextWindowConfigFromEffective(
        resolveCallSiteConfig(turnCallSite, config.llm, {
          overrideProfile: currentOverrideProfile,
          selectionSeed: ctx.conversationId,
        }).contextWindow,
        currentEffectiveContextWindow,
      );
      ctx.contextWindowManager.updateConfig(currentContextWindowConfig);
      appliedOverrideProfile = currentOverrideProfile;
      rlog.info(
        { overrideProfile: currentOverrideProfile ?? null },
        "Turn inference profile changed mid-loop",
      );
    }

    // Emit turn_profile_auto_routed when the tool-based router selects a
    // new profile. Deduplicated so the event fires at most once per profile.
    if (
      ctx.toolRoutedProfile &&
      ctx.toolRoutedProfile !== emittedToolRoutedProfile
    ) {
      emittedToolRoutedProfile = ctx.toolRoutedProfile;
      const profileEntry = config.llm.profiles?.[ctx.toolRoutedProfile];
      const label = profileEntry?.label ?? ctx.toolRoutedProfile;
      broadcastMessage({
        type: "turn_profile_auto_routed",
        conversationId: ctx.conversationId,
        profile: ctx.toolRoutedProfile,
        profileLabel: label,
      });
    }

    ctx.currentTurnOverrideProfile = currentOverrideProfile;
    return currentOverrideProfile;
  };
  const resolveCurrentOverrideProfile = (): string | undefined =>
    refreshCurrentProfileState();
  const resolveCurrentMaxInputTokens = (): number => {
    refreshCurrentProfileState();
    return currentEffectiveContextWindow.maxInputTokens;
  };
  const resolveCurrentContextWindowConfig = (): ContextWindowConfig => {
    refreshCurrentProfileState();
    return currentContextWindowConfig;
  };
  const resolveCurrentContextBudget = (): {
    overflowRecovery: EffectiveContextWindow["overflowRecovery"];
    providerMaxTokens: number;
    preflightBudget: number;
  } => {
    refreshCurrentProfileState();
    const overflowRecovery = currentEffectiveContextWindow.overflowRecovery;
    const providerMaxTokens = currentEffectiveContextWindow.maxInputTokens;
    const baseSafetyMargin = overflowRecovery.safetyMarginRatio;
    const messageCount = ctx.messages.length;
    const safetyMargin =
      messageCount > 50 ? Math.max(baseSafetyMargin, 0.15) : baseSafetyMargin;
    return {
      overflowRecovery,
      providerMaxTokens,
      preflightBudget: Math.floor(providerMaxTokens * (1 - safetyMargin)),
    };
  };
  /**
   * The agent loop's window into the orchestrator's current effective
   * context window. The loop reads `maxInputTokens` for tool-result
   * truncation and `overflowRecovery` for its mid-loop budget gate, applying
   * the long-history safety-margin bump itself off its own running history.
   * Resolved fresh on each access so a mid-turn profile change is reflected.
   */
  const resolveContextWindow = (): {
    maxInputTokens: number;
    overflowRecovery: { enabled: boolean; safetyMarginRatio: number };
  } => {
    refreshCurrentProfileState();
    const { enabled, safetyMarginRatio } =
      currentEffectiveContextWindow.overflowRecovery;
    return {
      maxInputTokens: currentEffectiveContextWindow.maxInputTokens,
      overflowRecovery: { enabled, safetyMarginRatio },
    };
  };

  // Initial value for `createToolExecutor` to read into
  // `ToolContext.overrideProfile`. `resolveCurrentOverrideProfile` refreshes
  // this between model calls so a confirmed profile session opened by a tool
  // applies to later tool executions and nested subagents in the same turn.
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
  // Whether the in-flight turn has no human present to answer clarification
  // questions. Derived from the loop's `isInteractive` option (which can fall
  // back to mutable client/headless state that flips mid-turn), so it is
  // resolved once here and threaded into every re-injection — including the
  // post-compaction hook — rather than re-read per assembly call.
  const isNonInteractive = !isInteractiveResolved;
  const diskPressureDecision = classifyDiskPressureTurnPolicy(
    getDiskPressureStatus(),
    {
      conversationType: ctx.conversationType ?? null,
      conversationSource: ctx.source ?? null,
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
  ctx.diskPressureCleanupModeActive =
    diskPressureDecision.action === "allow-cleanup-mode";

  ctx.lastAssistantAttachments = [];
  ctx.lastAttachmentWarnings = [];

  ctx.profiler.startRequest();
  let turnStarted = false;
  const state = createEventHandlerState();
  let persistedErrorAssistantMessage = false;

  const publishLoopMessagesChanged = (): void => {
    if (
      state.lastAssistantMessageId ||
      state.persistedToolUseIds.size > 0 ||
      persistedErrorAssistantMessage
    ) {
      publishConversationMessagesChanged(ctx.conversationId);
    }
  };

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
      ctx.emitActivityState("idle", "error_terminal", {
        anchor: "global",
        requestId: reqId,
      });
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

    const isFirstMessage = ctx.messages.length === 1;
    const isSlackConversation = ctx.channelCapabilities?.channel === "slack";
    const loadCurrentSlackChronologicalContext =
      (): SlackChronologicalContext | null => {
        if (!isSlackConversation) return null;
        return loadSlackChronologicalContext(
          ctx.conversationId,
          ctx.channelCapabilities!,
          {
            trustClass: ctx.trustContext?.trustClass,
            contextSummary: ctx.contextSummary,
            contextCompactedMessageCount: ctx.contextCompactedMessageCount,
            slackContextCompactionWatermarkTs:
              ctx.slackContextCompactionWatermarkTs,
          },
        );
      };
    let slackChronologicalContext: SlackChronologicalContext | null =
      loadCurrentSlackChronologicalContext();
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
            tagLineProvenance: "none",
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
      slackChronologicalContext = projectSlackProvenanceAfterCompaction(
        provenanceContext,
        compactedBasis,
        result,
      );
    };

    // Register confirmation outcome tracker so the agent loop can link
    // confirmation decisions to tool_use_ids for persistence.
    ctx.onConfirmationOutcome = (requestId, confirmationState, toolUseId) => {
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
          const name = state.toolUseIdToName.get(resolvedId) ?? "";
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

    // Resolve the turn's timezone cascade up front. It depends only on config
    // and the inbound request — never on retrieval output — so it can be
    // settled before context assembly. Local date semantics prefer the
    // configured user timezone, then device timezones, then the host clock.
    const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timezoneContext = resolveTurnTimezoneContext({
      configuredUserTimeZone: config.ui.userTimezone ?? null,
      clientTimezone: ctx.clientTimezone ?? null,
      detectedTimezone: config.ui.detectedTimezone ?? null,
      hostTimeZone,
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

    // Resolve the guardian flag for this turn. It derives only from the
    // resolved actor trust class — never from retrieval — so it settles before
    // context assembly.
    const isGuardian =
      resolvedInboundActorContext?.trustClass === "guardian" ||
      !resolvedInboundActorContext;

    // Unified `<turn_context>` actor input, included only for non-guardian
    // turns. Resolved once at turn start and threaded per call site (like
    // `modelProfile`) so post-compaction re-injection receives it as an
    // explicit hook input rather than re-deriving it from live state that can
    // flip mid-turn.
    const actorContext = isGuardian ? null : resolvedInboundActorContext;

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

    // Freeze the turn-start client timezone and long-absence gap on the
    // conversation so `applyRuntimeInjections` sources them from live state —
    // like the channel/voice/transport hints. Frozen here (rather than read
    // live in assembly) because the live `ctx.clientTimezone` is overwritten
    // when a newer message for the same conversation arrives mid-turn, which
    // would otherwise leak a queued message's timezone into the in-flight turn.
    // The `current_time` value is computed fresh at each injection point, so
    // it is not part of this snapshot.
    ctx.currentTurnTemporalSnapshot = {
      clientTimezone: timezoneContext.clientTimezone,
      timeSinceLastMessage,
    };

    // Resolve the effective profile key for this turn and detect changes.
    // Only inject model_profile into the turn context when the profile
    // changed since the last turn (or on the first turn of a conversation)
    // to avoid per-turn token cost.
    const effectiveProfileKey =
      turnOverrideProfile ??
      config.llm.activeProfile ??
      resolveDefaultProfileKey("mainAgent", config.llm);
    const lastNotified = ctx.lastNotifiedInferenceProfile;
    let modelProfileStr: string | null = null;
    if (effectiveProfileKey != null && effectiveProfileKey !== lastNotified) {
      const profileEntry = config.llm.profiles?.[effectiveProfileKey];
      const resolved = resolveCallSiteConfig(turnCallSite, config.llm, {
        overrideProfile: turnOverrideProfile ?? undefined,
      });
      const label = profileEntry?.label ?? effectiveProfileKey;
      modelProfileStr = resolved.model ? `${label} (${resolved.model})` : label;
      // Record the notification for persistence on delivery rather than here:
      // the model only "learns" the profile once it receives this turn
      // context, signalled by the first `message_complete`. Persisting inline
      // would mark the profile notified even if the turn is cancelled or fails
      // before the model ever sees the notice.
      state.pendingNotifiedInferenceProfile = effectiveProfileKey;
    }

    // Memory retrieval — fetches PKB, NOW.md, and memory-graph outputs and
    // persists the retrieval's own side effects (injected-block metadata,
    // recall log, `memory_recalled` event). Runs at the early "prompt
    // submitted, before context assembly" moment because its outputs feed the
    // injection and overflow-reduction transforms below. It is shaped as the
    // `user-prompt-submit-temp` hook handler but invoked directly for now: it
    // must run early, while the canonical late `user-prompt-submit` hook
    // (history repair, title) runs after those transforms, so the two cannot
    // share a fire site until compaction is cleared from the gap between them.
    const isTrustedActor = resolveTrustClass(ctx.trustContext) === "guardian";
    const memoryCtx: MemoryRetrievalHookContext = {
      graphMemory: ctx.graphMemory,
      config: getConfig(),
      onEvent,
      isTrustedActor,
      conversationId: ctx.conversationId,
      userMessageId,
      logger: rlog,
      // An external cancel aborts `prepareMemory` instead of letting it run
      // to completion after the turn has already been torn down.
      signal: abortController.signal,
      latestMessages: ctx.messages,
    };
    await userPromptSubmitMemoryRetrieval(memoryCtx);

    // The retriever owns its side effects (injected-block metadata, recall
    // log, `memory_recalled` event) and records the dense/sparse PKB query
    // pair on the graph handle for the PKB-reminder injector to read back; the
    // loop only reuses the injected message list downstream.
    let runMessages = memoryCtx.latestMessages;

    // The `remember` tool handles scratchpad-style memory writes directly to the graph.

    let currentInjectionMode: InjectionMode = "full";

    // `applyRuntimeInjections` self-resolves every per-turn injection input —
    // the Slack chronological transcript, the unified `<turn_context>` block,
    // channel/voice/transport hints, and the turn's trust/index/call-site —
    // from the live conversation, so we only hand in the request id (the one
    // turn-identity field it can't recover) plus the conversation id that keys
    // that lookup. `isNonInteractive`, `modelProfile`, and `actorContext` are
    // resolved once at turn start and threaded per call site so post-compaction
    // re-injection receives them as explicit inputs rather than via live state
    // that can flip mid-turn.
    const injection = await applyRuntimeInjections(runMessages, {
      isNonInteractive,
      modelProfile: modelProfileStr,
      actorContext,
      mode: currentInjectionMode,
      requestId: reqId,
      conversationId: ctx.conversationId,
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
      injection.blocks.pkbContextBlock ||
      injection.blocks.memoryV2StaticBlock
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
        if (injection.blocks.memoryV2StaticBlock) {
          metadataUpdates.memoryV2StaticBlock =
            injection.blocks.memoryV2StaticBlock;
        }
        updateMessageMetadata(userMessageId, metadataUpdates);
      } catch (err) {
        rlog.warn({ err }, "Failed to persist injection metadata (non-fatal)");
      }
    }

    // ── Preflight budget evaluation ──────────────────────────────
    // After runtime injections are applied, estimate the prompt token count
    // and proactively invoke the reducer if already above budget. This avoids
    // a wasted provider round-trip that would just fail with context_too_large.
    const initialContextBudget = resolveCurrentContextBudget();
    const overflowRecovery = initialContextBudget.overflowRecovery;
    const preflightBudget = initialContextBudget.preflightBudget;
    let reducerState: ReducerState | undefined;

    const toolTokenBudget = ctx.agentLoop.getToolTokenBudget(runMessages);
    // Canonical calibration key — used by the preflight estimate, the
    // overflow reducer config, and the convergence-path `estimatePromptTokens`
    // call. Matches the key recorded by `handleUsage` for wrapper providers
    // (OpenRouter routing to Anthropic → key is `"anthropic"`).
    const estimationProviderName = getCalibrationProviderKey(ctx.provider);

    const preflightTokens = estimatePromptTokensWithTools(
      runMessages,
      ctx.systemPrompt,
      ctx.agentLoop.getResolvedTools(runMessages),
      estimationProviderName,
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

      // `runOverflowReductionLoop` drives the tier loop — forced compaction →
      // tool-result truncation → media stubbing → injection downgrade — plus
      // the re-inject/re-estimate convergence check. The callbacks below are
      // the orchestrator-specific side effects it coordinates per iteration
      // (activity emission, compaction application, runtime injection
      // reassembly, token re-estimation).
      const messagesForPreflightOverflowReduction =
        slackChronologicalContext?.messages ?? ctx.messages;
      const overflowArgs: OverflowReduceArgs = {
        messages: messagesForPreflightOverflowReduction,
        runMessages,
        systemPrompt: ctx.systemPrompt,
        providerName: estimationProviderName,
        contextWindow: resolveCurrentContextWindowConfig(),
        preflightBudget,
        toolTokenBudget,
        maxAttempts: resolveCurrentContextBudget().overflowRecovery.maxAttempts,
        abortSignal: abortController.signal,
        compactFn: async (msgs, signal, opts) => {
          // Delegate the reducer's forced-compaction tier to the default
          // compaction plugin, overlaying the turn's resolved inference
          // profile and actor trust class onto the reducer-supplied options.
          const reducerOptions = (opts ?? {}) as ContextWindowCompactOptions;
          return defaultCompact({
            manager: ctx.contextWindowManager,
            messages: msgs,
            signal,
            ...reducerOptions,
            overrideProfile: resolveCurrentOverrideProfile() ?? null,
            actorTrustClass: resolveTurnActorTrustClass(ctx),
          });
        },
        emitActivityState: () => {
          ctx.emitActivityState("thinking", "context_compacting", {
            requestId: reqId,
          });
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
            await ctx.agentLoop.compactionCircuit.recordOutcome(
              result.summaryFailed,
              onEvent,
            );
          }
          if (result.compacted) {
            await applySuccessfulCompaction(result, compactedBasis);
          }
        },
        reinjectForMode: async (reducedMessages, mode) => {
          // `ctx.messages` must track the reducer's latest output before
          // re-injection runs: the injectors' message-presence scans and the
          // self-resolved Slack chronological transcript read live conversation
          // state, and `applyCompactionResult` only updates `ctx.messages` on a
          // compaction tier. Assigning here keeps non-compaction tiers
          // (tool-result truncation, media stubbing, injection downgrade)
          // observable to downstream injection assembly on the same turn.
          ctx.messages = reducedMessages;

          // When THIS iteration compacted, it stripped the existing
          // memory-static block — so we re-inject current content. A later
          // iteration that only truncates or downgrades must NOT re-force it,
          // or each round would grow the token count.
          // Gate: only the iteration that actually compacted re-injects.
          // (The `<knowledge_base>`, NOW.md, and v2 static `<info>` blocks
          // self-gate inside their injectors on whether they are already
          // present in `reducedMessages`.)
          const injection = await applyRuntimeInjections(reducedMessages, {
            isNonInteractive,
            modelProfile: modelProfileStr,
            actorContext,
            mode,
            requestId: reqId,
            conversationId: ctx.conversationId,
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

      const overflowResult = await runOverflowReductionLoop(overflowArgs);

      ctx.messages = overflowResult.messages;
      runMessages = overflowResult.runMessages;
      currentInjectionMode = overflowResult.injectionMode;
      reducerState = overflowResult.reducerState;
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

    // user-prompt-submit hook: plugins may transform `runMessages` right
    // before the agent loop receives them. Fires once per user turn at the
    // primary `agentLoop.run` only — the re-entry / retry calls further down
    // in this function do not refire it (they're not new user submissions).
    // Plugins may mutate `ctx.latestMessages` in place OR return a new
    // context with a fresh array; `runHook` forwards whichever the chain
    // settles on. Order is plugin registration order.
    //
    // Fires BEFORE the agent loop runs so the hook-emitted messages are part
    // of the loop's input; the loop then reports its own appended output via
    // `AgentLoopRunResult.newMessages`, which is what persistence consumes.
    const userPromptCtx: UserPromptSubmitContext = {
      conversationId: ctx.conversationId,
      prompt: options?.titleText ?? content,
      originalMessages: ctx.messages,
      latestMessages: runMessages,
      logger: rlog,
    };
    const finalUserPromptCtx = await runHook(
      HOOKS.USER_PROMPT_SUBMIT,
      userPromptCtx,
    );
    runMessages = finalUserPromptCtx.latestMessages;

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
      applyCompaction: applySuccessfulCompaction,
    };
    const eventHandler = (event: AgentEvent): Promise<void> =>
      dispatchAgentEvent(state, deps, event);
    emitTerminalExit = async (reason: AgentLoopExitReason): Promise<void> => {
      await eventHandler({ type: "agent_loop_exit", reason });
    };

    const onCheckpoint = async (): Promise<CheckpointDecision> => {
      if (ctx.canHandoffAtCheckpoint()) {
        return "handoff";
      }
      return "continue";
    };

    turnStarted = true;

    rlog.info({ callSite: turnCallSite }, "Starting agent loop run");

    // Trust snapshot the loop forwards to its mid-loop in-place compaction
    // (scoping the compactor's image manifest) and the post-compaction
    // re-injection. Prefers the per-turn snapshot, then the conversation-level
    // context, then the fallback — matching the trust the runtime injection
    // assembly resolves for the same turn. The loop's other turn-identity
    // fields self-resolve from its own conversation id.
    const loopTrust =
      ctx.currentTurnTrustContext ?? ctx.trustContext ?? FALLBACK_TURN_TRUST;

    /**
     * Shared closure: runs the agent loop with the orchestrator's turn
     * context and maps the loop's returned checkpoint pause-reason into the
     * orchestrator's yield bookkeeping. Returns the updated history so call
     * sites consume it exactly as before. Pass `compactInPlace` only for the
     * primary run: the loop then runs its budget gate before the first call
     * (subsuming the proactive turn-start compaction) and compacts in place
     * whenever the gate trips. Reruns omit it, skip the first-call gate, and
     * keep yielding for budget.
     */
    const runAgentLoop = async (
      msgs: Message[],
      compactInPlace = false,
    ): Promise<Message[]> => {
      const { history, exitReason, appendedNewMessages, newMessages } =
        await ctx.agentLoop.run({
          messages: msgs,
          onEvent: eventHandler,
          signal: abortController.signal,
          requestId: reqId,
          onCheckpoint,
          callSite: turnCallSite,
          trust: loopTrust,
          contextWindowManager: ctx.contextWindowManager,
          overrideProfile: turnOverrideProfile,
          resolveOverrideProfile: resolveCurrentOverrideProfile,
          resolveContextWindow,
          compactInPlace,
          isNonInteractive,
          modelProfile: modelProfileStr,
          actorContext,
        });
      lastRunAppendedNewMessages = appendedNewMessages;
      lastRunNewMessages = newMessages;
      if (exitReason === "handoff") {
        yieldedForHandoff = true;
        pendingCheckpointYield = "handoff";
      } else if (exitReason === "budget") {
        yieldedForBudget = true;
        pendingCheckpointYield = "budget";
      }
      return history;
    };

    let updatedHistory = await runAgentLoop(runMessages, true);

    rlog.info(
      { resultMessageCount: updatedHistory.length },
      "Agent loop run completed",
    );

    if (yieldedForHandoff) {
      await emitTerminalExit?.("checkpoint_handoff");
      pendingCheckpointYield = null;
    }

    // The loop compacts in place when its budget gate trips and only yields
    // `exitReason = "budget"` when that inline compaction timed out or
    // exhausted its retry budget (the `reinject` hook has already restored
    // runtime context for the productive case). Escalate to the convergence
    // loop's more aggressive reducer tiers so a half-finished turn doesn't
    // reach the user.
    if (yieldedForBudget && !abortController.signal.aborted) {
      rlog.warn(
        { phase: "mid-loop-compact" },
        "Inline compaction could not get under budget — escalating to convergence loop",
      );
      state.contextTooLargeDetected = true;
    }

    // One-shot ordering error retry
    if (state.orderingErrorDetected && !lastRunAppendedNewMessages) {
      rlog.warn(
        { phase: "retry" },
        "Provider ordering error detected, attempting one-shot deep-repair retry",
      );
      // Design note: deep-repair intentionally stays a direct call rather
      // than running through the `user-prompt-submit` hook chain. Deep-repair
      // is a recovery-only path triggered by a provider ordering error — it
      // must be deterministic and unaffected by user hooks that might have
      // caused (or be unable to recover from) the original drift. Plugins can
      // already observe / transform the pre-run repair via the
      // `user-prompt-submit` hook (the default history-repair plugin runs
      // `repairHistory` there); widening that surface to deep-repair is
      // intentionally deferred until there's a concrete plugin-level use case.
      const retryRepair = deepRepairHistory(updatedHistory);
      runMessages = retryRepair.messages;
      const retryStrip = stripHistoricalWebSearchResults(runMessages);
      runMessages = retryStrip.messages;
      state.orderingErrorDetected = false;
      state.deferredOrderingError = null;

      updatedHistory = await runAgentLoop(runMessages);

      if (state.orderingErrorDetected) {
        rlog.error(
          { phase: "retry" },
          "Deep-repair retry also failed with ordering error. Consider starting a new conversation if this persists.",
        );
      }
    }

    // ── Image-dimension overflow recovery ──────────────────────────
    // When the provider rejects because an image block exceeds its pixel
    // cap, strip every image block from ctx.messages and retry once.
    // optimizeImageForTransport already ran at upload time; if sips was
    // unavailable (non-macOS) it returns the same bytes unchanged.  In
    // that case we swap the block for a text note so the model can tell
    // the user what happened instead of hard-failing with a red banner.
    if (state.imageTooLargeDetected) {
      state.imageTooLargeDetected = false;
      rlog.warn(
        { phase: "image-recovery" },
        "Image too large — stripping oversized image blocks and retrying",
      );
      ctx.messages = ctx.messages.map((msg) => {
        if (!Array.isArray(msg.content)) return msg;
        if (!msg.content.some((b) => b.type === "image")) return msg;
        return {
          ...msg,
          content: msg.content.flatMap((b): ContentBlock[] => {
            if (b.type !== "image") return [b];
            const resized = optimizeImageForTransport(
              b.source.data,
              b.source.media_type,
            );
            if (resized.data !== b.source.data) {
              // sips managed to downscale — use the smaller version
              return [
                {
                  ...b,
                  source: {
                    type: "base64" as const,
                    media_type: resized.mediaType,
                    data: resized.data,
                  },
                },
              ];
            }
            // Can't resize — replace with a text annotation so the model
            // can explain the situation rather than silently dropping context
            return [{ type: "text" as const, text: UNSENDABLE_IMAGE_NOTE }];
          }),
        };
      });
      // The transform above only mutates ctx.messages for the current retry.
      // Persist the downgrade for images that can never be sent so the rejected
      // upload doesn't rehydrate from the DB and resurface on later turns. This
      // is cleanup for future turns, so a persistence failure must never abort
      // the retry that is about to run — log it and continue.
      try {
        const rewritten = persistUnsendableImageDowngrades(ctx.conversationId);
        if (rewritten > 0) {
          rlog.info(
            { phase: "image-recovery", rewritten },
            "Persisted unsendable-image downgrades so they cannot resurface",
          );
        }
      } catch (err) {
        rlog.warn(
          { phase: "image-recovery", err },
          "Failed to persist unsendable-image downgrade; continuing with in-memory recovery",
        );
      }
      runMessages = ctx.messages;
      updatedHistory = await runAgentLoop(runMessages);
      if (state.imageTooLargeDetected) {
        rlog.error(
          { phase: "image-recovery" },
          "Image-recovery retry also failed — surfacing error to user",
        );
        const classified = classifyConversationError(
          new Error("Image dimensions too large"),
          { phase: "agent_loop" },
        );
        deps.onEvent(
          buildConversationErrorMessage(deps.ctx.conversationId, classified),
        );
        state.providerErrorUserMessage = classified.userMessage;
        state.imageTooLargeDetected = false;
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
      if (lastRunAppendedNewMessages) {
        ctx.messages = stripInjectionsForCompaction(updatedHistory);
        markHistoryStrippedBestEffort(ctx.conversationId);
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
      const convergenceBudget = resolveCurrentContextBudget();
      let correctedTarget = convergenceBudget.preflightBudget;
      if (actualTokens && estimatedTokensAtOverflow > 0) {
        const estimationErrorRatio = actualTokens / estimatedTokensAtOverflow;
        if (estimationErrorRatio > 1.0) {
          correctedTarget = Math.floor(
            convergenceBudget.preflightBudget / estimationErrorRatio,
          );
          rlog.warn(
            {
              phase: "convergence",
              actualTokens,
              estimatedTokens: estimatedTokensAtOverflow,
              estimationErrorRatio: estimationErrorRatio.toFixed(2),
              preflightBudget: convergenceBudget.preflightBudget,
              correctedTarget,
            },
            "Adjusting compaction target based on observed estimation error",
          );
        }
      }

      // ── Emergency mid-turn compaction ────────────────────────────
      // Before entering the reducer tier loop, attempt a targeted
      // emergency compaction: summarize everything before the last
      // tool_use + tool_result pair and let the agent continue with
      // [summary, last_tool_call, last_tool_result]. This preserves
      // the agent's most recent action context while aggressively
      // compressing history. Falls through to reducer tiers on failure.
      {
        try {
          const emergencyConfig = getConfig().compaction;
          const emergencyResult = await runEmergencyCompaction({
            conversationId: ctx.conversationId,
            messages: ctx.messages,
            provider: ctx.provider,
            systemPrompt: ctx.systemPrompt,
            tools: undefined,
            compaction: emergencyConfig,
            maxInputTokens: resolveCurrentMaxInputTokens(),
            previousEstimatedInputTokens: estimatedTokensAtOverflow,
            force: true,
            signal: abortController.signal,
            overrideProfile: resolveCurrentOverrideProfile() ?? null,
            nonPersistedPrefixCount:
              ctx.contextWindowManager.nonPersistedPrefixCount,
          });
          if (emergencyResult.compacted) {
            rlog.info(
              {
                phase: "convergence",
                compactedMessages: emergencyResult.compactedMessages,
                summaryChars: emergencyResult.summaryText.length,
              },
              "Emergency mid-turn compaction succeeded — bypassing reducer tiers",
            );
            if (emergencyResult.summaryFailed !== undefined) {
              await ctx.agentLoop.compactionCircuit.recordOutcome(
                emergencyResult.summaryFailed,
                onEvent,
              );
            }
            if (emergencyResult.compacted) {
              await applySuccessfulCompaction(emergencyResult, ctx.messages);
            }
            // Clear the overflow flag and re-run the agent loop with
            // the compacted context.
            state.contextTooLargeDetected = false;
          }
        } catch (err) {
          rlog.warn(
            { phase: "convergence", err },
            "Emergency mid-turn compaction failed; continuing to reducer tiers",
          );
        }
        // If emergency compaction failed, fall through to reducer tiers.
      }

      let convergenceAttempts = 0;
      const maxAttempts = convergenceBudget.overflowRecovery.maxAttempts;

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

        ctx.emitActivityState("thinking", "context_compacting", {
          requestId: reqId,
        });
        const convergenceCompactionBasis = ctx.messages;
        const step = await reduceContextOverflow(
          convergenceCompactionBasis,
          {
            providerName: estimationProviderName,
            systemPrompt: ctx.systemPrompt,
            contextWindow: resolveCurrentContextWindowConfig(),
            targetTokens: correctedTarget,
            toolTokenBudget,
          },
          reducerState,
          (msgs, signal, opts) =>
            defaultCompact({
              manager: ctx.contextWindowManager,
              messages: msgs,
              signal,
              ...((opts ?? {}) as ContextWindowCompactOptions),
              overrideProfile: resolveCurrentOverrideProfile() ?? null,
              actorTrustClass: resolveTurnActorTrustClass(ctx),
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
          await ctx.agentLoop.compactionCircuit.recordOutcome(
            step.compactionResult.summaryFailed,
            onEvent,
          );
        }

        if (step.compactionResult?.compacted) {
          await applySuccessfulCompaction(
            step.compactionResult,
            convergenceCompactionBasis,
          );
        }

        // Only re-inject the memory-static block when ctx.messages was
        // actually stripped; otherwise the existing block is still present and
        // re-injecting would duplicate it. (The `<knowledge_base>` and NOW.md
        // blocks self-gate inside their injectors on whether they are already
        // present in `ctx.messages`.)
        const injection = await applyRuntimeInjections(ctx.messages, {
          isNonInteractive,
          modelProfile: modelProfileStr,
          actorContext,
          mode: currentInjectionMode,
          requestId: reqId,
          conversationId: ctx.conversationId,
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
        state.contextTooLargeDetected = false;
        yieldedForBudget = false;

        updatedHistory = await runAgentLoop(runMessages);

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
          if (lastRunAppendedNewMessages) {
            ctx.messages = stripInjectionsForCompaction(updatedHistory);
            markHistoryStrippedBestEffort(ctx.conversationId);
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
          ctx.emitActivityState("thinking", "context_compacting", {
            requestId: reqId,
          });
          const emergencyCompact = await defaultCompact({
            manager: ctx.contextWindowManager,
            messages: ctx.messages,
            signal: abortController.signal,
            force: true,
            minKeepRecentUserTurns: 0,
            overrideProfile: resolveCurrentOverrideProfile() ?? null,
          });
          // Only track when the summary LLM actually ran; `force: true`
          // bypasses the auto-threshold gate but not the early-return paths.
          if (emergencyCompact.summaryFailed !== undefined) {
            await ctx.agentLoop.compactionCircuit.recordOutcome(
              emergencyCompact.summaryFailed,
              onEvent,
            );
          }
          if (emergencyCompact.compacted) {
            await applySuccessfulCompaction(emergencyCompact, ctx.messages);
          }

          // Only re-inject the memory-static block when ctx.messages was
          // actually stripped; otherwise the existing block is still present.
          // (The `<knowledge_base>`, NOW.md, and v2 static `<info>` blocks
          // self-gate inside their injectors on whether they are already
          // present in `ctx.messages`.)
          const injection = await applyRuntimeInjections(ctx.messages, {
            isNonInteractive,
            modelProfile: modelProfileStr,
            actorContext,
            mode: currentInjectionMode,
            requestId: reqId,
            conversationId: ctx.conversationId,
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
          state.contextTooLargeDetected = false;

          updatedHistory = await runAgentLoop(runMessages);
        }
        // action === "fail_gracefully" falls through to the final error below
      }

      // Final fallback: all recovery paths exhausted
      if (state.contextTooLargeDetected) {
        const classified = classifyConversationError(
          new Error("context_length_exceeded"),
          { phase: "agent_loop" },
        );
        await emitTerminalExit?.("context_too_large");
        pendingCheckpointYield = null;
        onEvent(buildConversationErrorMessage(ctx.conversationId, classified));
      } else if (yieldedForBudget && !abortController.signal.aborted) {
        // The auto_compress_latest_turn rerun (action === "auto_compress_latest_turn"
        // above) reset `contextTooLargeDetected` to false before its final
        // `agentLoop.run`, so the context-too-large branch above won't fire
        // even when that rerun yields at the mid-loop budget checkpoint with
        // no further recovery layer to re-enter. Without surfacing this here,
        // the turn terminates silently — the inspector sees `agent_loop_exit_reason
        // = NULL` and the user sees no message at all (just a "ghost" turn).
        //
        // Unlike provider-error persistence at L3091 — which only fires when
        // the loop produced NO assistant output — budget_yield_unrecovered
        // typically yields AFTER one or more successful tool-use iterations,
        // so `hasAssistantResponse` is true and that path would skip us. We
        // capture the classification here so the live SSE event fires
        // immediately, and persist a dedicated notice row below — after the
        // pendingToolResults flush — so the transcript reads as: tool-use →
        // tool results → "I couldn't fit the next step…" notice. Persisting
        // earlier would orphan an assistant(tool_use) from its user(tool_result),
        // breaking provider adjacency on replay.
        budgetYieldClassification = budgetYieldUnrecoveredClassification();
        onEvent(
          buildConversationErrorMessage(
            ctx.conversationId,
            budgetYieldClassification,
          ),
        );
      }
    }

    if (state.deferredOrderingError) {
      const classified = classifyConversationError(
        new Error(state.deferredOrderingError),
        { phase: "agent_loop" },
      );
      onEvent(buildConversationErrorMessage(ctx.conversationId, classified));
    }

    // Flush remaining tool results. On a normal turn these drain at the next
    // `message_complete`; an aborted or yielded loop exits with them still
    // buffered, so finalize the (possibly already on-arrival-reserved) grouped
    // row here rather than writing a duplicate.
    if (state.pendingToolResults.size > 0) {
      const toolResultMetadata = {
        ...provenanceFromTrustContext(ctx.trustContext),
        userMessageChannel: capturedTurnChannelContext.userMessageChannel,
        assistantMessageChannel:
          capturedTurnChannelContext.assistantMessageChannel,
        userMessageInterface: capturedTurnInterfaceContext.userMessageInterface,
        assistantMessageInterface:
          capturedTurnInterfaceContext.assistantMessageInterface,
      };
      await finalizePendingToolResultRow(
        state,
        ctx.conversationId,
        toolResultMetadata,
        rlog,
      );
    }

    // Persist the budget_yield_unrecovered notice now that any pending
    // tool_results have flushed. The SSE event already fired upstream; this
    // makes the row durable in the right position: tool-use → tool-results →
    // notice. Doing it earlier (e.g. at the detection site) would land the
    // assistant row between a tool_use and its tool_result and break provider
    // adjacency on replay.
    if (budgetYieldClassification && !abortController.signal.aborted) {
      const yieldNoticeMessage = createAssistantMessage(
        budgetYieldClassification.userMessage,
      );
      const yieldNoticeMetadata = {
        ...provenanceFromTrustContext(ctx.trustContext),
        userMessageChannel: capturedTurnChannelContext.userMessageChannel,
        assistantMessageChannel:
          capturedTurnChannelContext.assistantMessageChannel,
        userMessageInterface: capturedTurnInterfaceContext.userMessageInterface,
        assistantMessageInterface:
          capturedTurnInterfaceContext.assistantMessageInterface,
      };
      let yieldNoticePersistedId: string | null = null;
      try {
        const yieldRow = await addMessage(
          ctx.conversationId,
          "assistant",
          JSON.stringify(yieldNoticeMessage.content),
          { metadata: yieldNoticeMetadata },
        );
        yieldNoticePersistedId = yieldRow.id;
      } catch (err) {
        // Non-fatal — a DB hiccup must not escalate a budget-yield exit into
        // a turn-level throw. The live SSE event was already emitted, so the
        // user still sees the notice this turn even if the durable row missed.
        rlog.warn(
          { err },
          "Failed to persist budget_yield_unrecovered notice (non-fatal)",
        );
      }
      // Record a synthetic `llm_request_logs` row for the yield so the
      // inspector's call rail surfaces a clickable, distinctly-rendered
      // entry for the failure itself. Without this row, the loop yields
      // silently — the user sees the notice in chat but the inspector
      // call list ends at the last actual LLM call with no way to scope
      // the "what compactions led to this failure?" question to the
      // yield event.
      //
      // Recorded *before* emitTerminalExit so the synthetic row exists
      // by the time the dispatcher's post-loop hook runs. The row
      // already carries `agent_loop_exit_reason` at insert time, so
      // `setAgentLoopExitReasonOnLatestLog`'s IS NULL guard skips it
      // and stamps the prior real mainAgent call instead — preserving
      // the existing "latest LLM call carries the exit reason"
      // invariant other consumers depend on.
      //
      // `preparedRequest` snapshots the best-known LLM request state
      // at yield time — `updatedHistory` (the conversation state the
      // next call would have been built from) plus the input-token
      // budget that just failed. Mirrors the role of `request_payload`
      // on real LLM-call rows; the notice text lives on
      // `response_payload`.
      if (yieldNoticePersistedId !== null && budgetYieldClassification) {
        try {
          recordSyntheticAgentErrorMessageLog({
            conversationId: ctx.conversationId,
            messageId: yieldNoticePersistedId,
            exitReason: "budget_yield_unrecovered",
            noticeText: budgetYieldClassification.userMessage,
            preparedRequest: {
              messages: updatedHistory,
              maxInputTokensBudget: resolveCurrentMaxInputTokens() ?? null,
            },
            createdAt: Date.now(),
          });
        } catch (err) {
          rlog.warn(
            { err },
            "Failed to record budget_yield_unrecovered synthetic call log (non-fatal)",
          );
        }
      }
      await emitTerminalExit?.("budget_yield_unrecovered");
    }

    // Reconstruct history
    const newMessages = lastRunNewMessages.map((msg) => {
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
      // Drop any reservation stranded by the failed LLM call before
      // inserting the synthetic error message. The B3 pre-allocation
      // path reserves an empty assistant row at `llm_call_started`;
      // when the call exits through the provider-error branch (no
      // `message_complete`), `assistantRowAwaitingFinalization` stays
      // true. Without this delete the transcript would carry both the
      // empty reserved row AND the error message — and downstream sync
      // (`syncLastAssistantMessageToDisk`) would mis-target the empty
      // row. After delete we set `lastAssistantMessageId` to the new
      // error row's id so the post-loop emission paths still point at
      // a real message.
      if (
        state.assistantRowAwaitingFinalization &&
        state.lastAssistantMessageId
      ) {
        try {
          deleteMessageById(state.lastAssistantMessageId);
        } catch (err) {
          rlog.warn(
            { err, messageId: state.lastAssistantMessageId },
            "Failed to clean up stranded reserved assistant row on provider-error path (non-fatal)",
          );
        }
      }
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
      const errorRow = await addMessage(
        ctx.conversationId,
        "assistant",
        JSON.stringify(errorAssistantMessage.content),
        { metadata: errChannelMeta },
      );
      persistedErrorAssistantMessage = true;
      // Repoint `lastAssistantMessageId` at the synthetic error row so the
      // post-loop sync, attachment resolution, and `message_complete`/
      // `generation_handoff` emissions all reference a real, persisted
      // message id. The previous reservation (if any) was already deleted
      // above. Mark finalization complete so the next LLM call in this run
      // (or a downstream handler) doesn't try to clean up an id that
      // already corresponds to a finalized row.
      state.lastAssistantMessageId = errorRow.id;
      state.assistantRowAwaitingFinalization = false;
      newMessages.push(errorAssistantMessage);
      // Pipe the just-assigned message id into any orphaned LLM request log
      // row(s) for this turn. The success path links rows via
      // `handleMessageComplete` -> `backfillMessageIdOnLogs`, but provider-
      // failure turns never fire `message_complete` (the synthetic assistant
      // message is persisted directly above), so without this call the rows
      // from `handleProviderError` stay with `message_id IS NULL` and a
      // later turn's backfill sweep would wrong-attach them to that turn's
      // assistant message. Scope is per-conversation, so concurrent runs on
      // other conversations cannot collide. Non-fatal — a DB hiccup must
      // not escalate a provider rejection into a turn-level throw.
      try {
        backfillMessageIdOnLogs(ctx.conversationId, errorRow.id);
      } catch (err) {
        rlog.warn(
          { err },
          "Failed to backfill message_id on provider-error LLM request logs (non-fatal)",
        );
      }
      // Do NOT send assistant_text_delta here — handleProviderError already
      // emitted a conversation_error event for this same error text, and the
      // client renders it as an InlineChatErrorAlert. Sending a text delta
      // would create a duplicate plain-text bubble below the alert card.
    }

    // Base persisted into `ctx.messages` is the loop's own returned history
    // (minus the tail it appended this run), with the cleaned `newMessages`
    // re-appended on top. Sourcing the base from the loop keeps it in lockstep
    // with any in-loop compaction without the orchestrator maintaining a
    // parallel snapshot across re-entry sites.
    const loopBase = updatedHistory.slice(
      0,
      updatedHistory.length - lastRunNewMessages.length,
    );
    let restoredHistory = [...loopBase, ...newMessages];

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
        maxTokens: resolveCurrentMaxInputTokens(),
      },
      {
        callSite: turnCallSite,
        overrideProfile: resolveCurrentOverrideProfile() ?? null,
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
      ctx.emitActivityState("idle", "generation_cancelled", {
        anchor: "global",
        requestId: reqId,
      });
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
      publishLoopMessagesChanged();
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
        if (pendingCheckpointYield === "budget") {
          await emitTerminalExit?.("aborted_after_checkpoint");
          pendingCheckpointYield = null;
        }
        ctx.emitActivityState("idle", "generation_cancelled", {
          anchor: "global",
          requestId: reqId,
        });
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
        publishLoopMessagesChanged();
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
        publishLoopMessagesChanged();
      } else {
        ctx.emitActivityState("idle", "message_complete", {
          anchor: "global",
          requestId: reqId,
        });
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
        publishLoopMessagesChanged();
      }
    }
  } catch (err) {
    const errorCtx = {
      phase: "agent_loop" as const,
      aborted: abortController.signal.aborted,
    };
    if (isUserCancellation(err, errorCtx)) {
      if (pendingCheckpointYield === "budget") {
        await emitTerminalExit?.("aborted_after_checkpoint");
        pendingCheckpointYield = null;
      }
      ctx.emitActivityState("idle", "generation_cancelled", {
        anchor: "global",
        requestId: reqId,
      });
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
      publishLoopMessagesChanged();
    } else {
      ctx.emitActivityState("idle", "error_terminal", {
        anchor: "global",
        requestId: reqId,
      });
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
      publishLoopMessagesChanged();
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

      // Recompute relationship-state.json at turn boundary (fire-and-forget).
      // The writer swallows its own errors, but we still guard with catch()
      // here so a regression in the writer can never bubble out of the
      // agent loop and reject an otherwise-complete turn.
      void writeRelationshipState().catch(() => {});
    }

    ctx.profiler.emitSummary(ctx.traceEmitter, reqId);

    ctx.abortController = null;
    ctx.setProcessing(false);
    ctx.onConfirmationOutcome = undefined;
    ctx.surfaceActionRequestIds.delete(ctx.currentRequestId ?? "");
    ctx.approvedViaPromptThisTurn = false;
    ctx.currentRequestId = undefined;
    ctx.currentActiveSurfaceId = undefined;
    ctx.allowedToolNames = undefined;
    ctx.diskPressureCleanupModeActive = false;
    ctx.preactivatedSkillIds = undefined;
    ctx.currentTurnOverrideProfile = undefined;
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
  ctx: Pick<Conversation, "conversationId" | "provider" | "usageStats">,
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
 * Minimal context shape consumed by `applyCompactionResult`, satisfied by
 * `Conversation` via structural typing, so the helper can back both the 5
 * agent-loop auto-compaction sites and the single `forceCompact`
 * user-initiated site.
 */
export interface CompactionApplyContext {
  readonly conversationId: string;
  messages: Message[];
  contextCompactedMessageCount: number;
  contextCompactedAt: number | null;
  contextSummary: string | null;
  slackContextCompactionWatermarkTs: string | null;
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
  // Compaction operates on the in-context history. Untrusted actor views
  // render that history unsliced (boundary 0); trusted views start past the
  // already-compacted prefix (the mirrored DB count). Advance from that
  // in-context boundary rather than the raw mirror so the persisted count
  // stays consistent with what the new summary represents and never
  // double-counts an unsliced untrusted view.
  const inContextCompactedCount = isUntrustedTrustClass(
    ctx.trustContext?.trustClass,
  )
    ? 0
    : ctx.contextCompactedMessageCount;
  ctx.contextCompactedMessageCount =
    inContextCompactedCount + result.compactedPersistedMessages;
  ctx.contextSummary = result.summaryText;
  const compactedAt = Date.now();
  ctx.contextCompactedAt = compactedAt;
  await ctx.graphMemory.onCompacted(result.compactedPersistedMessages);
  updateConversationContextWindow(
    ctx.conversationId,
    result.summaryText,
    ctx.contextCompactedMessageCount,
  );
  markHistoryStrippedBestEffort(ctx.conversationId);
  if (options.slackContextCompactionWatermarkTs) {
    updateConversationSlackContextWatermark(
      ctx.conversationId,
      options.slackContextCompactionWatermarkTs,
      compactedAt,
    );
    ctx.slackContextCompactionWatermarkTs =
      options.slackContextCompactionWatermarkTs;
  }
  enqueueAutoAnalysisOnCompaction(
    ctx.conversationId,
    ctx.trustContext?.trustClass,
  );
  enqueueMemoryRetrospectiveOnCompaction(
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
