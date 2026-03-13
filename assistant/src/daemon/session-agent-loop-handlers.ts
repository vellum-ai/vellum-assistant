/**
 * Extracted event handler functions for the session agent loop.
 *
 * Each switch case from the original monolithic event handler is now a
 * standalone exported function, making individual behaviors independently
 * testable while keeping shared mutable state bundled in EventHandlerState.
 */

import type pino from "pino";

import type { AgentEvent } from "../agent/loop.js";
import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import {
  addMessage,
  getMessageById,
  provenanceFromTrustContext,
  updateMessageContent,
} from "../memory/conversation-crud.js";
import { recordRequestLog } from "../memory/llm-request-log-store.js";
import type { ContentBlock, ImageContent } from "../providers/types.js";
import type { DirectiveRequest } from "./assistant-attachments.js";
import {
  cleanAssistantContent,
  drainDirectiveDisplayBuffer,
} from "./assistant-attachments.js";
import type { ServerMessage } from "./message-protocol.js";
import type { AgentLoopSessionContext } from "./session-agent-loop.js";
import {
  buildSessionErrorMessage,
  classifySessionError,
  isContextTooLarge,
} from "./session-error.js";
import { isProviderOrderingError } from "./session-slash.js";

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
  exchangeCacheCreationInputTokens: number;
  exchangeCacheReadInputTokens: number;
  exchangeOutputTokens: number;
  readonly exchangeRawResponses: unknown[];
  model: string;
  orderingErrorDetected: boolean;
  deferredOrderingError: string | null;
  contextTooLargeDetected: boolean;
  /** The raw error message from the provider when context_too_large is detected. */
  contextTooLargeErrorMessage: string | null;
  providerErrorUserMessage: string | null;
  lastAssistantMessageId: string | undefined;
  readonly pendingToolResults: Map<string, PendingToolResult>;
  readonly persistedToolUseIds: Set<string>;
  readonly accumulatedDirectives: DirectiveRequest[];
  readonly accumulatedToolContentBlocks: ContentBlock[];
  /** Maps index in accumulatedToolContentBlocks → tool name that produced it. */
  readonly toolContentBlockToolNames: Map<number, string>;
  readonly directiveWarnings: string[];
  readonly toolUseIdToName: Map<string, string>;
  currentTurnToolNames: string[];
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
  /** tool_use_ids emitted in the current turn (populated in handleToolUse, cleared after annotation). */
  currentTurnToolUseIds: string[];
}

/** Immutable context shared across event handlers within a single agent loop run. */
export interface EventHandlerDeps {
  readonly ctx: AgentLoopSessionContext;
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
    exchangeInputTokens: 0,
    exchangeCacheCreationInputTokens: 0,
    exchangeCacheReadInputTokens: 0,
    exchangeOutputTokens: 0,
    exchangeRawResponses: [],
    model: "",
    orderingErrorDetected: false,
    deferredOrderingError: null,
    contextTooLargeDetected: false,
    contextTooLargeErrorMessage: null,
    providerErrorUserMessage: null,
    lastAssistantMessageId: undefined,
    pendingToolResults: new Map(),
    persistedToolUseIds: new Set(),
    accumulatedDirectives: [],
    accumulatedToolContentBlocks: [],
    toolContentBlockToolNames: new Map(),
    directiveWarnings: [],
    toolUseIdToName: new Map(),
    currentTurnToolNames: [],
    firstTextDeltaEmitted: false,
    firstThinkingDeltaEmitted: false,
    lastCompletedToolName: undefined,
    toolCallTimestamps: new Map(),
    currentToolUseId: undefined,
    requestIdToToolUseId: new Map(),
    toolConfirmationOutcomes: new Map(),
    currentTurnToolUseIds: [],
  };
}

// ── Shared Helper ────────────────────────────────────────────────────

export function emitLlmCallStartedIfNeeded(
  state: EventHandlerState,
  deps: EventHandlerDeps,
): void {
  if (state.llmCallStartedEmitted) return;
  state.llmCallStartedEmitted = true;
  deps.ctx.traceEmitter.emit(
    "llm_call_started",
    `LLM call to ${deps.ctx.provider.name}`,
    {
      requestId: deps.reqId,
      status: "info",
      attributes: {
        provider: deps.ctx.provider.name,
        model: state.model || "unknown",
      },
    },
  );
}

// ── Client Payload Size Caps ─────────────────────────────────────────
// The client truncates tool results anyway (2 000 chars in ChatViewModel),
// but the full string can be megabytes (file_read, bash output). Capping
// here avoids sending oversized payloads which get decoded on the
// client's main thread.

const TOOL_RESULT_MAX_CHARS = 2_000;
const TOOL_RESULT_TRUNCATION_SUFFIX = "...[truncated]";

// tool_input_delta streams accumulated JSON as tools run. For non-app
// tools the client discards it (extractCodePreview only handles app tools),
// so we cap it aggressively to avoid excessive client traffic.
const TOOL_INPUT_DELTA_MAX_CHARS = 50_000;
const APP_TOOL_NAMES = new Set(["app_create", "app_update"]);

function truncateForClient(
  value: string,
  maxChars: number,
  suffix: string,
): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars - suffix.length) + suffix;
}

// ── Friendly Tool Names ──────────────────────────────────────────────

const TOOL_FRIENDLY_NAMES: Record<string, string> = {
  bash: "command",
  web_search: "web search",
  web_fetch: "web fetch",
  file_read: "file read",
  file_write: "file write",
  file_edit: "file edit",
  browser_navigate: "browser",
  browser_click: "browser",
  browser_type: "browser",
  browser_screenshot: "browser",
  browser_scroll: "browser",
  browser_wait: "browser",
  app_create: "app",
  app_update: "app",
  skill_load: "skill",
  skill_execute: "skill",
  app_file_edit: "app file",
  app_file_write: "app file",
};

function friendlyToolName(name: string): string {
  return TOOL_FRIENDLY_NAMES[name] ?? name.replace(/_/g, " ");
}

// ── Individual Handlers ──────────────────────────────────────────────

export function handleTextDelta(
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
      deps.ctx.emitActivityState(
        "streaming",
        "first_text_delta",
        "assistant_turn",
        deps.reqId,
      );
    }
    deps.onEvent({
      type: "assistant_text_delta",
      text: drained.emitText,
      sessionId: deps.ctx.conversationId,
    });
    if (deps.shouldGenerateTitle) state.firstAssistantText += drained.emitText;
  }
}

export function handleThinkingDelta(
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
      deps.ctx.emitActivityState(
        "thinking",
        "thinking_delta",
        "assistant_turn",
        deps.reqId,
        statusText,
      );
    }
  }
  if (!deps.ctx.streamThinking) return;
  emitLlmCallStartedIfNeeded(state, deps);
  deps.onEvent({ type: "assistant_thinking_delta", thinking: event.thinking });
}

export function handleToolUse(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "tool_use" }>,
): void {
  state.toolUseIdToName.set(event.id, event.name);
  state.currentTurnToolNames.push(event.name);
  state.toolCallTimestamps.set(event.id, { startedAt: Date.now() });
  state.currentToolUseId = event.id;
  state.currentTurnToolUseIds.push(event.id);
  const statusText = `Running ${friendlyToolName(event.name)}`;
  deps.ctx.emitActivityState(
    "tool_running",
    "tool_use_start",
    "assistant_turn",
    deps.reqId,
    statusText,
  );
  deps.onEvent({
    type: "tool_use_start",
    toolName: event.name,
    input: event.input,
    sessionId: deps.ctx.conversationId,
    toolUseId: event.id,
  });
}

export function handleToolUsePreviewStart(
  _state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "tool_use_preview_start" }>,
): void {
  deps.onEvent({
    type: "tool_use_preview_start",
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    sessionId: deps.ctx.conversationId,
  });
  const statusText = `Preparing ${friendlyToolName(event.toolName)}...`;
  deps.ctx.emitActivityState(
    "tool_running",
    "preview_start",
    "assistant_turn",
    deps.reqId,
    statusText,
  );
}

export function handleToolOutputChunk(
  _state: EventHandlerState,
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
      sessionId: deps.ctx.conversationId,
      toolUseId: event.toolUseId,
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
      sessionId: deps.ctx.conversationId,
      toolUseId: event.toolUseId,
    });
  }
}

export function handleInputJsonDelta(
  _state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "input_json_delta" }>,
): void {
  // Cap non-app tool input deltas — the client only uses this data for
  // app_create/app_update code previews; all other tools discard it.
  const content = APP_TOOL_NAMES.has(event.toolName)
    ? event.accumulatedJson
    : truncateForClient(
        event.accumulatedJson,
        TOOL_INPUT_DELTA_MAX_CHARS,
        TOOL_RESULT_TRUNCATION_SUFFIX,
      );
  deps.onEvent({
    type: "tool_input_delta",
    toolName: event.toolName,
    content,
    sessionId: deps.ctx.conversationId,
    toolUseId: event.toolUseId,
  });
}

export function handleToolResult(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "tool_result" }>,
): void {
  const imageBlock = event.contentBlocks?.find(
    (b): b is ImageContent => b.type === "image",
  );
  deps.onEvent({
    type: "tool_result",
    toolName: "",
    result: truncateForClient(
      event.content,
      TOOL_RESULT_MAX_CHARS,
      TOOL_RESULT_TRUNCATION_SUFFIX,
    ),
    isError: event.isError,
    diff: event.diff,
    status: event.status,
    sessionId: deps.ctx.conversationId,
    imageData: imageBlock?.source.data,
    toolUseId: event.toolUseId,
  });
  state.pendingToolResults.set(event.toolUseId, {
    content: event.content,
    isError: event.isError,
    contentBlocks: event.contentBlocks,
  });

  // Record tool completion timestamp
  const ts = state.toolCallTimestamps.get(event.toolUseId);
  if (ts) ts.completedAt = Date.now();
  state.currentToolUseId = undefined;

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
  deps.ctx.emitActivityState(
    "thinking",
    "tool_result_received",
    "assistant_turn",
    deps.reqId,
    statusText,
  );

  // Once all tools for this turn have completed, annotate the persisted
  // assistant message with timing and confirmation metadata.
  const allToolsDone = state.currentTurnToolUseIds.every((id) => {
    const ts = state.toolCallTimestamps.get(id);
    return ts && ts.completedAt != null;
  });
  if (allToolsDone && state.currentTurnToolUseIds.length > 0) {
    annotatePersistedAssistantMessage(state, deps);
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

export function handleError(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "error" }>,
): void {
  if (isProviderOrderingError(event.error.message)) {
    state.orderingErrorDetected = true;
    state.deferredOrderingError = event.error.message;
  } else if (isContextTooLarge(event.error.message)) {
    state.contextTooLargeDetected = true;
    state.contextTooLargeErrorMessage = event.error.message;
  } else {
    const classified = classifySessionError(event.error, {
      phase: "agent_loop",
    });
    if (classified.code === "CONTEXT_TOO_LARGE") {
      state.contextTooLargeDetected = true;
      state.contextTooLargeErrorMessage = event.error.message;
    } else if (
      classified.code === "PROVIDER_ORDERING" ||
      classified.code === "PROVIDER_WEB_SEARCH"
    ) {
      // Ordering errors detected via classifySessionError (e.g. from ProviderError
      // with statusCode 400 and ordering message) — trigger the retry path.
      state.orderingErrorDetected = true;
      state.deferredOrderingError = event.error.message;
    } else {
      deps.onEvent(
        buildSessionErrorMessage(deps.ctx.conversationId, classified),
      );
      state.providerErrorUserMessage = classified.userMessage;
    }
  }
}

export async function handleMessageComplete(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "message_complete" }>,
): Promise<void> {
  // Reset per-turn tool tracking for the new turn.
  state.currentTurnToolUseIds = [];

  // Flush any remaining directive display buffer
  if (state.pendingDirectiveDisplayBuffer.length > 0) {
    deps.onEvent({
      type: "assistant_text_delta",
      text: state.pendingDirectiveDisplayBuffer,
      sessionId: deps.ctx.conversationId,
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
        content: result.content,
        is_error: result.isError,
        ...(result.contentBlocks
          ? { contentBlocks: result.contentBlocks }
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
    await addMessage(
      deps.ctx.conversationId,
      "user",
      JSON.stringify(toolResultBlocks),
      toolResultMetadata,
    );
    for (const id of state.pendingToolResults.keys()) {
      state.persistedToolUseIds.add(id);
    }
    state.pendingToolResults.clear();
  }

  // Clean assistant content and accumulate directives
  const {
    cleanedContent,
    directives: msgDirectives,
    warnings: msgWarnings,
  } = cleanAssistantContent(event.message.content);
  const cleanedBlocks = cleanedContent as ContentBlock[];
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

  // Build content with UI surfaces
  const contentWithSurfaces: ContentBlock[] = [...cleanedBlocks];
  for (const surface of deps.ctx.currentTurnSurfaces) {
    contentWithSurfaces.push({
      type: "ui_surface",
      surfaceId: surface.surfaceId,
      surfaceType: surface.surfaceType,
      title: surface.title,
      data: surface.data,
      actions: surface.actions,
      display: surface.display,
    } as unknown as ContentBlock);
  }

  const assistantChannelMetadata = {
    ...provenanceFromTrustContext(deps.ctx.trustContext),
    userMessageChannel: deps.turnChannelContext.userMessageChannel,
    assistantMessageChannel: deps.turnChannelContext.assistantMessageChannel,
    userMessageInterface: deps.turnInterfaceContext.userMessageInterface,
    assistantMessageInterface:
      deps.turnInterfaceContext.assistantMessageInterface,
  };
  const assistantMsg = await addMessage(
    deps.ctx.conversationId,
    "assistant",
    JSON.stringify(contentWithSurfaces),
    assistantChannelMetadata,
  );
  state.lastAssistantMessageId = assistantMsg.id;

  deps.ctx.currentTurnSurfaces = [];

  // Emit trace event
  const charCount = cleanedBlocks
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

export function handleUsage(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: Extract<AgentEvent, { type: "usage" }>,
): void {
  state.exchangeInputTokens += event.inputTokens;
  state.exchangeCacheCreationInputTokens += event.cacheCreationInputTokens ?? 0;
  state.exchangeCacheReadInputTokens += event.cacheReadInputTokens ?? 0;
  state.exchangeOutputTokens += event.outputTokens;
  state.model = event.model;
  if (event.rawResponse !== undefined) {
    state.exchangeRawResponses.push(event.rawResponse);
  }

  if (event.rawRequest && event.rawResponse) {
    try {
      recordRequestLog(
        deps.ctx.conversationId,
        JSON.stringify(event.rawRequest),
        JSON.stringify(event.rawResponse),
      );
    } catch (err) {
      deps.rlog.warn({ err }, "Failed to persist LLM request log (non-fatal)");
    }
  }

  emitLlmCallStartedIfNeeded(state, deps);

  deps.ctx.traceEmitter.emit(
    "llm_call_finished",
    `LLM call to ${deps.ctx.provider.name} finished`,
    {
      requestId: deps.reqId,
      status: "success",
      attributes: {
        provider: deps.ctx.provider.name,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        latencyMs: event.providerDurationMs,
      },
    },
  );
  state.llmCallStartedEmitted = false;
}

// ── Dispatcher ───────────────────────────────────────────────────────

/** Routes an AgentEvent to the appropriate handler. */
export async function dispatchAgentEvent(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  event: AgentEvent,
): Promise<void> {
  switch (event.type) {
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
      const friendlyNames: Record<string, string> = {
        web_search: "Searching the web",
      };
      const statusText = friendlyNames[event.name] ?? `Running ${event.name}`;
      deps.ctx.emitActivityState(
        "tool_running",
        "tool_use_start",
        "assistant_turn",
        deps.reqId,
        statusText,
      );
      // Emit tool_use_start so the client renders a tool chip (like other tools)
      deps.onEvent({
        type: "tool_use_start",
        toolName: event.name,
        input: event.input,
        sessionId: deps.ctx.conversationId,
        toolUseId: event.toolUseId,
      });
      break;
    }
    case "server_tool_complete": {
      deps.ctx.emitActivityState(
        "streaming",
        "tool_result_received",
        "assistant_turn",
        deps.reqId,
      );
      deps.onEvent({
        type: "tool_result",
        toolName: "",
        result: "",
        isError: false,
        sessionId: deps.ctx.conversationId,
        toolUseId: event.toolUseId,
      });
      break;
    }
    case "error":
      handleError(state, deps, event);
      break;
    case "message_complete":
      await handleMessageComplete(state, deps, event);
      break;
    case "usage":
      handleUsage(state, deps, event);
      break;
  }
}
