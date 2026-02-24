/**
 * Extracted event handler functions for the session agent loop.
 *
 * Each switch case from the original monolithic event handler is now a
 * standalone exported function, making individual behaviors independently
 * testable while keeping shared mutable state bundled in EventHandlerState.
 */

import type pino from 'pino';
import type { ContentBlock, ImageContent } from '../providers/types.js';
import type { ServerMessage } from './ipc-protocol.js';
import type { AgentEvent } from '../agent/loop.js';
import type { AgentLoopSessionContext } from './session-agent-loop.js';
import type { DirectiveRequest } from './assistant-attachments.js';
import * as conversationStore from '../memory/conversation-store.js';
import { classifySessionError, isContextTooLarge, buildSessionErrorMessage } from './session-error.js';
import { isProviderOrderingError } from './session-slash.js';
import { cleanAssistantContent, drainDirectiveDisplayBuffer } from './assistant-attachments.js';
import { recordRequestLog } from '../memory/llm-request-log-store.js';

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
  exchangeInputTokens: number;
  exchangeOutputTokens: number;
  model: string;
  orderingErrorDetected: boolean;
  deferredOrderingError: string | null;
  contextTooLargeDetected: boolean;
  providerErrorUserMessage: string | null;
  lastAssistantMessageId: string | undefined;
  readonly pendingToolResults: Map<string, PendingToolResult>;
  readonly persistedToolUseIds: Set<string>;
  readonly accumulatedDirectives: DirectiveRequest[];
  readonly accumulatedToolContentBlocks: ContentBlock[];
  readonly directiveWarnings: string[];
  readonly toolUseIdToName: Map<string, string>;
  currentTurnToolNames: string[];
}

/** Immutable context shared across event handlers within a single agent loop run. */
export interface EventHandlerDeps {
  readonly ctx: AgentLoopSessionContext;
  readonly onEvent: (msg: ServerMessage) => void;
  readonly reqId: string;
  readonly isFirstMessage: boolean;
  readonly rlog: pino.Logger;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createEventHandlerState(): EventHandlerState {
  return {
    llmCallStartedEmitted: false,
    pendingDirectiveDisplayBuffer: '',
    firstAssistantText: '',
    exchangeInputTokens: 0,
    exchangeOutputTokens: 0,
    model: '',
    orderingErrorDetected: false,
    deferredOrderingError: null,
    contextTooLargeDetected: false,
    providerErrorUserMessage: null,
    lastAssistantMessageId: undefined,
    pendingToolResults: new Map(),
    persistedToolUseIds: new Set(),
    accumulatedDirectives: [],
    accumulatedToolContentBlocks: [],
    directiveWarnings: [],
    toolUseIdToName: new Map(),
    currentTurnToolNames: [],
  };
}

// ── Shared Helper ────────────────────────────────────────────────────

export function emitLlmCallStartedIfNeeded(
  state: EventHandlerState,
  deps: EventHandlerDeps,
): void {
  if (state.llmCallStartedEmitted) return;
  state.llmCallStartedEmitted = true;
  deps.ctx.traceEmitter.emit('llm_call_started', `LLM call to ${deps.ctx.provider.name}`, {
    requestId: deps.reqId,
    status: 'info',
    attributes: { provider: deps.ctx.provider.name, model: state.model || 'unknown' },
  });
}

// ── Individual Handlers ──────────────────────────────────────────────

export function handleTextDelta(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: 'text_delta' }>,
): void {
  emitLlmCallStartedIfNeeded(state, deps);
  state.pendingDirectiveDisplayBuffer += event.text;
  const drained = drainDirectiveDisplayBuffer(state.pendingDirectiveDisplayBuffer);
  state.pendingDirectiveDisplayBuffer = drained.bufferedRemainder;
  if (drained.emitText.length > 0) {
    deps.onEvent({ type: 'assistant_text_delta', text: drained.emitText, sessionId: deps.ctx.conversationId });
    if (deps.isFirstMessage) state.firstAssistantText += drained.emitText;
  }
}

export function handleThinkingDelta(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: 'thinking_delta' }>,
): void {
  emitLlmCallStartedIfNeeded(state, deps);
  deps.onEvent({ type: 'assistant_thinking_delta', thinking: event.thinking });
}

export function handleToolUse(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: 'tool_use' }>,
): void {
  state.toolUseIdToName.set(event.id, event.name);
  state.currentTurnToolNames.push(event.name);
  deps.onEvent({ type: 'tool_use_start', toolName: event.name, input: event.input, sessionId: deps.ctx.conversationId });
}

export function handleToolOutputChunk(
  _state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: 'tool_output_chunk' }>,
): void {
  let structured: {
    subType?: 'tool_start' | 'tool_complete' | 'status';
    subToolName?: string;
    subToolInput?: string;
    subToolIsError?: boolean;
    subToolId?: string;
  } | undefined;

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
    deps.onEvent({
      type: 'tool_output_chunk',
      chunk: event.chunk,
      sessionId: deps.ctx.conversationId,
      subType: structured.subType,
      subToolName: structured.subToolName,
      subToolInput: structured.subToolInput,
      subToolIsError: structured.subToolIsError,
      subToolId: structured.subToolId,
    });
  } else {
    deps.onEvent({ type: 'tool_output_chunk', chunk: event.chunk, sessionId: deps.ctx.conversationId });
  }
}

export function handleInputJsonDelta(
  _state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: 'input_json_delta' }>,
): void {
  deps.onEvent({ type: 'tool_input_delta', toolName: event.toolName, content: event.accumulatedJson, sessionId: deps.ctx.conversationId });
}

export function handleToolResult(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: 'tool_result' }>,
): void {
  const imageBlock = event.contentBlocks?.find((b): b is ImageContent => b.type === 'image');
  deps.onEvent({
    type: 'tool_result',
    toolName: '',
    result: event.content,
    isError: event.isError,
    diff: event.diff,
    status: event.status,
    sessionId: deps.ctx.conversationId,
    imageData: imageBlock?.source.data,
  });
  state.pendingToolResults.set(event.toolUseId, {
    content: event.content,
    isError: event.isError,
    contentBlocks: event.contentBlocks,
  });

  const toolName = state.toolUseIdToName.get(event.toolUseId);
  if (toolName === 'file_write' || toolName === 'bash') {
    deps.ctx.markWorkspaceTopLevelDirty();
  } else if (toolName === 'file_edit' && !event.isError) {
    deps.ctx.markWorkspaceTopLevelDirty();
  }

  if (event.contentBlocks) {
    for (const cb of event.contentBlocks) {
      if (cb.type === 'image' || cb.type === 'file') {
        state.accumulatedToolContentBlocks.push(cb);
      }
    }
  }
}

export function handleError(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: 'error' }>,
): void {
  if (isProviderOrderingError(event.error.message)) {
    state.orderingErrorDetected = true;
    state.deferredOrderingError = event.error.message;
  } else if (isContextTooLarge(event.error.message)) {
    state.contextTooLargeDetected = true;
  } else {
    const classified = classifySessionError(event.error, { phase: 'agent_loop' });
    deps.onEvent(buildSessionErrorMessage(deps.ctx.conversationId, classified));
    state.providerErrorUserMessage = classified.userMessage;
  }
}

export function handleMessageComplete(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: 'message_complete' }>,
): void {
  // Flush any remaining directive display buffer
  if (state.pendingDirectiveDisplayBuffer.length > 0) {
    deps.onEvent({
      type: 'assistant_text_delta',
      text: state.pendingDirectiveDisplayBuffer,
      sessionId: deps.ctx.conversationId,
    });
    if (deps.isFirstMessage) state.firstAssistantText += state.pendingDirectiveDisplayBuffer;
    state.pendingDirectiveDisplayBuffer = '';
  }

  // Persist pending tool results
  if (state.pendingToolResults.size > 0) {
    const toolResultBlocks = Array.from(state.pendingToolResults.entries()).map(
      ([toolUseId, result]) => ({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: result.content,
        is_error: result.isError,
        ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}),
      }),
    );
    conversationStore.addMessage(
      deps.ctx.conversationId,
      'user',
      JSON.stringify(toolResultBlocks),
    );
    for (const id of state.pendingToolResults.keys()) {
      state.persistedToolUseIds.add(id);
    }
    state.pendingToolResults.clear();
  }

  // Clean assistant content and accumulate directives
  const { cleanedContent, directives: msgDirectives, warnings: msgWarnings } =
    cleanAssistantContent(event.message.content);
  state.accumulatedDirectives.push(...msgDirectives);
  state.directiveWarnings.push(...msgWarnings);
  if (msgDirectives.length > 0) {
    deps.rlog.info(
      { parsedDirectives: msgDirectives.map(d => ({ source: d.source, path: d.path, mimeType: d.mimeType })), totalAccumulated: state.accumulatedDirectives.length },
      'Parsed attachment directives from assistant message',
    );
  }

  // Build content with UI surfaces
  const contentWithSurfaces: ContentBlock[] = [...cleanedContent as ContentBlock[]];
  for (const surface of deps.ctx.currentTurnSurfaces) {
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
    deps.ctx.conversationId,
    'assistant',
    JSON.stringify(contentWithSurfaces),
  );
  state.lastAssistantMessageId = assistantMsg.id;

  deps.ctx.currentTurnSurfaces = [];

  // Emit trace event
  const charCount = cleanedContent
    .filter((b) => (b as Record<string, unknown>).type === 'text')
    .reduce((sum: number, b) => sum + ((b as { text?: string }).text?.length ?? 0), 0);
  const toolUseCount = event.message.content
    .filter((b) => b.type === 'tool_use')
    .length;
  deps.ctx.traceEmitter.emit('assistant_message', 'Assistant message complete', {
    requestId: deps.reqId,
    status: 'success',
    attributes: { charCount, toolUseCount },
  });
}

export function handleUsage(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: 'usage' }>,
): void {
  state.exchangeInputTokens += event.inputTokens;
  state.exchangeOutputTokens += event.outputTokens;
  state.model = event.model;

  if (event.rawRequest && event.rawResponse) {
    try {
      recordRequestLog(
        deps.ctx.conversationId,
        JSON.stringify(event.rawRequest),
        JSON.stringify(event.rawResponse),
      );
    } catch (err) {
      deps.rlog.warn({ err }, 'Failed to persist LLM request log (non-fatal)');
    }
  }

  emitLlmCallStartedIfNeeded(state, deps);

  deps.ctx.traceEmitter.emit('llm_call_finished', `LLM call to ${deps.ctx.provider.name} finished`, {
    requestId: deps.reqId,
    status: 'success',
    attributes: {
      provider: deps.ctx.provider.name,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      latencyMs: event.providerDurationMs,
    },
  });
  state.llmCallStartedEmitted = false;
}

// ── Dispatcher ───────────────────────────────────────────────────────

/** Routes an AgentEvent to the appropriate handler. */
export function dispatchAgentEvent(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: AgentEvent,
): void {
  switch (event.type) {
    case 'text_delta':
      handleTextDelta(state, deps, event);
      break;
    case 'thinking_delta':
      handleThinkingDelta(state, deps, event);
      break;
    case 'tool_use':
      handleToolUse(state, deps, event);
      break;
    case 'tool_output_chunk':
      handleToolOutputChunk(state, deps, event);
      break;
    case 'input_json_delta':
      handleInputJsonDelta(state, deps, event);
      break;
    case 'tool_result':
      handleToolResult(state, deps, event);
      break;
    case 'error':
      handleError(state, deps, event);
      break;
    case 'message_complete':
      handleMessageComplete(state, deps, event);
      break;
    case 'usage':
      handleUsage(state, deps, event);
      break;
  }
}
