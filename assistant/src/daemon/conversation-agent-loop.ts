/**
 * Agent loop execution extracted from Conversation.runAgentLoop.
 *
 * This module contains the core agent loop orchestration: pre-flight
 * setup, event handling, retry logic, history reconstruction, and
 * completion event emission.  The Conversation class delegates its
 * runAgentLoop method here, passing itself as the loop context.
 */

import { v4 as uuid } from "uuid";

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
  resolveEffectiveProfileKey,
  resolveProfilelessModelKey,
} from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { writeRelationshipState } from "../home/relationship-state-writer.js";
import type { UserPromptSubmitInputContext } from "../hooks/types.js";
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
} from "../persistence/conversation-crud.js";
import { isReplaceableTitle } from "../persistence/conversation-title-service.js";
import {
  backfillMessageIdOnLogs,
  recordSyntheticAgentErrorMessageLog,
} from "../persistence/llm-request-log-store.js";
import { HOOKS } from "../plugin-api/constants.js";
import type { ConversationGraphMemory } from "../plugins/defaults/memory/graph/conversation-graph-memory.js";
import { enqueueMemoryRetrospectiveOnCompaction } from "../plugins/defaults/memory/memory-retrospective-enqueue.js";
import { runHook } from "../plugins/pipeline.js";
import type { ContentBlock, Message } from "../providers/types.js";
import type { Provider } from "../providers/types.js";
import { resolveCapabilities } from "../runtime/capabilities.js";
import { enqueueAutoAnalysisOnCompaction } from "../runtime/services/auto-analysis-enqueue.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";
import type { ActivationMomentParam } from "../telemetry/activation-funnel.js";
import { stampTurnOutcome } from "../telemetry/turn-outcome.js";
import {
  emitToolProfilingSummary,
  startToolProfilingRequest,
} from "../tools/tool-profiler.js";
import type { UsageActor } from "../usage/actors.js";
import { getLogger } from "../util/logger.js";
import { timeAgo } from "../util/time.js";
import { getWorkspaceGitService } from "../workspace/git-service.js";
import { commitTurnChanges } from "../workspace/turn-commit.js";
import { ABORT_WATCHDOG_MS } from "./abort-watchdog.js";
import { cleanAssistantContent } from "./assistant-attachments.js";
import { conversationSupportsDynamicUi } from "./channel-ui-capability.js";
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
import {
  clearConversationNotices,
  drainConversationNotices,
} from "./conversation-notices.js";
import {
  getSlackCompactionWatermarkForPrefix,
  loadSlackChronologicalContext,
  resolveTurnInboundActorContext,
  type SlackChronologicalContext,
} from "./conversation-runtime-assembly.js";
import { markSurfaceCompleted } from "./conversation-surfaces.js";
import { runDeferredTurnTail } from "./conversation-turn-finalize.js";
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
import type { TrustContext } from "./trust-context-types.js";
import { resolveTurnCallSite } from "./turn-call-site.js";
import { TurnLatencyTracker } from "./turn-latency-tracker.js";

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
  /**
   * Commit-timing activation-rail tag (daemon-only). Persisted into the
   * server-side `ui_surface` history block — NOT the client `ui_surface_show`
   * message — so `restoreSurfaceStateFromHistory` can rehydrate the tag and a
   * post-reload commit still records its funnel milestone. Show-timing moments
   * record at render and are never stored here.
   */
  activationMoment?: ActivationMomentParam;
}

// ── abort watchdog ───────────────────────────────────────────────────

/**
 * Race `work` against an abort watchdog. The watchdog is a backstop that drives
 * an aborted turn to its `finally` even if some awaited operation fails to
 * observe the abort signal. Abort is otherwise cooperative and already wired
 * into the slow paths: the provider call forwards the signal to its
 * HTTP/streaming fetch, and tool execution races the signal so a stuck tool
 * can't block cancellation. The watchdog only fires when a future code path
 * silently ignores abort — without it, such a path would hang the loop forever
 * and latch the conversation's `processing` flag true (the wedged "Thinking…"
 * indicator). It is defense-in-depth, not the primary mechanism: in the common
 * case abort settles in-flight work in well under a second, so ABORT_WATCHDOG_MS
 * is ample headroom for a cooperative unwind while still releasing a genuinely
 * wedged turn promptly.
 *
 * The watchdog stays disarmed until the signal fires; once it does, the turn has
 * `timeoutMs` to settle before the watchdog rejects with the signal's own abort
 * reason so the caller unwinds to its `finally` and the reason classifies as a
 * user cancellation downstream. The abandoned `work` promise keeps running
 * detached — its eventual rejection is swallowed so it can't surface as an
 * unhandled rejection.
 */
async function withAbortWatchdog<T>(
  work: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  onFire: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    const arm = () => {
      timer = setTimeout(() => {
        onFire();
        // Propagate the signal's own reason (an `AbortReason` for daemon-owned
        // cancels) so the loop's catch classifies this as a user cancellation;
        // fall back to a tagged AbortError when the signal carries no reason.
        reject(
          signal.reason ??
            new DOMException("The operation was aborted", "AbortError"),
        );
      }, timeoutMs);
    };
    if (signal.aborted) {
      arm();
    } else {
      onAbort = arm;
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([work, watchdog]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    void work.catch(() => {});
  }
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
     * True when the triggering message is a transcript-suppressed machine
     * signal (`metadata.hidden`). Forwarded to the user-prompt-submit hook
     * context so prompt-as-user-speech consumers (title generation) skip
     * the turn.
     */
    isHiddenPrompt?: boolean;
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
    /**
     * Float `overrideProfile` above call-site layers for non-main-agent call
     * sites. Used when a caller explicitly pins a background run to a profile.
     */
    forceOverrideProfile?: boolean;
    /**
     * Origin tag of this turn (the conversation's `TitleOrigin`, e.g.
     * "memory_consolidation"), threaded from `runBackgroundJob`. Exposed on
     * the conversation so tool execution can scope narrow non-interactive
     * permission auto-grants to a specific internal background origin. Unset
     * for normal user-initiated turns.
     */
    requestOrigin?: string;
    /**
     * Firing's `cron_runs.id` stamped onto this turn's usage rows so a
     * scheduled execute turn attributes its LLM spend to that firing.
     */
    cronRunId?: string | null;
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

  // Re-resolve the system prompt under the snapshots just set and push it into
  // the loop when the persona changed. The loop reuses the prompt frozen at
  // construction otherwise, so a flow that binds trust after construction (a
  // voice call resolves the caller only after `getOrCreateConversation`) would
  // run the whole conversation under the construction-time persona.
  ctx.syncLoopSystemPrompt();

  const abortController = ctx.abortController;
  const reqId = ctx.currentRequestId ?? uuid();
  // First-token latency instrumentation for this turn. Stamped here at the
  // earliest point of turn processing, then through the prompt-submit hook
  // (memory/context retrieval) and the agent loop's per-call marks.
  const latencyTracker = new TurnLatencyTracker();
  latencyTracker.mark("turn_start");
  const rlog = log.child({
    conversationId: ctx.conversationId,
    requestId: reqId,
  });
  let yieldedForHandoff = false;
  // The messages the most recent agent-loop run appended on top of its base —
  // the loop's own new-output boundary, persisted as this turn's new messages.
  let lastRunNewMessages: Message[] = [];
  // Terminal context-overflow outcome the agent loop emitted this turn (it
  // drives recovery through the compaction reduction ladder and classifies the
  // exit). The wrapper reads it to persist the matching user-facing notice
  // after the tool-result flush; null when the turn did not end in overflow.
  let overflowTerminalReason:
    | "context_too_large"
    | "budget_yield_unrecovered"
    | null = null;
  // Set when the loop ends the turn as `budget_yield_unrecovered`. SSE emission
  // happens immediately at the detection site; assistant-row persistence is
  // deferred until after the pendingToolResults flush so we don't orphan
  // tool_use/tool_result pairs in the durable history.
  let budgetYieldClassification: ReturnType<
    typeof budgetYieldUnrecoveredClassification
  > | null = null;
  let emitTerminalExit:
    | ((reason: AgentLoopExitReason) => Promise<void>)
    | null = null;

  // Default user-initiated turns to the `mainAgent` call site; other invocation
  // contexts (heartbeat, filing, analyze, etc.) pass their own `callSite`. The
  // provider layer resolves provider/model/maxTokens via `resolveCallSiteConfig`,
  // picking up any user overrides under `llm.callSites.<id>` (falling back to
  // `llm.default` when absent). `resolveTurnCallSite` keeps subagent
  // conversations on `subagentSpawn` when no call site is supplied.
  const turnCallSite = resolveTurnCallSite(options?.callSite, ctx);
  // Expose the turn's call site on the live conversation so the runtime
  // injection assembly self-resolves it for the turn's plugin contexts.
  ctx.currentCallSite = turnCallSite;

  // Expose the turn's request origin (e.g. "memory_consolidation") on the live
  // conversation so the tool context — and through it `buildPolicyContext` —
  // can scope narrow non-interactive permission auto-grants to a specific
  // internal background origin. Unset for normal user turns.
  ctx.currentTurnRequestOrigin = options?.requestOrigin;

  // Firing's run id for this turn's usage attribution. Kept local (not on the
  // conversation) so a reused conversation attributes each turn to its own
  // firing.
  const turnCronRunId = options?.cronRunId ?? null;

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

  const turnOverrideProfile = userExplicitOverride;
  const forceOverrideProfile = options?.forceOverrideProfile === true;

  const readCurrentOverrideProfile = (): string | undefined =>
    options?.overrideProfile ?? resolveOverrideProfile(ctx);

  // Best-effort attribution for error classification: names the resolved
  // connection and profile so credential/connection errors point at the
  // exact slot to fix instead of a generic banner. Resolution can itself
  // throw on a broken config — attribution must never mask the real error.
  const turnErrorAttribution = (): {
    connectionName?: string;
    profileName?: string;
  } => {
    try {
      const overrideProfile = readCurrentOverrideProfile();
      const resolveOpts = {
        overrideProfile,
        forceOverrideProfile,
        selectionSeed: ctx.conversationId,
      };
      const resolved = resolveCallSiteConfig(
        turnCallSite,
        config.llm,
        resolveOpts,
      );
      const profileName = resolveEffectiveProfileKey(
        turnCallSite,
        config.llm,
        resolveOpts,
      );
      return {
        ...(resolved.provider_connection
          ? { connectionName: resolved.provider_connection }
          : {}),
        ...(profileName ? { profileName } : {}),
      };
    } catch {
      return {};
    }
  };

  const effectiveContextWindow = resolveEffectiveContextWindow({
    llm: config.llm,
    callSite: turnCallSite,
    overrideProfile: turnOverrideProfile ?? undefined,
    forceOverrideProfile,
    selectionSeed: ctx.conversationId,
  });
  let currentEffectiveContextWindow: EffectiveContextWindow =
    effectiveContextWindow;
  let currentContextWindowConfig = contextWindowConfigFromEffective(
    resolveCallSiteConfig(turnCallSite, config.llm, {
      overrideProfile: turnOverrideProfile ?? undefined,
      forceOverrideProfile,
      selectionSeed: ctx.conversationId,
    }).contextWindow,
    currentEffectiveContextWindow,
  );
  ctx.contextWindowManager.updateConfig(currentContextWindowConfig);

  let appliedOverrideProfile = turnOverrideProfile;
  const refreshCurrentProfileState = (): string | undefined => {
    const currentOverrideProfile = readCurrentOverrideProfile();
    if (currentOverrideProfile !== appliedOverrideProfile) {
      currentEffectiveContextWindow = resolveEffectiveContextWindow({
        llm: config.llm,
        callSite: turnCallSite,
        overrideProfile: currentOverrideProfile,
        forceOverrideProfile,
        selectionSeed: ctx.conversationId,
      });
      currentContextWindowConfig = contextWindowConfigFromEffective(
        resolveCallSiteConfig(turnCallSite, config.llm, {
          overrideProfile: currentOverrideProfile,
          forceOverrideProfile,
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

    ctx.currentTurnOverrideProfile = currentOverrideProfile;
    return currentOverrideProfile;
  };
  const resolveCurrentOverrideProfile = (): string | undefined =>
    refreshCurrentProfileState();
  const resolveCurrentMaxInputTokens = (): number => {
    refreshCurrentProfileState();
    return currentEffectiveContextWindow.maxInputTokens;
  };
  /**
   * The agent loop's window into the wrapper's current effective context
   * window. The loop reads `maxInputTokens` for tool-result truncation and
   * `overflowRecovery` for its mid-loop budget gate, applying the long-history
   * safety-margin bump itself off its own running history. Resolved fresh on
   * each access so a mid-turn profile change is reflected.
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
    if (live) {
      return live;
    }
    const origin = getConversationOriginChannel(ctx.conversationId);
    if (origin) {
      return { userMessageChannel: origin, assistantMessageChannel: origin };
    }
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
    if (live) {
      return live;
    }
    const origin = getConversationOriginInterface(ctx.conversationId);
    if (origin) {
      return {
        userMessageInterface: origin,
        assistantMessageInterface: origin,
      };
    }
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
  // Expose the resolved turn-level interactivity to tool execution so tools
  // (e.g. ask_question) see whether a human is present to answer, rather than
  // re-deriving it from live client state that misclassifies a scheduled turn
  // running on a client-attached conversation.
  ctx.currentTurnIsNonInteractive = isNonInteractive;
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

  startToolProfilingRequest(ctx.conversationId);
  let turnStarted = false;
  const state = createEventHandlerState();
  let persistedErrorAssistantMessage = false;
  let deletedReservedAssistantMessage = false;
  // Abnormal turn outcome for telemetry, stamped onto the user-message row in
  // the `finally` (before processing clears, so the reporter's settled-turn
  // barrier guarantees the stamp ships with the turn event). Unset = the turn
  // replied normally and carries no stamp.
  let abnormalOutcome:
    | { outcome: "failed" | "cancelled"; failureCode?: string }
    | undefined;
  // True once a replied terminal SSE (message_complete / generation_handoff)
  // has been emitted. Guards the catch block: an error thrown afterwards
  // (deferred turn-tail bookkeeping) must not relabel a visibly-replied turn.
  let turnReplied = false;

  const publishLoopMessagesChanged = (): void => {
    if (
      state.lastAssistantMessageId ||
      state.persistedToolUseIds.size > 0 ||
      persistedErrorAssistantMessage ||
      deletedReservedAssistantMessage
    ) {
      publishConversationMessagesChanged(ctx.conversationId);
    }
  };

  try {
    if (diskPressureDecision.action === "block") {
      const message = formatDiskPressureBlockedMessage();
      // The user message is already persisted, so this turn will be reported
      // by the telemetry scan; label it failed (the early return still runs
      // the `finally`, which stamps `abnormalOutcome`).
      abnormalOutcome = {
        outcome: "failed",
        failureCode: DISK_PRESSURE_ERROR_CODE,
      };
      rlog.warn(
        { reason: diskPressureDecision.reason },
        "Blocked turn during disk pressure cleanup mode",
      );
      ctx.emitActivityState("idle", "error_terminal", {
        anchor: "global",
        requestId: reqId,
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
        if (entry.surfaceType === "dynamic_page") {
          continue;
        }
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
        if (!isSlackConversation) {
          return null;
        }
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
      if (!isSlackConversation || compactedMessages <= 0) {
        return null;
      }
      const context = slackChronologicalContext;
      if (!context) {
        return null;
      }
      if (messages !== context.messages) {
        return null;
      }
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
        cronRunId: turnCronRunId,
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

    // Unified `<turn_context>` actor input for this turn (model-facing grounding
    // metadata; the conversation runtime context remains the source for policy
    // gating). Resolved once at turn start and frozen onto the conversation so
    // the post-compaction hook re-emits this same value during in-loop recovery
    // instead of re-resolving against contact/member registry state that may
    // have drifted mid-turn.
    const actorContext = resolveTurnInboundActorContext(ctx.trustContext);
    ctx.currentTurnInboundActorContext = actorContext;

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

    // Freeze the turn-start client OS for the same anti-race reason as the
    // timezone above: the live `ctx.clientOs` is re-applied from transport
    // whenever a newer message for this conversation arrives mid-turn, so the
    // assembly reads this frozen copy to avoid leaking a queued message's
    // `client_os` into the in-flight turn.
    ctx.currentTurnClientOs = ctx.clientOs ?? undefined;

    // Resolve the effective profile key for this turn and detect changes.
    // `modelProfileKey` is the actual profile used for this turn. The
    // notice key is narrower: it only marks turns where runtime context should
    // remind the model that the profile changed.
    const effectiveProfileKey =
      turnOverrideProfile ??
      config.llm.activeProfile ??
      resolveDefaultProfileKey("mainAgent", config.llm) ??
      resolveProfilelessModelKey(turnCallSite, config.llm, {
        ...(turnOverrideProfile != null
          ? { overrideProfile: turnOverrideProfile }
          : {}),
        ...(forceOverrideProfile ? { forceOverrideProfile: true } : {}),
        selectionSeed: ctx.conversationId,
      });
    const lastNotified = ctx.lastNotifiedInferenceProfile;
    const modelProfileKey = effectiveProfileKey;
    const modelProfileNoticeKey =
      modelProfileKey !== lastNotified ? modelProfileKey : null;
    ctx.currentTurnModelProfileNoticeKey = modelProfileNoticeKey ?? undefined;
    // Persist the notice only after delivery; hooks still receive
    // `modelProfileKey` as the effective profile for this turn.
    if (modelProfileNoticeKey != null) {
      // Record the notification for persistence on delivery rather than here:
      // the model only "learns" the profile once it receives this turn
      // context, signalled by the first `message_complete`. Persisting inline
      // would mark the profile notified even if the turn is cancelled or fails
      // before the model ever sees the notice.
      state.pendingNotifiedInferenceProfile = modelProfileNoticeKey;
    }

    // user-prompt-submit hook chain. Fires once per user turn at the primary
    // `agentLoop.run` (the re-entry / retry calls further down do not refire it
    // — they're not new user submissions), before the loop runs so the
    // hook-assembled messages are part of its input. Memory retrieval runs
    // first — fetching PKB / NOW.md / memory-graph outputs, persisting its own
    // side effects (injected-block metadata, recall log, `memory_recalled`
    // event), and assembling the turn's runtime-injection blocks onto the
    // history — followed by history repair and title generation, which see the
    // fully injected history. Plugins may mutate `ctx.latestMessages` in place
    // OR return a new context with a fresh array; `runHook` forwards whichever
    // the chain settles on, in plugin registration order. The loop then reports
    // its own appended output via `AgentLoopRunResult.newMessages`, which
    // persistence consumes.
    const userPromptCtx: UserPromptSubmitInputContext = {
      conversationId: ctx.conversationId,
      userMessageId,
      requestId: reqId,
      prompt: options?.titleText ?? content,
      isHiddenPrompt: options?.isHiddenPrompt === true,
      originalMessages: Object.freeze([...ctx.messages]),
      latestMessages: ctx.messages,
      modelProfileKey,
      isNonInteractive,
    };
    latencyTracker.mark("prompt_hook_start");
    const finalUserPromptCtx = await runHook(
      HOOKS.USER_PROMPT_SUBMIT,
      userPromptCtx,
    );
    latencyTracker.mark("prompt_hook_end");
    const runMessages = finalUserPromptCtx.latestMessages;

    // Reset the manager's turn-scoped overflow-recovery ladder at the turn
    // boundary so a new turn starts the ladder fresh from the emergency rung.
    ctx.contextWindowManager.resetOverflowRecovery();

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
      latencyTracker,
    };
    const eventHandler = (event: AgentEvent): Promise<void> => {
      if (
        event.type === "agent_loop_exit" &&
        (event.reason === "context_too_large" ||
          event.reason === "budget_yield_unrecovered")
      ) {
        overflowTerminalReason = event.reason;
        if (event.reason === "budget_yield_unrecovered") {
          // The loop emits this terminal exit inline as it breaks. Stamping the
          // exit reason now would land on the last real LLM call before the
          // wrapper has recorded the synthetic yield row below — and the
          // wrapper then stamps again after that row exists, double-stamping
          // two real rows. Capture the reason here and let the wrapper drive a
          // single stamp via `emitTerminalExit` once the synthetic row is in
          // place, preserving the "latest LLM call carries the exit reason"
          // invariant.
          return Promise.resolve();
        }
      }
      return dispatchAgentEvent(state, deps, event);
    };
    emitTerminalExit = async (reason: AgentLoopExitReason): Promise<void> => {
      await dispatchAgentEvent(state, deps, {
        type: "agent_loop_exit",
        reason,
      });
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
     * Shared closure: runs the agent loop with the wrapper's turn context and
     * maps the loop's returned checkpoint pause-reason into the wrapper's yield
     * bookkeeping. Returns the updated history so call sites consume it exactly
     * as before. Pass `compactInPlace` only for the primary run: the loop then
     * runs its budget gate before the first call (subsuming the proactive
     * turn-start compaction) and compacts in place whenever the gate trips.
     * Reruns omit it and skip the first-call gate.
     */
    const runAgentLoop = async (
      msgs: Message[],
      compactInPlace = false,
    ): Promise<Message[]> => {
      const watchdogMs = ctx.abortWatchdogMs ?? ABORT_WATCHDOG_MS;
      const { history, exitReason, newMessages } = await withAbortWatchdog(
        ctx.agentLoop.run({
          messages: msgs,
          onEvent: eventHandler,
          signal: abortController.signal,
          requestId: reqId,
          onCheckpoint,
          callSite: turnCallSite,
          supportsDynamicUi: conversationSupportsDynamicUi(ctx),
          trust: loopTrust,
          overrideProfile: turnOverrideProfile,
          ...(forceOverrideProfile ? { forceOverrideProfile: true } : {}),
          resolveOverrideProfile: resolveCurrentOverrideProfile,
          resolveContextWindow,
          compactInPlace,
          isNonInteractive,
          modelProfileKey,
          latencyTracker,
          ...(ctx.modelOverride ? { model: ctx.modelOverride } : {}),
        }),
        abortController.signal,
        watchdogMs,
        () =>
          rlog.error(
            {
              conversationId: ctx.conversationId,
              requestId: reqId,
              timeoutMs: watchdogMs,
            },
            "Abort watchdog fired — agent loop did not settle after cancel; forcing turn to finally",
          ),
      );
      lastRunNewMessages = newMessages;
      if (exitReason === "handoff") {
        yieldedForHandoff = true;
      }
      return history;
    };

    const updatedHistory = await runAgentLoop(runMessages, true);
    // Generation is done streaming. Anything awaited between here and the
    // terminal SSE is what the user perceives as the gap between the last
    // token and the composer re-enabling, so keep that window minimal.
    const generationCompletedAt = Date.now();

    rlog.info(
      { resultMessageCount: updatedHistory.length },
      "Agent loop run completed",
    );

    if (yieldedForHandoff) {
      await emitTerminalExit?.("checkpoint_handoff");
    }

    // ── Context-overflow terminal notice ───────────────────────────
    // The agent loop drives overflow recovery through the compaction plugin's
    // reduction ladder and, when the ladder is spent and the provider still
    // rejects, emits the terminal exit (`context_too_large` or
    // `budget_yield_unrecovered`) itself. The wrapper only renders the matching
    // user-facing notice. `budget_yield_unrecovered` defers its durable row to
    // after the tool-result flush below (so the transcript reads tool-use →
    // tool-results → notice), so it captures the classification here and emits
    // the live SSE event; the durable write happens further down.
    if (overflowTerminalReason === "context_too_large") {
      const classified = classifyConversationError(
        new Error("context_length_exceeded"),
        { phase: "agent_loop" },
      );
      // Exhausted-overflow exit: the reduction ladder is spent and the turn
      // ends without a real reply, so label it failed for telemetry.
      abnormalOutcome = { outcome: "failed", failureCode: classified.code };
      onEvent(buildConversationErrorMessage(ctx.conversationId, classified));
    } else if (
      overflowTerminalReason === "budget_yield_unrecovered" &&
      !abortController.signal.aborted
    ) {
      budgetYieldClassification = budgetYieldUnrecoveredClassification();
      abnormalOutcome = {
        outcome: "failed",
        failureCode: budgetYieldClassification.code,
      };
      onEvent(
        buildConversationErrorMessage(
          ctx.conversationId,
          budgetYieldClassification,
        ),
      );
    }

    const shouldEmitQueuedConversationNotices =
      !overflowTerminalReason &&
      !yieldedForHandoff &&
      !state.providerErrorUserMessage &&
      !abortController.signal.aborted;
    if (!shouldEmitQueuedConversationNotices) {
      clearConversationNotices(ctx.conversationId);
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
      if (msg.role !== "assistant") {
        return msg;
      }
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
      // The turn is terminating on the provider-error path: its only
      // assistant output (if any) is the synthetic error message persisted
      // below. Label the turn `failed` for telemetry either way.
      abnormalOutcome = {
        outcome: "failed",
        ...(state.providerErrorCode
          ? { failureCode: state.providerErrorCode }
          : {}),
      };
      // Drop any reservation stranded by the failed LLM call. The B3
      // pre-allocation path reserves an empty assistant row at
      // `llm_call_started`; when the call exits through the provider-error
      // branch (no `message_complete`), `assistantRowAwaitingFinalization`
      // stays true. Without this delete the transcript would carry an empty
      // reserved row, and downstream sync (`syncLastAssistantMessageToDisk`)
      // would target it.
      if (
        state.assistantRowAwaitingFinalization &&
        state.lastAssistantMessageId
      ) {
        try {
          deleteMessageById(state.lastAssistantMessageId);
          deletedReservedAssistantMessage = true;
          state.lastAssistantMessageId = undefined;
          state.assistantRowAwaitingFinalization = false;
        } catch (err) {
          rlog.warn(
            { err, messageId: state.lastAssistantMessageId },
            "Failed to clean up stranded reserved assistant row on provider-error path (non-fatal)",
          );
        }
      }
      if (!state.persistProviderErrorAsAssistantMessage) {
        state.assistantRowAwaitingFinalization = false;
        state.lastAssistantMessageId = undefined;
      } else {
        const errChannelMeta = {
          ...provenanceFromTrustContext(ctx.trustContext),
          userMessageChannel: capturedTurnChannelContext.userMessageChannel,
          assistantMessageChannel:
            capturedTurnChannelContext.assistantMessageChannel,
          userMessageInterface:
            capturedTurnInterfaceContext.userMessageInterface,
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
    const restoredHistory = [...loopBase, ...newMessages];

    // Persist injections in history: runtime-injected context stays on
    // historical user messages so the conversation prefix is stable for
    // Anthropic's prefix caching.  Stripping only happens during
    // compaction/overflow recovery (where a cache miss is expected).
    //
    // Post-turn tool-result truncation (spooling large results to disk and
    // shrinking the next turn's context) is deferred to `runDeferredTurnTail`
    // below. It only rewrites the in-memory history the NEXT turn is built
    // from — never the just-delivered reply — so it must not sit on the
    // critical path to the terminal SSE that re-enables the composer.
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
      turnCronRunId,
    );

    // Fast-path: when the user cancelled, skip expensive post-loop work
    // (attachment resolution) and emit the cancellation event immediately
    // so the client can re-enable the UI without delay. Disk sync and the rest
    // of the bookkeeping run in `runDeferredTurnTail` after this SSE.
    if (abortController.signal.aborted) {
      abnormalOutcome = { outcome: "cancelled" };
      ctx.emitActivityState("idle", "generation_cancelled", {
        anchor: "global",
        requestId: reqId,
      });
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

      // Re-check: the user may have cancelled during attachment resolution
      if (abortController.signal.aborted) {
        abnormalOutcome = { outcome: "cancelled" };
        ctx.emitActivityState("idle", "generation_cancelled", {
          anchor: "global",
          requestId: reqId,
        });
        onEvent({
          type: "generation_cancelled",
          conversationId: ctx.conversationId,
        });
        publishLoopMessagesChanged();
      } else if (yieldedForHandoff) {
        turnReplied = true;
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
        turnReplied = true;
        ctx.emitActivityState("idle", "message_complete", {
          anchor: "global",
          requestId: reqId,
        });
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
        if (shouldEmitQueuedConversationNotices) {
          for (const notice of drainConversationNotices(ctx.conversationId)) {
            onEvent(notice);
          }
        }
        publishLoopMessagesChanged();
      }
    }

    // The terminal SSE for this turn has now been emitted (message_complete,
    // generation_handoff, or generation_cancelled), so the composer is already
    // re-enabling. Drain the deferred bookkeeping now — after the SSE, before
    // the `finally` commits and drains the queue for the next turn.
    await runDeferredTurnTail({ ctx, state, rlog, generationCompletedAt });
  } catch (err) {
    clearConversationNotices(ctx.conversationId);
    const errorCtx = {
      phase: "agent_loop" as const,
      aborted: abortController.signal.aborted,
    };
    if (isUserCancellation(err, errorCtx)) {
      // Only label the turn when it hadn't already replied — a cancellation
      // surfacing after the terminal SSE (deferred turn-tail bookkeeping)
      // must not relabel a visibly-replied turn.
      if (!turnReplied) {
        abnormalOutcome = { outcome: "cancelled" };
      }
      ctx.emitActivityState("idle", "generation_cancelled", {
        anchor: "global",
        requestId: reqId,
      });
      rlog.info("Generation cancelled by user");
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
      rlog.error({ err }, "Conversation processing error");
      const classified = classifyConversationError(err, {
        ...errorCtx,
        ...turnErrorAttribution(),
      });
      if (!turnReplied) {
        abnormalOutcome = { outcome: "failed", failureCode: classified.code };
      }
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

      // Recompute relationship-state.json at turn boundary (fire-and-forget).
      // The writer swallows its own errors, but we still guard with catch()
      // here so a regression in the writer can never bubble out of the
      // agent loop and reject an otherwise-complete turn.
      void writeRelationshipState().catch(() => {});
    }

    emitToolProfilingSummary(ctx.conversationId, reqId);

    // Tear down this turn's per-turn state. Abort reliably drives the loop to
    // this `finally` within a bounded time — cooperative signal propagation
    // (provider fetch + tool race) backed by the abort watchdog — so a
    // cancelled turn always unwinds before any resend can start a new one.
    // There is therefore only ever one turn alive, and clearing the shared
    // state below cannot clobber a concurrent turn.
    // Stamp the turn's abnormal outcome (failed / cancelled) onto its
    // user-message row BEFORE processing clears: the telemetry reporter's
    // settled-turn barrier only releases this turn once the conversation
    // stops processing, so ordering the stamp first guarantees the turn
    // event ships with the outcome. A normally-replied turn stamps nothing.
    if (abnormalOutcome) {
      stampTurnOutcome(userMessageId, abnormalOutcome.outcome, {
        failureCode: abnormalOutcome.failureCode,
      });
    }
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
    ctx.currentTurnModelProfileNoticeKey = undefined;
    // Turn-scoped interactivity. Clear it so paths that bypass this loop (e.g.
    // opportunity wakes calling `agentLoop.run` directly) don't inherit a stale
    // value and instead fall back to live client state in the tool context.
    ctx.currentTurnIsNonInteractive = undefined;
    // Turn-scoped request origin. Clear so a later turn on a reused
    // conversation cannot inherit a stale origin-scoped permission grant.
    ctx.currentTurnRequestOrigin = undefined;
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
  cronRunId: string | null = null,
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
    cronRunId,
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
    /** Firing's `cron_runs.id` stamped onto the compaction usage row. */
    cronRunId?: string | null;
  } = {},
): Promise<void> {
  ctx.messages = result.messages;
  // Compaction operates on the in-context history. Untrusted actor views
  // render that history unsliced (boundary 0); trusted views start past the
  // already-compacted prefix (the mirrored DB count). Advance from that
  // in-context boundary rather than the raw mirror so the persisted count
  // stays consistent with what the new summary represents and never
  // double-counts an unsliced untrusted view.
  const inContextCompactedCount = !resolveCapabilities(
    ctx.trustContext?.trustClass,
  ).canAccessMemory
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
    options.cronRunId ?? null,
  );
}

function collapseRawResponses(rawResponses?: unknown[]): unknown | undefined {
  if (!rawResponses || rawResponses.length === 0) {
    return undefined;
  }
  return rawResponses.length === 1 ? rawResponses[0] : rawResponses;
}

/**
 * Matches any runtime-injection tag that should never appear inside a
 * generated summary. A hit means the summary echoed an injection tag —
 * either parroted from history the summarizer read or invented outright.
 * The durable summary should be clean prose, so the match is surfaced via
 * telemetry.
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
