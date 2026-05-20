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

import type { DisplayAttachment, DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import type { Surface } from "@/domains/chat/lib/types.js";
import { newStableId } from "@/domains/chat/utils/stable-id.js";
import type { AllowlistOption, ChatMessageToolCall, DirectoryScopeOption, ScopeOption } from "@/domains/chat/api/event-types.js";

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

// ---------------------------------------------------------------------------
// assistant_text_delta
// ---------------------------------------------------------------------------

/** Create a new streaming assistant bubble for the first text delta. */
export function createStreamingBubble(
  prev: DisplayMessage[],
  text: string,
  messageId?: string,
  stableId?: string,
): DisplayMessage[] {
  return [
    ...prev,
    {
      stableId: stableId ?? newStableId("assistant-stream"),
      id: messageId,
      ...(messageId ? { daemonMessageId: messageId } : {}),
      role: "assistant",
      content: text,
      isStreaming: true,
      textSegments: [{ type: "text", content: text }],
      contentOrder: [{ type: "text", id: "0" }],
      timestamp: Date.now(),
    },
  ];
}

/** Append text to the last streaming assistant bubble. */
export function appendTextDelta(
  prev: DisplayMessage[],
  text: string,
  messageId?: string,
): DisplayMessage[] {
  const last = prev[prev.length - 1];
  if (!last || last.role !== "assistant" || !last.isStreaming) return prev;

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

  return [
    ...prev.slice(0, -1),
    {
      ...last,
      content: last.content + text,
      id: messageId ?? last.id,
      daemonMessageId: messageId ?? last.daemonMessageId,
      textSegments: segments,
      contentOrder: order,
    },
  ];
}

// ---------------------------------------------------------------------------
// assistant_activity_state (idle)
// ---------------------------------------------------------------------------

/** Finalize running tool calls on the last streaming message (idle signal). */
export function finalizeOnIdle(prev: DisplayMessage[]): DisplayMessage[] {
  const last = prev[prev.length - 1];
  if (!last || last.role !== "assistant" || !last.isStreaming) return prev;

  const finalized = finalizeRunningToolCalls(last.toolCalls);
  if (!finalized) return prev;

  return [...prev.slice(0, -1), { ...last, toolCalls: finalized }];
}

// ---------------------------------------------------------------------------
// message_complete
// ---------------------------------------------------------------------------

/** Finalize a streaming message with its completed content and attachments. */
export function finalizeMessageComplete(
  prev: DisplayMessage[],
  opts: {
    content?: string;
    rowMessageId?: string;
    displayMessageId?: string;
    attachments?: DisplayAttachment[];
  },
): DisplayMessage[] {
  const { content, rowMessageId, displayMessageId, attachments } = opts;
  const last = prev[prev.length - 1];

  if (last?.role === "assistant" && last.isStreaming) {
    const finalized = finalizeRunningToolCalls(last.toolCalls);
    return [
      ...prev.slice(0, -1),
      {
        ...last,
        isStreaming: false,
        id: displayMessageId ?? last.id,
        ...(rowMessageId ? { daemonMessageId: rowMessageId } : {}),
        content: content || last.content,
        ...(attachments ? { attachments } : {}),
        ...(finalized ? { toolCalls: finalized } : {}),
      },
    ];
  }

  if (content || attachments) {
    if (displayMessageId && prev.some((m) => m.id === displayMessageId)) {
      return prev.map((m) =>
        m.id === displayMessageId
          ? {
              ...m,
              ...(rowMessageId ? { daemonMessageId: rowMessageId } : {}),
              ...(content ? { content } : {}),
              ...(attachments && !m.attachments ? { attachments } : {}),
            }
          : m,
      );
    }
    return [
      ...prev,
      {
        stableId: newStableId("assistant-complete"),
        id: displayMessageId,
        ...(rowMessageId ? { daemonMessageId: rowMessageId } : {}),
        role: "assistant" as const,
        content: content ?? "",
        timestamp: Date.now(),
        ...(attachments ? { attachments } : {}),
      },
    ];
  }

  return prev;
}

// ---------------------------------------------------------------------------
// generation_handoff / stream stop
// ---------------------------------------------------------------------------

/** Stop streaming on the last assistant message (handoff or cancellation). */
export function stopStreaming(
  prev: DisplayMessage[],
  opts?: { displayMessageId?: string; rowMessageId?: string },
): DisplayMessage[] {
  const last = prev[prev.length - 1];
  if (!last || last.role !== "assistant" || !last.isStreaming) return prev;

  return [
    ...prev.slice(0, -1),
    {
      ...last,
      isStreaming: false,
      ...(opts?.displayMessageId ? { id: opts.displayMessageId } : {}),
      ...(opts?.rowMessageId
        ? { daemonMessageId: opts.rowMessageId }
        : {}),
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
    targetIdx = prev.findIndex(
      (m) => m.id === messageId || m.daemonMessageId === messageId,
    );
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
    updated.push({
      stableId: newStableId("assistant-surface"),
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

/** Insert or update a tool call on an assistant message. */
export function upsertToolCall(
  prev: DisplayMessage[],
  toolCall: ChatMessageToolCall,
  shouldCreateNewBubble: boolean,
  stableId?: string,
): DisplayMessage[] {
  const lastIdx = prev.length - 1;
  const last = prev[lastIdx];

  if (
    !shouldCreateNewBubble &&
    last?.role === "assistant" &&
    last.isStreaming
  ) {
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

  return [
    ...prev,
    {
      stableId: stableId ?? newStableId("assistant-tool"),
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
  if (!existingTc) return prev;

  const updatedToolCalls = [...msg.toolCalls];
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
    completedAt: Date.now(),
  };

  const updated = [...prev];
  updated[msgIdx] = { ...msg, toolCalls: updatedToolCalls };
  return updated;
}

// ---------------------------------------------------------------------------
// Queue updaters
// ---------------------------------------------------------------------------

/** Set queue position on a message by stable ID. */
export function setQueuePosition(
  prev: DisplayMessage[],
  stableId: string,
  position: number,
): DisplayMessage[] {
  return prev.map((m) =>
    m.stableId === stableId ? { ...m, queuePosition: position } : m,
  );
}

/** Clear queue status on a message by stable ID. */
export function clearQueueStatus(
  prev: DisplayMessage[],
  stableId: string,
): DisplayMessage[] {
  return prev.map((m) =>
    m.stableId === stableId
      ? { ...m, queueStatus: undefined, queuePosition: undefined }
      : m,
  );
}

/** Remove a queued message by stable ID. */
export function removeQueuedMessage(
  prev: DisplayMessage[],
  stableId: string,
): DisplayMessage[] {
  return prev.filter((m) => m.stableId !== stableId);
}
