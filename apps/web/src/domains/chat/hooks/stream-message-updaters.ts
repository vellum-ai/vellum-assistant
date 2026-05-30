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
import { toDisplayAttachments } from "@/utils/display-attachments";
import type { AllowlistOption, DirectoryScopeOption, ScopeOption } from "@/types/interaction-ui-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { MessageCompleteEvent } from "@vellumai/assistant-api";
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
/**
 * Append `text` into the message at `prev[idx]`, extending its trailing
 * text segment if the last `contentOrder` entry is text, otherwise opening
 * a new text segment. Stamps `isStreaming: true` because every caller of
 * this helper is mid-turn — including the reconcile-pulled reserved-row
 * case where the existing row arrived without the streaming flag.
 */
function appendTextIntoRow(
  prev: DisplayMessage[],
  idx: number,
  text: string,
): DisplayMessage[] {
  const row = prev[idx]!;
  const segments = [...(row.textSegments ?? [])];
  const order = [...(row.contentOrder ?? [])];
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

  const next = [...prev];
  next[idx] = {
    ...row,
    content: row.content + text,
    isStreaming: true,
    textSegments: segments,
    contentOrder: order,
  };
  return next;
}

/**
 * Apply an `assistant_text_delta` to the message array.
 *
 * **Id-keyed when `messageId` is present** (B2/B3 onward — stamped on
 * every event from event zero of the turn). Looks up the matching
 * assistant row and appends into it regardless of position. Covers the
 * case where reconcile (or `assistant_turn_start`) landed the reserved
 * row in the array ahead of the first delta — without id matching,
 * `tailIsStreamingAssistant(prev)` returns false for that snapshot row
 * and a duplicate streaming bubble opens with the same id.
 *
 * Falls back to tail-based decisioning when `messageId` is absent, for
 * pre-B2 daemons not pinned by the B4 floor bump.
 */
export function appendTextDelta(
  prev: DisplayMessage[],
  text: string,
  messageId?: string,
): DisplayMessage[] {
  if (messageId) {
    const idx = prev.findIndex(
      (m) => m.role === "assistant" && m.id === messageId,
    );
    if (idx >= 0) return appendTextIntoRow(prev, idx, text);
    return createStreamingBubble(prev, text, messageId);
  }

  if (!tailIsStreamingAssistant(prev)) {
    return createStreamingBubble(prev, text, messageId);
  }
  return appendTextIntoRow(prev, prev.length - 1, text);
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
 *     any running tool calls, merge in `event.attachments`. The first
 *     `message_complete` for an *optimistic* row also adopts
 *     `event.messageId` as the row id (clearing `isOptimistic`) so the
 *     post-turn history reconcile matches by id instead of falling back to
 *     brittle content matching — the latter breaks for multi-LLM-call turns
 *     (e.g. subagent spawns) where the daemon's collapsed server content
 *     diverges from the finalized bubble's text, producing a duplicate row.
 *     Subsequent `message_complete` events from later LLM calls in the same
 *     agent turn fold into the same bubble and **keep the adopted id** — the
 *     mirror of the daemon's server-side merge which collapses to the first
 *     row's id (later events carry constituent ids the daemon discards).
 *
 * `message_complete` carries no body content on the wire — turn text streams
 * as `assistant_text_delta` chunks that the assistant bubble accumulates;
 * `message_complete` only finalizes the bubble and (optionally) appends
 * attachments. The "push new bubble" branch produces an empty-content row
 * only when attachments are present.
 */
export function finalizeMessageComplete(
  prev: DisplayMessage[],
  event: MessageCompleteEvent,
): DisplayMessage[] {
  const last = prev[prev.length - 1];
  const attachments = toDisplayAttachments(event.attachments);

  if (last?.role !== "assistant") {
    if (!attachments) return prev;
    return [
      ...prev,
      {
        id: event.messageId ?? crypto.randomUUID(),
        ...(event.messageId ? {} : { isOptimistic: true }),
        role: "assistant" as const,
        content: "",
        timestamp: Date.now(),
        attachments,
      },
    ];
  }

  const finalized = finalizeRunningToolCalls(last.toolCalls);
  // Adopt the server `messageId` the first time it lands for this display row
  // (the bubble is still optimistic), swapping off the optimistic client UUID
  // so the row reconciles by id. Gated on `isOptimistic` so later
  // `message_complete` events in the same multi-LLM-call turn — which carry
  // constituent row ids the daemon collapses away — don't re-stamp the row off
  // its canonical first-row id.
  const adoptServerId = last.isOptimistic === true && !!event.messageId;
  return [
    ...prev.slice(0, -1),
    {
      ...last,
      ...(adoptServerId ? { id: event.messageId!, isOptimistic: false } : {}),
      isStreaming: false,
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
    // No anchor row to attach to — open a fresh bubble. When `messageId`
    // is present we adopt it as the row id (the daemon has already
    // committed to this assistant message). When absent — only possible
    // against pre-anchor-protocol daemons — fall back to a client UUID
    // and stamp `isOptimistic` so reconcile knows the id is a placeholder.
    updated.push({
      id: messageId ?? crypto.randomUUID(),
      ...(messageId ? {} : { isOptimistic: true }),
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
 *
 * **Id-keyed when `messageId` is present** — looks up the matching
 * assistant row by id and folds into it regardless of position. Mirrors
 * `appendTextDelta`'s behavior for the case where reconcile (or
 * `assistant_turn_start`) landed the reserved row in the array ahead of
 * the first `tool_use_start` — without id matching, a duplicate streaming
 * bubble would open with the same anchor id.
 */
export function upsertToolCall(
  prev: DisplayMessage[],
  toolCall: ChatMessageToolCall,
  messageId?: string,
): DisplayMessage[] {
  if (messageId) {
    const idx = prev.findIndex(
      (m) => m.role === "assistant" && m.id === messageId,
    );
    if (idx >= 0) return upsertToolCallIntoRow(prev, idx, toolCall);
  } else if (tailIsStreamingAssistant(prev)) {
    return upsertToolCallIntoRow(prev, prev.length - 1, toolCall);
  }

  // No anchor row to fold into — open a fresh bubble. When `messageId` is
  // present we adopt it as the row id (the daemon has already committed to
  // this assistant message; the row is mid-stream, not optimistic). When
  // absent — only possible against pre-anchor-protocol daemons — fall back
  // to a client UUID and stamp `isOptimistic` so reconcile knows the id is
  // a placeholder.
  return [
    ...prev,
    {
      id: messageId ?? crypto.randomUUID(),
      ...(messageId ? {} : { isOptimistic: true }),
      role: "assistant" as const,
      content: "",
      isStreaming: true,
      toolCalls: [toolCall],
      contentOrder: [{ type: "toolCall", id: toolCall.id }],
      timestamp: Date.now(),
    },
  ];
}

/**
 * Fold a tool call into the assistant row at `idx`, either updating the
 * existing entry (same `toolCall.id`) or appending a new one with a
 * matching `contentOrder` entry. Stamps `isStreaming: true` so the row
 * keeps streaming semantics — same invariant as `appendTextIntoRow`.
 */
function upsertToolCallIntoRow(
  prev: DisplayMessage[],
  idx: number,
  toolCall: ChatMessageToolCall,
): DisplayMessage[] {
  const row = prev[idx]!;
  const existingIdx =
    row.toolCalls?.findIndex((tc) => tc.id === toolCall.id) ?? -1;
  const updated = [...prev];

  if (existingIdx !== -1) {
    const updatedToolCalls = [...(row.toolCalls ?? [])];
    updatedToolCalls[existingIdx] = {
      ...updatedToolCalls[existingIdx]!,
      ...toolCall,
    };
    updated[idx] = { ...row, isStreaming: true, toolCalls: updatedToolCalls };
    return updated;
  }

  updated[idx] = {
    ...row,
    isStreaming: true,
    toolCalls: [...(row.toolCalls ?? []), toolCall],
    contentOrder: [
      ...(row.contentOrder ?? []),
      { type: "toolCall", id: toolCall.id },
    ],
  };
  return updated;
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
