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
import { segmentsToPlainText } from "@/domains/chat/utils/segments-to-plain-text";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";
import { toDisplayAttachments } from "@/utils/display-attachments";
import type {
  AllowlistOption,
  DirectoryScopeOption,
  RiskScopeOption,
} from "@/types/interaction-ui-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { MessageCompleteEvent } from "@vellumai/assistant-api";
import type { ToolActivityMetadata } from "@/assistant/web-activity-types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Force-complete every running tool call by stamping `completedAt`. With no
 * `result`/`isError`, the timestamp alone reads as completed (not running);
 * reconcile later backfills the real result if it arrives.
 */
function finalizeRunningToolCalls(
  toolCalls: ChatMessageToolCall[] | undefined,
): ChatMessageToolCall[] | undefined {
  if (!toolCalls) return undefined;
  return toolCalls.map((tc) =>
    isToolCallRunning(tc) ? { ...tc, completedAt: Date.now() } : tc,
  );
}

/** Whether the tail row is an assistant message. */
export function tailIsAssistant(prev: DisplayMessage[]): boolean {
  const last = prev[prev.length - 1];
  return !!last && last.role === "assistant";
}

/**
 * Identify the assistant row that is currently live (still streaming) for
 * the active conversation, or `null` when none is.
 *
 * The live row is the last assistant message when the conversation is
 * processing and that row trails the most recent user message. A brand-new
 * turn always begins with a user row; a turn with no user row (external
 * channels) has the assistant run as the tail. Trailing user rows still
 * waiting in the queue (`queueStatus: "queued"`) are skipped so a message
 * queued mid-turn doesn't sever the in-flight assistant from its live
 * status.
 *
 * Pure and position-based: this is the single source of truth for row
 * liveness, derived from message position and the conversation's
 * processing state rather than a per-row flag.
 */
export function liveAssistantRowId(
  messages: DisplayMessage[],
  isProcessing: boolean,
): string | null {
  if (!isProcessing) {
    return null;
  }

  let tailIdx = messages.length - 1;
  while (
    tailIdx >= 0 &&
    messages[tailIdx]!.role === "user" &&
    messages[tailIdx]!.queueStatus === "queued"
  ) {
    tailIdx--;
  }

  const tail = messages[tailIdx];
  if (!tail || tail.role !== "assistant") {
    return null;
  }
  return tail.id;
}

/**
 * Find the assistant row that owns `messageId` — by its primary `id` or by
 * a folded `mergedMessageIds` alias.
 *
 * The daemon reserves a fresh `messageId` per LLM call within a single
 * agent turn, and the backend's `mergeConsecutiveAssistantMessages`
 * collapses that run onto the first row's id, listing the later ids as
 * aliases. Matching on aliases — not just the primary id — lets a later
 * LLM call's deltas and tool calls fold into the same anchor instead of
 * opening a duplicate streaming bubble for an id the run already owns.
 */
function findAssistantRowIndexByMessageId(
  prev: DisplayMessage[],
  messageId: string,
): number {
  return prev.findIndex(
    (m) =>
      m.role === "assistant" &&
      (m.id === messageId || !!m.mergedMessageIds?.includes(messageId)),
  );
}

/**
 * Record `messageId` as a `mergedMessageIds` alias on `row` when it isn't
 * already the row's primary id or a known alias. Mirrors the backend merge
 * so a subsequent reconcile / SSE lookup by that id resolves to this row.
 */
function withMergedAlias(
  row: DisplayMessage,
  messageId: string | undefined,
): DisplayMessage {
  if (!messageId || row.id === messageId) return row;
  const existing = row.mergedMessageIds ?? [];
  if (existing.includes(messageId)) return row;
  return { ...row, mergedMessageIds: [...existing, messageId] };
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
      textSegments: [text],
      contentOrder: [{ type: "text", id: "0" }],
      timestamp: Date.now(),
    },
  ];
}

/**
 * Append `text` into the message at `prev[idx]`, extending its trailing
 * text segment if the last `contentOrder` entry is text, otherwise opening
 * a new text segment.
 */
function appendTextIntoRow(
  prev: DisplayMessage[],
  idx: number,
  text: string,
  messageId?: string,
): DisplayMessage[] {
  const row = withMergedAlias(prev[idx]!, messageId);
  const segments = [...(row.textSegments ?? [])];
  const order = [...(row.contentOrder ?? [])];
  const lastOrderEntry = order[order.length - 1];

  if (lastOrderEntry?.type === "text" && segments.length > 0) {
    segments[segments.length - 1] = segments[segments.length - 1]! + text;
  } else {
    const newIndex = segments.length;
    segments.push(text);
    order.push({ type: "text", id: String(newIndex) });
  }

  const next = [...prev];
  next[idx] = {
    ...row,
    textSegments: segments,
    contentOrder: order,
  };
  return next;
}

/**
 * Apply an `assistant_text_delta` to the message array.
 *
 * **Identity-keyed when `messageId` is present** (B2/B3 onward — stamped
 * on every event from event zero of the turn). Looks up the assistant row
 * that owns the id (primary id or merged alias) and appends into it
 * regardless of position. Covers the case where reconcile (or
 * `assistant_turn_start`) landed the reserved row in the array ahead of
 * the first delta.
 *
 * When no row owns the id yet, the delta belongs to a later LLM call in
 * the current agent turn (each call reserves a fresh messageId). A single
 * turn renders as one bubble — the backend collapses the run of reserved
 * rows onto the first row's id — so the delta folds into the current
 * assistant tail (recording the id as an alias) rather than opening a
 * duplicate bubble. Only a non-assistant tail (a new turn always begins
 * with a user row) opens a fresh bubble.
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
    const idx = findAssistantRowIndexByMessageId(prev, messageId);
    if (idx >= 0) return appendTextIntoRow(prev, idx, text, messageId);
    if (tailIsAssistant(prev)) {
      return appendTextIntoRow(prev, prev.length - 1, text, messageId);
    }
    return createStreamingBubble(prev, text, messageId);
  }

  if (!tailIsAssistant(prev)) {
    return createStreamingBubble(prev, text, messageId);
  }
  return appendTextIntoRow(prev, prev.length - 1, text);
}

// ---------------------------------------------------------------------------
// assistant_thinking_delta
// ---------------------------------------------------------------------------

/**
 * Create a new streaming assistant bubble whose first content entry is a
 * thinking block. Reasoning-heavy models (e.g. Kimi) emit their entire
 * chain of thought before any `assistant_text_delta`, so the row is often
 * born from a thinking delta rather than a text one.
 */
export function createStreamingThinkingBubble(
  prev: DisplayMessage[],
  thinking: string,
  messageId?: string,
): DisplayMessage[] {
  return [
    ...prev,
    {
      id: messageId ?? crypto.randomUUID(),
      ...(messageId ? {} : { isOptimistic: true }),
      role: "assistant",
      thinkingSegments: [thinking],
      contentOrder: [{ type: "thinking", id: "0" }],
      timestamp: Date.now(),
    },
  ];
}

/**
 * Append `thinking` into the message at `prev[idx]`, extending its trailing
 * thinking segment when the last `contentOrder` entry is `thinking`,
 * otherwise opening a new thinking segment. Mirrors `appendTextIntoRow` so
 * consecutive reasoning chunks coalesce into one block while reasoning that
 * resumes after interleaved text/tool entries starts a fresh block.
 */
function appendThinkingIntoRow(
  prev: DisplayMessage[],
  idx: number,
  thinking: string,
  messageId?: string,
): DisplayMessage[] {
  const row = withMergedAlias(prev[idx]!, messageId);
  const segments = [...(row.thinkingSegments ?? [])];
  const order = [...(row.contentOrder ?? [])];
  const lastOrderEntry = order[order.length - 1];

  if (lastOrderEntry?.type === "thinking" && segments.length > 0) {
    segments[segments.length - 1] = segments[segments.length - 1]! + thinking;
  } else {
    const newIndex = segments.length;
    segments.push(thinking);
    order.push({ type: "thinking", id: String(newIndex) });
  }

  const next = [...prev];
  next[idx] = {
    ...row,
    thinkingSegments: segments,
    contentOrder: order,
  };
  return next;
}

/**
 * Apply an `assistant_thinking_delta` to the message array.
 *
 * Mirrors `appendTextDelta`'s identity resolution: identity-keyed on
 * `messageId` (the assistant row's db id) when present, with a tail-based
 * fallback for older daemons that don't stamp it. A thinking delta that
 * arrives before any text/tool event opens a fresh assistant bubble via
 * `createStreamingThinkingBubble`.
 */
export function appendThinkingDelta(
  prev: DisplayMessage[],
  thinking: string,
  messageId?: string,
): DisplayMessage[] {
  if (messageId) {
    const idx = findAssistantRowIndexByMessageId(prev, messageId);
    if (idx >= 0) return appendThinkingIntoRow(prev, idx, thinking, messageId);
    if (tailIsAssistant(prev)) {
      return appendThinkingIntoRow(prev, prev.length - 1, thinking, messageId);
    }
    return createStreamingThinkingBubble(prev, thinking, messageId);
  }

  if (!tailIsAssistant(prev)) {
    return createStreamingThinkingBubble(prev, thinking, messageId);
  }
  return appendThinkingIntoRow(prev, prev.length - 1, thinking);
}

// ---------------------------------------------------------------------------
// assistant_activity_state (idle)
// ---------------------------------------------------------------------------

/**
 * Finalize assistant messages when the daemon signals turn idle by marking
 * any running tool calls as completed. Liveness is derived from the
 * conversation's processing state (see `liveAssistantRowId`), which the
 * idle event clears, so no per-row flag needs flipping here.
 */
export function finalizeOnIdle(prev: DisplayMessage[]): DisplayMessage[] {
  let changed = false;
  const updated = prev.map((m) => {
    if (m.role !== "assistant") return m;
    if (!m.toolCalls?.some((tc) => isToolCallRunning(tc))) return m;
    changed = true;
    return { ...m, toolCalls: finalizeRunningToolCalls(m.toolCalls) };
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
 *   - tail is assistant → finalize it: complete any running tool calls,
 *     merge in `event.attachments`. The first
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
      ...(attachments ? { attachments } : {}),
      ...(finalized ? { toolCalls: finalized } : {}),
    },
  ];
}

// ---------------------------------------------------------------------------
// user_message_echo
// ---------------------------------------------------------------------------

/**
 * Resolve the optimistic user row a `user_message_echo` confirms.
 *
 * Primary match is the correlation nonce: the originating client minted
 * `clientMessageId` at send time and the daemon echoes it back, so the user
 * row whose `clientMessageId` equals the event's is the exact send being
 * confirmed — robust to duplicate or normalized text and to two sends fired in
 * quick succession (each carries a distinct nonce). The nonce is unique per
 * send and an already-resolved row is short-circuited by id upstream, so the
 * nonce match needs no separate optimistic flag. When the event carries no
 * nonce — a daemon that predates the idempotency contract, or a synthetic
 * surface-action echo — fall back to the most recent still-optimistic user
 * row, which has no nonce to key on and so is identified by `isOptimistic`.
 */
function findOptimisticUserEchoIdx(
  prev: DisplayMessage[],
  clientMessageId: string | undefined,
): number {
  if (clientMessageId !== undefined) {
    return prev.findIndex(
      (m) => m.role === "user" && m.clientMessageId === clientMessageId,
    );
  }

  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i];
    if (m && m.role === "user" && m.isOptimistic === true) {
      return i;
    }
  }
  return -1;
}

/**
 * Apply a `user_message_echo` to the message array.
 *
 * The daemon emits this whenever a user message is persisted — direct
 * sends, slash/canned/compaction turns, and synthetic surface-action
 * prompts. The originating client already shows an optimistic row (and
 * swaps it to the server id on POST resolve); passive clients and
 * synthetic prompts have no such row and need the user turn rendered
 * before the assistant reply streams in.
 *
 * Three cases, in order:
 *  1. A row already carries `messageId` (as `id` or a merged alias) — the
 *     originating client whose POST already resolved, or a prior echo /
 *     reconcile pulled the row in. No-op.
 *  2. An optimistic user row is correlated by `clientMessageId` (or, absent
 *     the nonce, the most recent optimistic row) — the originating client
 *     whose POST hasn't resolved yet (the echo beat the 202). Swap its id to
 *     the server `messageId` and clear `isOptimistic`, mirroring the
 *     POST-resolve path so a later reconcile can't double it. With no
 *     `messageId` (synthetic echo) there is nothing to upgrade to, so the
 *     optimistic row is left as-is.
 *  3. Otherwise append a new user row — passive client or synthetic
 *     prompt. Keyed by `messageId` when present so reconcile/refetch merges
 *     by id; otherwise optimistic.
 */
export function applyUserMessageEcho(
  prev: DisplayMessage[],
  event: { text: string; messageId?: string; clientMessageId?: string },
): DisplayMessage[] {
  const serverId = event.messageId;

  if (serverId !== undefined) {
    const alreadyPresent = prev.some(
      (m) =>
        m.role === "user" &&
        (m.id === serverId || m.mergedMessageIds?.includes(serverId)),
    );
    if (alreadyPresent) {
      return prev;
    }
  }

  const optimisticIdx = findOptimisticUserEchoIdx(prev, event.clientMessageId);
  if (optimisticIdx !== -1) {
    if (serverId === undefined) {
      return prev;
    }
    const next = [...prev];
    next[optimisticIdx] = {
      ...next[optimisticIdx]!,
      id: serverId,
      isOptimistic: false,
    };
    return next;
  }

  return [
    ...prev,
    {
      id: serverId ?? crypto.randomUUID(),
      ...(serverId === undefined ? { isOptimistic: true } : {}),
      role: "user",
      textSegments: [event.text],
      contentOrder: [{ type: "text", id: "0" }],
      timestamp: Date.now(),
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
  if (!last || last.role !== "assistant") return prev;

  const finalized = finalizeRunningToolCalls(last.toolCalls);
  const hasContent =
    segmentsToPlainText(last.textSegments).trim().length > 0 ||
    (last.toolCalls != null && last.toolCalls.length > 0);

  if (!hasContent) return prev.slice(0, -1);

  const updated = [...prev];
  updated[lastIdx] = {
    ...last,
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
    // Identity-keyed: resolve the row that owns this id by primary id or
    // merged alias — a surface from a later LLM call carries an id the
    // anchor may already list as an alias. See `appendTextDelta`.
    targetIdx = findAssistantRowIndexByMessageId(prev, messageId);
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
      surfaces: [surface],
      contentOrder: [{ type: "surface", id: surface.surfaceId }],
      timestamp: Date.now(),
    });
  } else {
    const target = withMergedAlias(prev[targetIdx]!, messageId);
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
 * Insert or update a tool call on the current assistant bubble, creating a
 * new bubble only when the tail isn't an assistant row.
 *
 * **Identity-keyed when `messageId` is present** — looks up the assistant
 * row that owns the id (primary id or merged alias) and folds into it
 * regardless of position. Mirrors `appendTextDelta`: when no row owns the
 * id yet, the tool call belongs to a later LLM call in the current agent
 * turn, so it folds into the assistant tail (recording the id as an alias)
 * to keep the turn one bubble rather than splitting per call. Only a
 * non-assistant tail opens a fresh bubble.
 *
 * Falls back to tail-based decisioning when `messageId` is absent, for
 * pre-anchor-protocol daemons.
 */
export function upsertToolCall(
  prev: DisplayMessage[],
  toolCall: ChatMessageToolCall,
  messageId?: string,
): DisplayMessage[] {
  if (messageId) {
    const idx = findAssistantRowIndexByMessageId(prev, messageId);
    if (idx >= 0) return upsertToolCallIntoRow(prev, idx, toolCall, messageId);
    if (tailIsAssistant(prev)) {
      return upsertToolCallIntoRow(prev, prev.length - 1, toolCall, messageId);
    }
  } else if (tailIsAssistant(prev)) {
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
      toolCalls: [toolCall],
      contentOrder: [{ type: "toolCall", id: toolCall.id }],
      timestamp: Date.now(),
    },
  ];
}

/**
 * Fold a tool call into the assistant row at `idx`, either updating the
 * existing entry (same `toolCall.id`) or appending a new one with a
 * matching `contentOrder` entry.
 */
function upsertToolCallIntoRow(
  prev: DisplayMessage[],
  idx: number,
  toolCall: ChatMessageToolCall,
  messageId?: string,
): DisplayMessage[] {
  const row = withMergedAlias(prev[idx]!, messageId);
  const existingIdx =
    row.toolCalls?.findIndex((tc) => tc.id === toolCall.id) ?? -1;
  const updated = [...prev];

  if (existingIdx !== -1) {
    const updatedToolCalls = [...(row.toolCalls ?? [])];
    updatedToolCalls[existingIdx] = {
      ...updatedToolCalls[existingIdx]!,
      ...toolCall,
    };
    updated[idx] = { ...row, toolCalls: updatedToolCalls };
    return updated;
  }

  updated[idx] = {
    ...row,
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
    riskAllowlistOptions?: AllowlistOption[];
    riskScopeOptions?: RiskScopeOption[];
    riskDirectoryScopeOptions?: DirectoryScopeOption[];
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
    tcIdx = msg.toolCalls.findLastIndex((tc) => isToolCallRunning(tc));
  }

  if (tcIdx === -1) return prev;

  const msg = prev[msgIdx]!;
  const existingTc = msg.toolCalls![tcIdx];
  if (!existingTc) return prev;

  const updatedToolCalls = [...msg.toolCalls!];
  updatedToolCalls[tcIdx] = {
    ...existingTc,
    result: opts.result,
    isError: opts.isError,
    riskLevel: opts.riskLevel,
    riskReason: opts.riskReason,
    matchedTrustRuleId: opts.matchedTrustRuleId,
    approvalMode: opts.approvalMode,
    approvalReason: opts.approvalReason,
    riskThreshold: opts.riskThreshold,
    riskAllowlistOptions: opts.riskAllowlistOptions,
    riskScopeOptions: opts.riskScopeOptions,
    riskDirectoryScopeOptions: opts.riskDirectoryScopeOptions,
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
  return prev.map((m) => (m.id === id ? { ...m, queuePosition: position } : m));
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
