/**
 * Pure message-array updater functions for SSE stream events.
 *
 * Each function has the signature `(prev: DisplayMessage[], ...args) => DisplayMessage[]`
 * — the same shape React expects for `setMessages(updater)`. Extracting them
 * from the hook makes the state transitions testable in isolation and keeps
 * the hook itself a thin orchestrator of side-effects + state updates.
 *
 * @see https://react.dev/reference/react/useState#updating-state-based-on-the-previous-state
 */

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import type { Surface } from "@/domains/chat/types/types";
import { toDisplayAttachments } from "@/domains/chat/api/event-parser";
import type { AllowlistOption, ChatMessageToolCall, DirectoryScopeOption, MessageCompleteEvent, ScopeOption } from "@/domains/chat/api/event-types";
import type { ToolActivityMetadata } from "@/assistant/web-activity-types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Mark all "running" tool calls as "completed" with a timestamp. */
export function finalizeRunningToolCalls(
  toolCalls: ChatMessageToolCall[] | undefined,
): ChatMessageToolCall[] | undefined {
  if (!toolCalls) return undefined;
  return toolCalls.map((tc) =>
    tc.status === "running"
      ? { ...tc, status: "completed" as const, completedAt: Date.now() }
      : tc,
  );
}

/**
 * Whether the next streaming chunk should extend the tail bubble or start
 * a fresh one. Derived directly from the message array — the boundary
 * events that previously latched this decision (idle, message_complete,
 * generation_handoff, generation_cancelled, dequeued, conversation switch)
 * all leave the tail in a state where `isStreaming` is either `false` or
 * the tail is no longer an assistant row, so the derivation answers
 * correctly without any shared flag.
 */
export function tailIsStreamingAssistant(prev: DisplayMessage[]): boolean {
  const last = prev[prev.length - 1];
  return !!last && last.role === "assistant" && !!last.isStreaming;
}

// ---------------------------------------------------------------------------
// assistant_text_delta
// ---------------------------------------------------------------------------

/** Create a new streaming assistant bubble for the first text delta. */
export function createStreamingBubble(
  prev: DisplayMessage[],
  text: string,
  messageId?: string,
): DisplayMessage[] {
  return [
    ...prev,
    {
      id: messageId ?? crypto.randomUUID(),
      ...(messageId ? {} : { isOptimistic: true }),
      role: "assistant",
      content: text,
      isStreaming: true,
      textSegments: [{ type: "text", content: text }],
      contentOrder: [{ type: "text", id: "0" }],
      timestamp: Date.now(),
    },
  ];
}

/**
 * Append text to the streaming assistant tail bubble, creating one if the
 * tail isn't a streaming assistant row.
 *
 * The "should I open a new bubble" question is derived from the message
 * array itself — when the previous turn finalized (via `finalizeOnIdle`,
 * `finalizeMessageComplete`, `stopStreaming`, conversation switch, or a
 * user message append), the tail's `isStreaming` flag is already false
 * (or the tail is no longer an assistant row), so this updater branches
 * to `createStreamingBubble` without needing a shared latch.
 */
export function appendTextDelta(
  prev: DisplayMessage[],
  text: string,
  messageId?: string,
): DisplayMessage[] {
  if (!tailIsStreamingAssistant(prev)) {
    return createStreamingBubble(prev, text, messageId);
  }

  const last = prev[prev.length - 1]!;
  const segments = [...(last.textSegments ?? [])];
  const order = [...(last.contentOrder ?? [])];
  const lastOrderEntry = order[order.length - 1];

  if (lastOrderEntry?.type === "text" && segments.length > 0) {
    const lastSeg = segments[segments.length - 1];
    if (lastSeg) {
      segments[segments.length - 1] = {
        ...lastSeg,
        content: lastSeg.content + text,
      };
    }
  } else {
    const newIndex = segments.length;
    segments.push({ type: "text", content: text });
    order.push({ type: "text", id: String(newIndex) });
  }

  // First-id-wins: keep the original anchor even if a later delta carries
  // a different `messageId`. The id is locked from bubble creation.
  return [
    ...prev.slice(0, -1),
    {
      ...last,
      content: last.content + text,
      textSegments: segments,
      contentOrder: order,
    },
  ];
}

// ---------------------------------------------------------------------------
// assistant_activity_state (idle)
// ---------------------------------------------------------------------------

/**
 * Finalize all streaming assistant messages when the daemon signals turn
 * idle. Sets `isStreaming: false` on each streaming assistant row and
 * marks any running tool calls as completed.
 *
 * Flipping `isStreaming` here is what lets `appendTextDelta` /
 * `upsertToolCall` derive "next chunk should open a new bubble" from the
 * message array alone — without this, the previous turn's tail would
 * still look like a streaming assistant when the next turn's first chunk
 * arrives, and the next chunk would erroneously extend it.
 */
export function finalizeOnIdle(prev: DisplayMessage[]): DisplayMessage[] {
  let changed = false;
  const updated = prev.map((m) => {
    if (m.role !== "assistant" || !m.isStreaming) return m;
    changed = true;
    const finalized = finalizeRunningToolCalls(m.toolCalls);
    return {
      ...m,
      isStreaming: false,
      ...(finalized ? { toolCalls: finalized } : {}),
    };
  });
  return changed ? updated : prev;
}

// ---------------------------------------------------------------------------
// message_complete
// ---------------------------------------------------------------------------

/**
 * Apply a `message_complete` event to the message array.
 *
 * Decision is role-based on the tail:
 *   - tail is user (or array empty) → push a new finalized assistant bubble
 *     stamped with `event.messageId`. This covers the start-of-turn case
 *     where no streaming bubble was opened (e.g. tool-only or aux turns).
 *   - tail is assistant → finalize it: flip `isStreaming: false`, complete
 *     any running tool calls, merge in `event.content` / `event.attachments`,
 *     **keep `tail.id`**. Subsequent `message_complete` events from later
 *     LLM calls in the same agent turn fold into the same bubble — the
 *     mirror of the daemon's server-side merge which collapses to the first
 *     row's id.
 */
export function finalizeMessageComplete(
  prev: DisplayMessage[],
  event: MessageCompleteEvent,
): DisplayMessage[] {
  const last = prev[prev.length - 1];
  const attachments = toDisplayAttachments(event.attachments);

  if (last?.role !== "assistant") {
    if (!event.content && !attachments) return prev;
    return [
      ...prev,
      {
        id: event.messageId ?? crypto.randomUUID(),
        ...(event.messageId ? {} : { isOptimistic: true }),
        role: "assistant" as const,
        content: event.content ?? "",
        timestamp: Date.now(),
        ...(attachments ? { attachments } : {}),
      },
    ];
  }

  const finalized = finalizeRunningToolCalls(last.toolCalls);
  return [
    ...prev.slice(0, -1),
    {
      ...last,
      isStreaming: false,
      // Keep `last.id` — the anchor was locked by the first text_delta /
      // tool_use of the turn. The daemon may advance its internal row id
      // across multiple LLM calls, but each call's `event.messageId` is
      // just a constituent of this display row.
      content: event.content || last.content,
      ...(attachments ? { attachments } : {}),
      ...(finalized ? { toolCalls: finalized } : {}),
    },
  ];
}

// ---------------------------------------------------------------------------
// generation_handoff / stream stop
// ---------------------------------------------------------------------------

/**
 * Stop streaming on the tail assistant bubble (handoff or cancellation).
 * Keeps `tail.id` — same anchor preservation as `finalizeMessageComplete`.
 */
export function stopStreaming(prev: DisplayMessage[]): DisplayMessage[] {
  const last = prev[prev.length - 1];
  if (!last || last.role !== "assistant" || !last.isStreaming) return prev;

  return [
    ...prev.slice(0, -1),
    {
      ...last,
      isStreaming: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// conversation_error
// ---------------------------------------------------------------------------

/** Handle conversation error: finalize tool calls, remove empty bubbles. */
export function handleConversationError(
  prev: DisplayMessage[],
): DisplayMessage[] {
  const lastIdx = prev.length - 1;
  const last = prev[lastIdx];
  if (!last || last.role !== "assistant" || !last.isStreaming) return prev;

  const finalized = finalizeRunningToolCalls(last.toolCalls);
  const hasContent =
    last.content.trim().length > 0 ||
    (last.toolCalls != null && last.toolCalls.length > 0);

  if (!hasContent) return prev.slice(0, -1);

  const updated = [...prev];
  updated[lastIdx] = {
    ...last,
    isStreaming: false,
    ...(finalized ? { toolCalls: finalized } : {}),
  };
  return updated;
}

// ---------------------------------------------------------------------------
// ui_surface_show
// ---------------------------------------------------------------------------

/** Attach a new surface to the appropriate assistant message. */
export function attachSurface(
  prev: DisplayMessage[],
  surface: Surface,
  messageId?: string,
): DisplayMessage[] {
  let targetIdx = -1;

  if (messageId) {
    targetIdx = prev.findIndex((m) => m.id === messageId);
  }
  if (targetIdx === -1) {
    for (let i = prev.length - 1; i >= 0; i--) {
      if (prev[i]?.role === "assistant" && prev[i]?.isStreaming) {
        targetIdx = i;
        break;
      }
    }
  }
  if (targetIdx === -1) {
    for (let i = prev.length - 1; i >= 0; i--) {
      if (prev[i]?.role === "assistant") {
        targetIdx = i;
        break;
      }
    }
  }

  const updated = [...prev];
  if (targetIdx === -1) {
    // Surface-only assistant rows have no wire messageId — `ui_surface_*`
    // events identify by surfaceId, not message. The row gets its server
    // id when a later message_complete or history fetch lands.
    updated.push({
      id: crypto.randomUUID(),
      isOptimistic: true,
      role: "assistant" as const,
      content: "",
      isStreaming: true,
      surfaces: [surface],
      contentOrder: [{ type: "surface", id: surface.surfaceId }],
      timestamp: Date.now(),
    });
  } else {
    const target = prev[targetIdx]!;
    if (
      target.contentOrder?.some(
        (e) => e.type === "surface" && e.id === surface.surfaceId,
      ) ||
      target.surfaces?.some((s) => s.surfaceId === surface.surfaceId)
    ) {
      return prev;
    }
    updated[targetIdx] = {
      ...target,
      surfaces: [...(target.surfaces ?? []), surface],
      contentOrder: [
        ...(target.contentOrder ?? []),
        { type: "surface", id: surface.surfaceId },
      ],
    };
  }
  return updated;
}

// ---------------------------------------------------------------------------
// ui_surface_update
// ---------------------------------------------------------------------------

/** Merge new data into an existing surface. */
export function updateSurfaceData(
  prev: DisplayMessage[],
  surfaceId: string,
  data: Record<string, unknown>,
): DisplayMessage[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    const msg = prev[i]!;
    const surfIdx =
      msg.surfaces?.findIndex((s) => s.surfaceId === surfaceId) ?? -1;
    if (surfIdx === -1) continue;

    const surface = msg.surfaces![surfIdx]!;
    const mergedData = { ...surface.data, ...data };
    if (
      surface.data.templateData &&
      data.templateData &&
      typeof surface.data.templateData === "object" &&
      typeof data.templateData === "object"
    ) {
      mergedData.templateData = {
        ...(surface.data.templateData as Record<string, unknown>),
        ...(data.templateData as Record<string, unknown>),
      };
    }
    const updated = [...prev];
    const newSurfaces = [...msg.surfaces!];
    newSurfaces[surfIdx] = { ...surface, data: mergedData };
    updated[i] = { ...msg, surfaces: newSurfaces };
    return updated;
  }
  return prev;
}

// ---------------------------------------------------------------------------
// ui_surface_dismiss
// ---------------------------------------------------------------------------

/** Remove a dismissed surface from its message. */
export function dismissSurface(
  prev: DisplayMessage[],
  surfaceId: string,
): DisplayMessage[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (!prev[i]!.surfaces?.some((s) => s.surfaceId === surfaceId)) continue;
    const updated = [...prev];
    updated[i] = {
      ...prev[i]!,
      surfaces: prev[i]!.surfaces?.filter((s) => s.surfaceId !== surfaceId),
      contentOrder: prev[i]!.contentOrder?.filter(
        (e) => !(e.type === "surface" && e.id === surfaceId),
      ),
    };
    return updated;
  }
  return prev;
}

// ---------------------------------------------------------------------------
// ui_surface_complete
// ---------------------------------------------------------------------------

/** Mark a surface as completed with an optional summary. */
export function completeSurface(
  prev: DisplayMessage[],
  surfaceId: string,
  summary?: string,
): DisplayMessage[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (!prev[i]!.surfaces?.some((s) => s.surfaceId === surfaceId)) continue;
    const updated = [...prev];
    updated[i] = {
      ...prev[i]!,
      surfaces: prev[i]!.surfaces?.map((s) =>
        s.surfaceId === surfaceId
          ? { ...s, completed: true, completionSummary: summary }
          : s,
      ),
    };
    return updated;
  }
  return prev;
}

// ---------------------------------------------------------------------------
// tool_use_start
// ---------------------------------------------------------------------------

/**
 * Insert or update a tool call on the streaming assistant tail bubble,
 * creating a new bubble if the tail isn't a streaming assistant row.
 *
 * The bubble-creation decision is derived from `prev` itself — no shared
 * latch passes through. Same finalization invariant as `appendTextDelta`:
 * boundary events leave the tail with `isStreaming: false` (or non-
 * assistant), so this updater opens a fresh bubble correctly.
 */
export function upsertToolCall(
  prev: DisplayMessage[],
  toolCall: ChatMessageToolCall,
): DisplayMessage[] {
  if (tailIsStreamingAssistant(prev)) {
    const lastIdx = prev.length - 1;
    const last = prev[lastIdx]!;
    const existingIdx =
      last.toolCalls?.findIndex((tc) => tc.id === toolCall.id) ?? -1;
    if (existingIdx !== -1) {
      const updated = [...prev];
      const updatedToolCalls = [...(last.toolCalls ?? [])];
      updatedToolCalls[existingIdx] = {
        ...updatedToolCalls[existingIdx]!,
        ...toolCall,
      };
      updated[lastIdx] = { ...last, toolCalls: updatedToolCalls };
      return updated;
    }
    const updated = [...prev];
    updated[lastIdx] = {
      ...last,
      toolCalls: [...(last.toolCalls ?? []), toolCall],
      contentOrder: [
        ...(last.contentOrder ?? []),
        { type: "toolCall", id: toolCall.id },
      ],
    };
    return updated;
  }

  // Tool-only assistant rows have no wire messageId — `tool_use_*` events
  // identify by toolCall.id, not message. The row gets its server id when
  // a later message_complete or history fetch lands.
  return [
    ...prev,
    {
      id: crypto.randomUUID(),
      isOptimistic: true,
      role: "assistant" as const,
      content: "",
      isStreaming: true,
      toolCalls: [toolCall],
      contentOrder: [{ type: "toolCall", id: toolCall.id }],
      timestamp: Date.now(),
    },
  ];
}

// ---------------------------------------------------------------------------
// tool_result
// ---------------------------------------------------------------------------

/** Apply a tool result to the matching tool call. */
export function applyToolResult(
  prev: DisplayMessage[],
  opts: {
    toolUseId?: string;
    result?: string;
    isError?: boolean;
    riskLevel?: string;
    riskReason?: string;
    matchedTrustRuleId?: string;
    approvalMode?: string;
    approvalReason?: string;
    riskThreshold?: string;
    allowlistOptions?: AllowlistOption[];
    scopeOptions?: ScopeOption[];
    directoryScopeOptions?: DirectoryScopeOption[];
    /**
     * Structured activity metadata from the tool_result event. Persisted on
     * the tool call so the new `WebSearchProgressCard` can keep rendering
     * after the active turn ends and `liveWebActivity` is cleared.
     */
    activityMetadata?: ToolActivityMetadata;
  },
): DisplayMessage[] {
  // When we have a toolUseId, search all assistant messages (in reverse) for
  // the matching tool call — the tool call may live on an earlier message if
  // a new bubble was created between tool_use_start and tool_result.
  let msgIdx = -1;
  let tcIdx = -1;

  if (opts.toolUseId) {
    for (let i = prev.length - 1; i >= 0; i--) {
      const m = prev[i];
      if (m?.role !== "assistant" || !m.toolCalls?.length) continue;
      const j = m.toolCalls.findIndex((tc) => tc.id === opts.toolUseId);
      if (j !== -1) {
        msgIdx = i;
        tcIdx = j;
        break;
      }
    }
  }

  // Fallback: no toolUseId or not found — use the last assistant message
  // with any running tool call (legacy behavior).
  if (msgIdx === -1) {
    msgIdx = prev.findLastIndex(
      (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
    );
    if (msgIdx === -1) return prev;
    const msg = prev[msgIdx];
    if (!msg?.toolCalls) return prev;
    tcIdx = msg.toolCalls.findLastIndex((tc) => tc.status === "running");
  }

  if (tcIdx === -1) return prev;

  const msg = prev[msgIdx]!;
  const existingTc = msg.toolCalls![tcIdx];
  if (!existingTc) return prev;

  const updatedToolCalls = [...msg.toolCalls!];
  updatedToolCalls[tcIdx] = {
    ...existingTc,
    status: opts.isError ? "error" : "completed",
    result: opts.result,
    isError: opts.isError,
    riskLevel: opts.riskLevel,
    riskReason: opts.riskReason,
    matchedTrustRuleId: opts.matchedTrustRuleId,
    approvalMode: opts.approvalMode,
    approvalReason: opts.approvalReason,
    riskThreshold: opts.riskThreshold,
    allowlistOptions: opts.allowlistOptions,
    scopeOptions: opts.scopeOptions,
    directoryScopeOptions: opts.directoryScopeOptions,
    // Preserve any pre-existing metadata when the new event omits it
    // (no overwrite with undefined on re-applied tool results).
    ...(opts.activityMetadata !== undefined
      ? { activityMetadata: opts.activityMetadata }
      : {}),
    completedAt: Date.now(),
  };

  const updated = [...prev];
  updated[msgIdx] = { ...msg, toolCalls: updatedToolCalls };
  return updated;
}

// ---------------------------------------------------------------------------
// tool_progress
// ---------------------------------------------------------------------------

/** Apply a tool_progress heartbeat to the matching running tool call. */
export function applyToolProgress(
  prev: DisplayMessage[],
  opts: {
    toolUseId?: string;
    elapsedSec: number;
    timeoutSec: number;
  },
): DisplayMessage[] {
  const msgIdx = prev.findLastIndex(
    (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
  );
  if (msgIdx === -1) return prev;

  const msg = prev[msgIdx];
  if (!msg?.toolCalls) return prev;

  let tcIdx = opts.toolUseId
    ? msg.toolCalls.findIndex((tc) => tc.id === opts.toolUseId)
    : -1;
  if (tcIdx === -1) {
    tcIdx = msg.toolCalls.findLastIndex((tc) => tc.status === "running");
  }
  if (tcIdx === -1) return prev;

  const existingTc = msg.toolCalls[tcIdx];
  if (!existingTc || existingTc.status !== "running") return prev;

  const updatedToolCalls = [...msg.toolCalls];
  updatedToolCalls[tcIdx] = {
    ...existingTc,
    progressElapsedSec: opts.elapsedSec,
    progressTimeoutSec: opts.timeoutSec,
    lastProgressAt: Date.now(),
  };

  const updated = [...prev];
  updated[msgIdx] = { ...msg, toolCalls: updatedToolCalls };
  return updated;
}

// ---------------------------------------------------------------------------
// Queue updaters
// ---------------------------------------------------------------------------

/** Set queue position on a message by id. */
export function setQueuePosition(
  prev: DisplayMessage[],
  id: string,
  position: number,
): DisplayMessage[] {
  return prev.map((m) =>
    m.id === id ? { ...m, queuePosition: position } : m,
  );
}

/** Clear queue status on a message by id. */
export function clearQueueStatus(
  prev: DisplayMessage[],
  id: string,
): DisplayMessage[] {
  return prev.map((m) =>
    m.id === id
      ? { ...m, queueStatus: undefined, queuePosition: undefined }
      : m,
  );
}

/** Remove a queued message by id. */
export function removeQueuedMessage(
  prev: DisplayMessage[],
  id: string,
): DisplayMessage[] {
  return prev.filter((m) => m.id !== id);
}
