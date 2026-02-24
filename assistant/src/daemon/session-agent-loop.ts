/**
 * Agent loop execution extracted from Session.runAgentLoop.
 *
 * This module contains the core agent loop orchestration: pre-flight
 * setup, event handling, retry logic, history reconstruction, and
 * completion event emission.  The Session class delegates its
 * runAgentLoop method here via the AgentLoopSessionContext interface.
 */

import { v4 as uuid } from 'uuid';
import type { Message, ContentBlock, ImageContent } from '../providers/types.js';
import type { ServerMessage, UsageStats, SurfaceType, SurfaceData, DynamicPageSurfaceData } from './ipc-protocol.js';
import type { AgentLoop, CheckpointDecision, AgentEvent } from '../agent/loop.js';
import type { Provider } from '../providers/types.js';
import { createAssistantMessage } from '../agent/message-types.js';
import * as conversationStore from '../memory/conversation-store.js';
import type { PermissionPrompter } from '../permissions/prompter.js';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import type { TraceEmitter } from './trace-emitter.js';
import { classifySessionError, isUserCancellation, isContextTooLarge, buildSessionErrorMessage } from './session-error.js';
import type { ToolProfiler } from '../events/tool-profiling-listener.js';
import type { ContextWindowManager } from '../context/window-manager.js';
import { getHookManager } from '../hooks/manager.js';
import { truncate } from '../util/truncate.js';
import { stripMemoryRecallMessages } from '../memory/retriever.js';
import { getApp, listAppFiles } from '../memory/app-store.js';
import type { ConflictGate } from './session-conflict-gate.js';
import { stripDynamicProfileMessages } from './session-dynamic-profile.js';
import type { MessageQueue } from './session-queue-manager.js';
import type { QueueDrainReason } from './session-queue-manager.js';
import {
  applyRuntimeInjections,
  stripInjectedContext,
} from './session-runtime-assembly.js';
import { buildTemporalContext } from './date-context.js';
import type { ActiveSurfaceContext, ChannelCapabilities, GuardianRuntimeContext } from './session-runtime-assembly.js';
import {
  cleanAssistantContent,
  drainDirectiveDisplayBuffer,
  type DirectiveRequest,
  type AssistantAttachmentDraft,
} from './assistant-attachments.js';
import { prepareMemoryContext } from './session-memory.js';
import {
  approveHostAttachmentRead,
  formatAttachmentWarnings,
  resolveAssistantAttachments,
} from './session-attachments.js';
import { consolidateAssistantMessages } from './session-history.js';
import { recordUsage } from './session-usage.js';
import { recordRequestLog } from '../memory/llm-request-log-store.js';
import { isProviderOrderingError } from './session-slash.js';
import { repairHistory, deepRepairHistory } from './history-repair.js';
import { stripMediaPayloadsForRetry, raceWithTimeout } from './session-media-retry.js';
import { commitTurnChanges } from '../workspace/turn-commit.js';
import { getWorkspaceGitService } from '../workspace/git-service.js';
import { commitAppTurnChanges } from '../memory/app-git-service.js';
import type { UsageActor } from '../usage/actors.js';
import type { SkillProjectionCache } from './session-skill-tools.js';

const log = getLogger('session-agent-loop');

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
  readonly surfaceState: Map<string, { surfaceType: SurfaceType; data: SurfaceData }>;
  pendingSurfaceActions: Map<string, { surfaceType: SurfaceType }>;
  currentTurnSurfaces: Array<{ surfaceId: string; surfaceType: SurfaceType; title?: string; data: SurfaceData; actions?: Array<{ id: string; label: string; style?: string }>; display?: string }>;

  workingDir: string;
  workspaceTopLevelContext: string | null;
  workspaceTopLevelDirty: boolean;
  channelCapabilities?: ChannelCapabilities;
  commandIntent?: { type: string; payload?: string; languageCode?: string };
  guardianContext?: GuardianRuntimeContext;

  readonly coreToolNames: Set<string>;
  allowedToolNames?: Set<string>;
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
  readonly prompter: PermissionPrompter;
  readonly queue: MessageQueue;

  getWorkspaceGitService?: (workspaceDir: string) => GitServiceInitializer;
  commitTurnChanges?: typeof commitTurnChanges;

  refreshWorkspaceTopLevelContextIfNeeded(): void;
  markWorkspaceTopLevelDirty(): void;
  getQueueDepth(): number;
  hasQueuedMessages(): boolean;
  canHandoffAtCheckpoint(): boolean;
  drainQueue(reason: QueueDrainReason): void;
}

// ── runAgentLoop ─────────────────────────────────────────────────────

export async function runAgentLoopImpl(
  ctx: AgentLoopSessionContext,
  content: string,
  userMessageId: string,
  onEvent: (msg: ServerMessage) => void,
  options?: { skipPreMessageRollback?: boolean },
): Promise<void> {
  if (!ctx.abortController) {
    throw new Error('runAgentLoop called without prior persistUserMessage');
  }
  const abortController = ctx.abortController;
  const reqId = ctx.currentRequestId ?? uuid();
  const rlog = log.child({ conversationId: ctx.conversationId, requestId: reqId });
  let yieldedForHandoff = false;

  ctx.lastAssistantAttachments = [];
  ctx.lastAttachmentWarnings = [];

  // Ensure workspace git repo is initialized before any tools run.
  try {
    const getWorkspaceGitServiceFn = ctx.getWorkspaceGitService ?? getWorkspaceGitService;
    const gitService = getWorkspaceGitServiceFn(ctx.workingDir);
    await gitService.ensureInitialized();
  } catch (err) {
    rlog.warn({ err }, 'Failed to initialize workspace git repo (non-fatal)');
  }

  ctx.profiler.startRequest();
  let turnStarted = false;

  try {
    const preMessageResult = await getHookManager().trigger('pre-message', {
      sessionId: ctx.conversationId,
      messagePreview: truncate(content, 200, ''),
    });

    if (preMessageResult.blocked) {
      if (!options?.skipPreMessageRollback) {
        ctx.messages.pop();
        conversationStore.deleteMessageById(userMessageId);
      }
      onEvent({ type: 'error', message: `Message blocked by hook "${preMessageResult.blockedBy}"` });
      return;
    }

    const isFirstMessage = ctx.messages.length === 1;

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
        type: 'context_compacted',
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
      emitUsage(ctx, compacted.summaryInputTokens, compacted.summaryOutputTokens, compacted.summaryModel, onEvent, 'context_compactor', reqId);
    }

    let firstAssistantText = '';
    let exchangeInputTokens = 0;
    let exchangeOutputTokens = 0;
    let model = '';
    let runMessages = ctx.messages;
    const pendingToolResults = new Map<string, { content: string; isError: boolean; contentBlocks?: ContentBlock[] }>();
    const persistedToolUseIds = new Set<string>();
    const accumulatedDirectives: DirectiveRequest[] = [];
    const accumulatedToolContentBlocks: ContentBlock[] = [];
    const directiveWarnings: string[] = [];
    let pendingDirectiveDisplayBuffer = '';
    let lastAssistantMessageId: string | undefined;
    let providerErrorUserMessage: string | null = null;

    const memoryResult = await prepareMemoryContext(
      {
        conversationId: ctx.conversationId,
        messages: ctx.messages,
        systemPrompt: ctx.systemPrompt,
        provider: ctx.provider,
        conflictGate: ctx.conflictGate,
        scopeId: ctx.memoryPolicy.scopeId,
        includeDefaultFallback: ctx.memoryPolicy.includeDefaultFallback,
      },
      content,
      userMessageId,
      abortController.signal,
      onEvent,
    );

    if (memoryResult.conflictClarification) {
      const assistantMessage = createAssistantMessage(memoryResult.conflictClarification);
      conversationStore.addMessage(
        ctx.conversationId,
        'assistant',
        JSON.stringify(assistantMessage.content),
      );
      ctx.messages.push(assistantMessage);
      onEvent({
        type: 'assistant_text_delta',
        text: memoryResult.conflictClarification,
        sessionId: ctx.conversationId,
      });
      ctx.traceEmitter.emit('message_complete', 'Conflict clarification requested (relevant)', {
        requestId: reqId,
        status: 'info',
        attributes: { conflictGate: 'relevant' },
      });
      onEvent({ type: 'message_complete', sessionId: ctx.conversationId });
      return;
    }

    const { recall, dynamicProfile, softConflictInstruction, recallInjectionStrategy } = memoryResult;
    runMessages = memoryResult.runMessages;

    // Build active surface context
    let activeSurface: ActiveSurfaceContext | null = null;
    if (ctx.currentActiveSurfaceId) {
      const stored = ctx.surfaceState.get(ctx.currentActiveSurfaceId);
      if (stored && stored.surfaceType === 'dynamic_page') {
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
    const temporalContext = buildTemporalContext({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    runMessages = applyRuntimeInjections(runMessages, {
      softConflictInstruction,
      activeSurface,
      workspaceTopLevelContext: ctx.workspaceTopLevelContext,
      channelCapabilities: ctx.channelCapabilities ?? null,
      channelCommandContext: ctx.commandIntent ?? null,
      guardianContext: ctx.guardianContext ?? null,
      temporalContext,
    });

    // Pre-run repair
    let preRepairMessages = runMessages;
    const preRunRepair = repairHistory(runMessages);
    if (preRunRepair.stats.assistantToolResultsMigrated > 0 || preRunRepair.stats.missingToolResultsInserted > 0 || preRunRepair.stats.orphanToolResultsDowngraded > 0 || preRunRepair.stats.consecutiveSameRoleMerged > 0) {
      rlog.warn({ phase: 'pre_run', ...preRunRepair.stats }, 'Repaired runtime history before provider call');
      runMessages = preRunRepair.messages;
    }

    let orderingErrorDetected = false;
    let deferredOrderingError: string | null = null;
    let contextTooLargeDetected = false;
    let preRunHistoryLength = runMessages.length;

    let llmCallStartedEmitted = false;
    const toolUseIdToName = new Map<string, string>();
    let currentTurnToolNames: string[] = [];

    const buildEventHandler = () => (event: AgentEvent) => {
      const emitLlmCallStartedIfNeeded = () => {
        if (llmCallStartedEmitted) return;
        llmCallStartedEmitted = true;
        ctx.traceEmitter.emit('llm_call_started', `LLM call to ${ctx.provider.name}`, {
          requestId: reqId,
          status: 'info',
          attributes: { provider: ctx.provider.name, model: model || 'unknown' },
        });
      };

      switch (event.type) {
        case 'text_delta': {
          emitLlmCallStartedIfNeeded();
          pendingDirectiveDisplayBuffer += event.text;
          const drained = drainDirectiveDisplayBuffer(pendingDirectiveDisplayBuffer);
          pendingDirectiveDisplayBuffer = drained.bufferedRemainder;
          if (drained.emitText.length > 0) {
            onEvent({ type: 'assistant_text_delta', text: drained.emitText, sessionId: ctx.conversationId });
            if (isFirstMessage) firstAssistantText += drained.emitText;
          }
          break;
        }
        case 'thinking_delta':
          emitLlmCallStartedIfNeeded();
          onEvent({ type: 'assistant_thinking_delta', thinking: event.thinking });
          break;
        case 'tool_use':
          toolUseIdToName.set(event.id, event.name);
          currentTurnToolNames.push(event.name);
          onEvent({ type: 'tool_use_start', toolName: event.name, input: event.input, sessionId: ctx.conversationId });
          break;
        case 'tool_output_chunk': {
          // Try to parse structured progress fields from the chunk.
          // Cheap pre-check: only attempt JSON.parse when the chunk looks like an object.
          let structured: { subType?: 'tool_start' | 'tool_complete' | 'status'; subToolName?: string; subToolInput?: string; subToolIsError?: boolean; subToolId?: string } | undefined;
          const trimmed = event.chunk.trimStart();
          if (trimmed.length > 0 && trimmed.length < 4096 && trimmed[0] === '{') {
            try {
              const parsed = JSON.parse(event.chunk);
              const VALID_SUB_TYPES = new Set(['tool_start', 'tool_complete', 'status']);
              if (parsed && typeof parsed === 'object' && typeof parsed.subType === 'string' && VALID_SUB_TYPES.has(parsed.subType)) {
                structured = {
                  subType: parsed.subType as 'tool_start' | 'tool_complete' | 'status',
                  subToolName: typeof parsed.subToolName === 'string' ? parsed.subToolName : undefined,
                  subToolInput: typeof parsed.subToolInput === 'string' ? parsed.subToolInput : undefined,
                  subToolIsError: typeof parsed.subToolIsError === 'boolean' ? parsed.subToolIsError : undefined,
                  subToolId: typeof parsed.subToolId === 'string' ? parsed.subToolId : undefined,
                };
              }
            } catch {
              // Not valid JSON — pass through as plain chunk
            }
          }
          if (structured) {
            onEvent({
              type: 'tool_output_chunk',
              chunk: event.chunk,
              sessionId: ctx.conversationId,
              subType: structured.subType,
              subToolName: structured.subToolName,
              subToolInput: structured.subToolInput,
              subToolIsError: structured.subToolIsError,
              subToolId: structured.subToolId,
            });
          } else {
            onEvent({ type: 'tool_output_chunk', chunk: event.chunk, sessionId: ctx.conversationId });
          }
          break;
        }
        case 'input_json_delta':
          onEvent({ type: 'tool_input_delta', toolName: event.toolName, content: event.accumulatedJson, sessionId: ctx.conversationId });
          break;
        case 'tool_result': {
          const imageBlock = event.contentBlocks?.find((b): b is ImageContent => b.type === 'image');
          onEvent({ type: 'tool_result', toolName: '', result: event.content, isError: event.isError, diff: event.diff, status: event.status, sessionId: ctx.conversationId, imageData: imageBlock?.source.data });
          pendingToolResults.set(event.toolUseId, { content: event.content, isError: event.isError, contentBlocks: event.contentBlocks });
          {
            const toolName = toolUseIdToName.get(event.toolUseId);
            if (toolName === 'file_write' || toolName === 'bash') {
              ctx.markWorkspaceTopLevelDirty();
            } else if (toolName === 'file_edit' && !event.isError) {
              ctx.markWorkspaceTopLevelDirty();
            }
          }
          if (event.contentBlocks) {
            for (const cb of event.contentBlocks) {
              if (cb.type === 'image' || cb.type === 'file') {
                accumulatedToolContentBlocks.push(cb);
              }
            }
          }
          break;
        }
        case 'error':
          if (isProviderOrderingError(event.error.message)) {
            orderingErrorDetected = true;
            deferredOrderingError = event.error.message;
          } else if (isContextTooLarge(event.error.message)) {
            contextTooLargeDetected = true;
          } else {
            const classified = classifySessionError(event.error, { phase: 'agent_loop' });
            onEvent(buildSessionErrorMessage(ctx.conversationId, classified));
            providerErrorUserMessage = classified.userMessage;
          }
          break;
        case 'message_complete': {
          if (pendingDirectiveDisplayBuffer.length > 0) {
            onEvent({
              type: 'assistant_text_delta',
              text: pendingDirectiveDisplayBuffer,
              sessionId: ctx.conversationId,
            });
            if (isFirstMessage) firstAssistantText += pendingDirectiveDisplayBuffer;
            pendingDirectiveDisplayBuffer = '';
          }
          if (pendingToolResults.size > 0) {
            const toolResultBlocks = Array.from(pendingToolResults.entries()).map(
              ([toolUseId, result]) => ({
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: result.content,
                is_error: result.isError,
                ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}),
              }),
            );
            conversationStore.addMessage(
              ctx.conversationId,
              'user',
              JSON.stringify(toolResultBlocks),
            );
            for (const id of pendingToolResults.keys()) {
              persistedToolUseIds.add(id);
            }
            pendingToolResults.clear();
          }
          const { cleanedContent, directives: msgDirectives, warnings: msgWarnings } =
            cleanAssistantContent(event.message.content);
          accumulatedDirectives.push(...msgDirectives);
          directiveWarnings.push(...msgWarnings);
          if (msgDirectives.length > 0) {
            rlog.info(
              { parsedDirectives: msgDirectives.map(d => ({ source: d.source, path: d.path, mimeType: d.mimeType })), totalAccumulated: accumulatedDirectives.length },
              'Parsed attachment directives from assistant message',
            );
          }

          const contentWithSurfaces: ContentBlock[] = [...cleanedContent as ContentBlock[]];
          for (const surface of ctx.currentTurnSurfaces) {
            contentWithSurfaces.push({
              type: 'ui_surface',
              surfaceId: surface.surfaceId,
              surfaceType: surface.surfaceType,
              title: surface.title,
              data: surface.data,
              actions: surface.actions,
              display: surface.display,
            } as unknown as ContentBlock);
          }

          const assistantMsg = conversationStore.addMessage(
            ctx.conversationId,
            'assistant',
            JSON.stringify(contentWithSurfaces),
          );
          lastAssistantMessageId = assistantMsg.id;

          ctx.currentTurnSurfaces = [];

          const charCount = cleanedContent
            .filter((b) => (b as Record<string, unknown>).type === 'text')
            .reduce((sum: number, b) => sum + ((b as { text?: string }).text?.length ?? 0), 0);
          const toolUseCount = event.message.content
            .filter((b) => b.type === 'tool_use')
            .length;
          ctx.traceEmitter.emit('assistant_message', 'Assistant message complete', {
            requestId: reqId,
            status: 'success',
            attributes: { charCount, toolUseCount },
          });
          break;
        }
        case 'usage':
          exchangeInputTokens += event.inputTokens;
          exchangeOutputTokens += event.outputTokens;
          model = event.model;

          if (event.rawRequest && event.rawResponse) {
            try {
              recordRequestLog(
                ctx.conversationId,
                JSON.stringify(event.rawRequest),
                JSON.stringify(event.rawResponse),
              );
            } catch (err) {
              rlog.warn({ err }, 'Failed to persist LLM request log (non-fatal)');
            }
          }

          emitLlmCallStartedIfNeeded();

          ctx.traceEmitter.emit('llm_call_finished', `LLM call to ${ctx.provider.name} finished`, {
            requestId: reqId,
            status: 'success',
            attributes: {
              provider: ctx.provider.name,
              model: event.model,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              latencyMs: event.providerDurationMs,
            },
          });
          llmCallStartedEmitted = false;
          break;
      }
    };

    const onCheckpoint = (): CheckpointDecision => {
      const turnTools = currentTurnToolNames;
      currentTurnToolNames = [];

      if (ctx.canHandoffAtCheckpoint()) {
        const inBrowserFlow = turnTools.length > 0
          && turnTools.every(n => n.startsWith('browser_'));
        if (!inBrowserFlow) {
          yieldedForHandoff = true;
          return 'yield';
        }
      }
      return 'continue';
    };

    turnStarted = true;

    let updatedHistory = await ctx.agentLoop.run(
      runMessages,
      buildEventHandler(),
      abortController.signal,
      reqId,
      onCheckpoint,
    );

    // One-shot ordering error retry
    if (orderingErrorDetected && updatedHistory.length === preRunHistoryLength) {
      rlog.warn({ phase: 'retry' }, 'Provider ordering error detected, attempting one-shot deep-repair retry');
      const retryRepair = deepRepairHistory(runMessages);
      runMessages = retryRepair.messages;
      preRepairMessages = retryRepair.messages;
      preRunHistoryLength = runMessages.length;
      orderingErrorDetected = false;
      deferredOrderingError = null;

      updatedHistory = await ctx.agentLoop.run(
        runMessages,
        buildEventHandler(),
        abortController.signal,
        reqId,
        onCheckpoint,
      );

      if (orderingErrorDetected) {
        rlog.error({ phase: 'retry' }, 'Deep-repair retry also failed with ordering error. Consider starting a new conversation if this persists.');
      }
    }

    // One-shot context-too-large recovery
    if (contextTooLargeDetected && updatedHistory.length === preRunHistoryLength) {
      rlog.warn({ phase: 'retry' }, 'Context too large — attempting forced compaction and retry');
      const emergencyCompact = await ctx.contextWindowManager.maybeCompact(
        ctx.messages,
        abortController.signal,
        { lastCompactedAt: ctx.contextCompactedAt ?? undefined, force: true },
      );
      if (emergencyCompact.compacted) {
        ctx.messages = emergencyCompact.messages;
        ctx.contextCompactedMessageCount += emergencyCompact.compactedPersistedMessages;
        ctx.contextCompactedAt = Date.now();
        conversationStore.updateConversationContextWindow(
          ctx.conversationId,
          emergencyCompact.summaryText,
          ctx.contextCompactedMessageCount,
        );
        onEvent({
          type: 'context_compacted',
          previousEstimatedInputTokens: emergencyCompact.previousEstimatedInputTokens,
          estimatedInputTokens: emergencyCompact.estimatedInputTokens,
          maxInputTokens: emergencyCompact.maxInputTokens,
          thresholdTokens: emergencyCompact.thresholdTokens,
          compactedMessages: emergencyCompact.compactedMessages,
          summaryCalls: emergencyCompact.summaryCalls,
          summaryInputTokens: emergencyCompact.summaryInputTokens,
          summaryOutputTokens: emergencyCompact.summaryOutputTokens,
          summaryModel: emergencyCompact.summaryModel,
        });
        emitUsage(ctx, emergencyCompact.summaryInputTokens, emergencyCompact.summaryOutputTokens, emergencyCompact.summaryModel, onEvent, 'context_compactor', reqId);

        runMessages = applyRuntimeInjections(ctx.messages, {
          softConflictInstruction,
          activeSurface,
          workspaceTopLevelContext: ctx.workspaceTopLevelContext,
          channelCapabilities: ctx.channelCapabilities ?? null,
          guardianContext: ctx.guardianContext ?? null,
          temporalContext,
        });
        preRepairMessages = runMessages;
        preRunHistoryLength = runMessages.length;
        contextTooLargeDetected = false;

        updatedHistory = await ctx.agentLoop.run(
          runMessages,
          buildEventHandler(),
          abortController.signal,
          reqId,
          onCheckpoint,
        );
      }

      if (contextTooLargeDetected) {
        const mediaTrimmed = stripMediaPayloadsForRetry(ctx.messages);
        if (mediaTrimmed.modified) {
          rlog.warn(
            {
              phase: 'retry',
              replacedBlocks: mediaTrimmed.replacedBlocks,
              latestUserIndex: mediaTrimmed.latestUserIndex,
            },
            'Context still too large — retrying with older media payloads trimmed',
          );
          ctx.messages = mediaTrimmed.messages;
          runMessages = applyRuntimeInjections(ctx.messages, {
            softConflictInstruction,
            activeSurface,
            workspaceTopLevelContext: ctx.workspaceTopLevelContext,
            channelCapabilities: ctx.channelCapabilities ?? null,
            guardianContext: ctx.guardianContext ?? null,
            temporalContext,
          });
          preRepairMessages = runMessages;
          preRunHistoryLength = runMessages.length;
          contextTooLargeDetected = false;

          updatedHistory = await ctx.agentLoop.run(
            runMessages,
            buildEventHandler(),
            abortController.signal,
            reqId,
            onCheckpoint,
          );
        }
      }

      if (contextTooLargeDetected) {
        const classified = classifySessionError(
          new Error('context_length_exceeded'),
          { phase: 'agent_loop' },
        );
        onEvent(buildSessionErrorMessage(ctx.conversationId, classified));
      }
    }

    if (deferredOrderingError) {
      const classified = classifySessionError(new Error(deferredOrderingError), { phase: 'agent_loop' });
      onEvent(buildSessionErrorMessage(ctx.conversationId, classified));
    }

    // Reconcile synthesized cancellation tool_results
    for (let i = preRunHistoryLength; i < updatedHistory.length; i++) {
      const msg = updatedHistory[i];
      if (msg.role === 'user') {
        for (const block of msg.content) {
          if (block.type === 'tool_result' && !pendingToolResults.has(block.tool_use_id) && !persistedToolUseIds.has(block.tool_use_id)) {
            pendingToolResults.set(block.tool_use_id, {
              content: block.content,
              isError: block.is_error ?? false,
            });
          }
        }
      }
    }

    // Flush remaining tool results
    if (pendingToolResults.size > 0) {
      const toolResultBlocks = Array.from(pendingToolResults.entries()).map(
        ([toolUseId, result]) => ({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: result.content,
          is_error: result.isError,
          ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}),
        }),
      );
      conversationStore.addMessage(
        ctx.conversationId,
        'user',
        JSON.stringify(toolResultBlocks),
      );
      pendingToolResults.clear();
    }

    // Reconstruct history
    const newMessages = updatedHistory.slice(preRunHistoryLength).map((msg) => {
      if (msg.role !== 'assistant') return msg;
      const { cleanedContent } = cleanAssistantContent(msg.content);
      return { ...msg, content: cleanedContent as ContentBlock[] };
    });

    const hasAssistantResponse = newMessages.some((msg) => msg.role === 'assistant');
    if (!hasAssistantResponse && providerErrorUserMessage && !abortController.signal.aborted && !yieldedForHandoff) {
      const errorAssistantMessage = createAssistantMessage(providerErrorUserMessage);
      conversationStore.addMessage(
        ctx.conversationId,
        'assistant',
        JSON.stringify(errorAssistantMessage.content),
      );
      newMessages.push(errorAssistantMessage);
      onEvent({
        type: 'assistant_text_delta',
        text: providerErrorUserMessage,
        sessionId: ctx.conversationId,
      });
    }

    const restoredHistory = [...preRepairMessages, ...newMessages];
    ctx.messages = stripInjectedContext(restoredHistory, {
      stripRecall: (msgs) => stripMemoryRecallMessages(msgs, recall.injectedText, recallInjectionStrategy),
      stripDynamicProfile: (msgs) => stripDynamicProfileMessages(msgs, dynamicProfile.text),
    });

    emitUsage(ctx, exchangeInputTokens, exchangeOutputTokens, model, onEvent, 'main_agent', reqId);

    void getHookManager().trigger('post-message', {
      sessionId: ctx.conversationId,
    });

    // Resolve attachments
    const attachmentResult = await resolveAssistantAttachments(
      accumulatedDirectives,
      accumulatedToolContentBlocks,
      directiveWarnings,
      ctx.workingDir,
      async (filePath) => approveHostAttachmentRead(filePath, ctx.workingDir, ctx.prompter, ctx.conversationId, ctx.hasNoClient),
      lastAssistantMessageId,
    );
    const { assistantAttachments, emittedAttachments } = attachmentResult;

    ctx.lastAssistantAttachments = assistantAttachments;
    ctx.lastAttachmentWarnings = attachmentResult.directiveWarnings;

    const warningText = formatAttachmentWarnings(attachmentResult.directiveWarnings);
    if (warningText) {
      onEvent({ type: 'assistant_text_delta', text: warningText, sessionId: ctx.conversationId });
    }

    // Emit completion event
    if (yieldedForHandoff) {
      ctx.traceEmitter.emit('generation_handoff', 'Handing off to next queued message', {
        requestId: reqId,
        status: 'info',
        attributes: { queuedCount: ctx.getQueueDepth() },
      });
      onEvent({
        type: 'generation_handoff',
        sessionId: ctx.conversationId,
        requestId: reqId,
        queuedCount: ctx.getQueueDepth(),
        ...(emittedAttachments.length > 0 ? { attachments: emittedAttachments } : {}),
      });
    } else if (abortController.signal.aborted) {
      ctx.traceEmitter.emit('generation_cancelled', 'Generation cancelled by user', {
        requestId: reqId,
        status: 'warning',
      });
      onEvent({ type: 'generation_cancelled', sessionId: ctx.conversationId });
    } else {
      ctx.traceEmitter.emit('message_complete', 'Message processing complete', {
        requestId: reqId,
        status: 'success',
      });
      onEvent({
        type: 'message_complete',
        sessionId: ctx.conversationId,
        ...(emittedAttachments.length > 0 ? { attachments: emittedAttachments } : {}),
      });
    }

    if (isFirstMessage) {
      generateTitle(ctx, content, firstAssistantText).catch((err) => {
        log.warn({ err, conversationId: ctx.conversationId }, 'Failed to generate conversation title (non-fatal, using default title)');
      });
    }
  } catch (err) {
    const errorCtx = { phase: 'agent_loop' as const, aborted: abortController.signal.aborted };
    if (isUserCancellation(err, errorCtx)) {
      rlog.info('Generation cancelled by user');
      ctx.traceEmitter.emit('generation_cancelled', 'Generation cancelled by user', {
        requestId: reqId,
        status: 'warning',
      });
      onEvent({ type: 'generation_cancelled', sessionId: ctx.conversationId });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      const errorClass = err instanceof Error ? err.constructor.name : 'Error';
      rlog.error({ err }, 'Session processing error');
      ctx.traceEmitter.emit('request_error', truncate(message, 200, ''), {
        requestId: reqId,
        status: 'error',
        attributes: { errorClass, message: truncate(message, 500, '') },
      });
      onEvent({ type: 'error', message: `Failed to process message: ${message}` });
      const classified = classifySessionError(err, errorCtx);
      onEvent(buildSessionErrorMessage(ctx.conversationId, classified));
      void getHookManager().trigger('on-error', {
        error: err instanceof Error ? err.name : 'Error',
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
        ctx.workingDir, ctx.conversationId, ctx.turnCount,
        undefined,
        deadlineMs,
      );
      const outcome = await raceWithTimeout(commitPromise, maxWait);
      if (outcome === 'timed_out') {
        rlog.warn(
          { turnNumber: ctx.turnCount, maxWaitMs: maxWait, conversationId: ctx.conversationId },
          'Turn-boundary commit timed out — continuing without waiting (commit still runs in background)',
        );
      }

      // Commit app changes (fire-and-forget — apps repo is separate from workspace)
      void commitAppTurnChanges(ctx.conversationId, ctx.turnCount);
    }

    ctx.profiler.emitSummary(ctx.traceEmitter, reqId);

    ctx.abortController = null;
    ctx.processing = false;
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

    ctx.drainQueue(yieldedForHandoff ? 'checkpoint_handoff' : 'loop_complete');
  }
}

// ── generateTitle ────────────────────────────────────────────────────

async function generateTitle(
  ctx: Pick<AgentLoopSessionContext, 'conversationId' | 'provider'>,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  const prompt = `Generate a very short title for this conversation. Rules: at most 5 words, at most 40 characters, no quotes.\n\nUser: ${truncate(userMessage, 200, '')}\nAssistant: ${truncate(assistantResponse, 200, '')}`;
  const response = await ctx.provider.sendMessage(
    [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    [],
    undefined,
    { config: { max_tokens: 30 } },
  );

  const textBlock = response.content.find((b) => b.type === 'text');
  if (textBlock && textBlock.type === 'text') {
    let title = textBlock.text.trim().replace(/^["']|["']$/g, '');
    const words = title.split(/\s+/);
    if (words.length > 5) title = words.slice(0, 5).join(' ');
    if (title.length > 40) title = title.slice(0, 40).trimEnd();
    conversationStore.updateConversationTitle(ctx.conversationId, title);
    log.info({ conversationId: ctx.conversationId, title }, 'Auto-generated conversation title');
  }
}

// ── Helper ───────────────────────────────────────────────────────────

function emitUsage(
  ctx: Pick<AgentLoopSessionContext, 'conversationId' | 'provider' | 'usageStats'>,
  inputTokens: number,
  outputTokens: number,
  model: string,
  onEvent: (msg: ServerMessage) => void,
  actor: UsageActor,
  requestId: string | null = null,
): void {
  recordUsage(
    { conversationId: ctx.conversationId, providerName: ctx.provider.name, usageStats: ctx.usageStats },
    inputTokens, outputTokens, model, onEvent, actor, requestId,
  );
}
