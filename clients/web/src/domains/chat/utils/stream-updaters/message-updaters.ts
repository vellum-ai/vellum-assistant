/**
 * Message-content updaters for SSE stream events.
 *
 * Handles: assistant_text_delta, assistant_thinking_delta,
 * assistant_activity_state (idle), message_complete, user_message_echo,
 * conversation_error.
 *
 * Each exported function has the signature
 * `(prev: DisplayMessage[], ...args) => DisplayMessage[]`.
 */

import type { DisplayMessage } from "@/domains/chat/types/types";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import { toDisplayAttachments } from "@/utils/display-attachments";
import type {
  ConversationContentBlock,
  MessageCompleteEvent,
} from "@vellumai/assistant-api";
import {
  tailIsAssistant,
  findAssistantRowIndexByMessageId,
  withMergedAlias,
  finalizeRunningToolCalls,
} from "@/domains/chat/utils/stream-updaters/shared";

// ---------------------------------------------------------------------------
// assistant_text_delta
// ---------------------------------------------------------------------------

/** Create a new streaming assistant bubble for the first text delta. */
export function createStreamingBubble(
  prev: DisplayMessage[],
  text: string,
  messageId?: string,
  at: number = Date.now(),
): DisplayMessage[] {
  return [
    ...prev,
    {
      id: messageId ?? crypto.randomUUID(),
      ...(messageId ? {} : { isOptimistic: true }),
      role: "assistant",
      textSegments: [text],
      contentOrder: [{ type: "text", id: "0" }],
      contentBlocks: [{ type: "text", text }],
      timestamp: at,
    },
  ];
}

/**
 * Upsert a text/thinking block at the tail of a row's `contentBlocks`
 * projection in lockstep with a segment append.
 *
 * Overwrites the trailing block only when it is this block's type. A
 * reconstructed/server projection omits empty or fully-consumed segments
 * (normalizeContentBlocks), so `contentBlocks` can be shorter than
 * `contentOrder` and its tail may belong to an earlier entry — appending
 * then backfills the previously-absent block instead of clobbering a
 * neighbour.
 */
function upsertTrailingSegmentBlock(
  blocks: ConversationContentBlock[],
  block: ConversationContentBlock,
  coalesce: boolean,
): void {
  if (coalesce && blocks[blocks.length - 1]?.type === block.type) {
    blocks[blocks.length - 1] = block;
  } else {
    blocks.push(block);
  }
}

/**
 * Append a text chunk into the row at `prev[idx]`, maintaining the
 * positional `textSegments`/`contentOrder` arrays and the `contentBlocks`
 * projection in lockstep. When the trailing `contentOrder` entry is
 * already text the chunk extends the trailing segment/block; otherwise a
 * new text segment and order entry are opened.
 */
function appendTextSegmentIntoRow(
  prev: DisplayMessage[],
  idx: number,
  content: string,
  messageId: string | undefined,
): DisplayMessage[] {
  const row = withMergedAlias(prev[idx]!, messageId);
  const segments = [...(row.textSegments ?? [])];
  const order = [...(row.contentOrder ?? [])];
  const blocks = [...(row.contentBlocks ?? [])];
  const coalesce =
    order[order.length - 1]?.type === "text" && segments.length > 0;

  if (coalesce) {
    segments[segments.length - 1] = segments[segments.length - 1]! + content;
  } else {
    order.push({ type: "text", id: String(segments.length) });
    segments.push(content);
  }

  upsertTrailingSegmentBlock(
    blocks,
    { type: "text", text: segments[segments.length - 1]! },
    coalesce,
  );

  const next = [...prev];
  next[idx] = {
    ...row,
    textSegments: segments,
    contentOrder: order,
    contentBlocks: blocks,
  };
  return next;
}

/**
 * Append a thinking chunk into the row at `prev[idx]`, maintaining the
 * positional `thinkingSegments`/`contentOrder` arrays and the
 * `contentBlocks` projection in lockstep. When the trailing `contentOrder`
 * entry is already thinking the chunk extends the trailing segment/block;
 * otherwise a new thinking segment and order entry are opened.
 */
function appendThinkingSegmentIntoRow(
  prev: DisplayMessage[],
  idx: number,
  content: string,
  messageId: string | undefined,
): DisplayMessage[] {
  const row = withMergedAlias(prev[idx]!, messageId);
  const segments = [...(row.thinkingSegments ?? [])];
  const order = [...(row.contentOrder ?? [])];
  const blocks = [...(row.contentBlocks ?? [])];
  const coalesce =
    order[order.length - 1]?.type === "thinking" && segments.length > 0;

  if (coalesce) {
    segments[segments.length - 1] = segments[segments.length - 1]! + content;
  } else {
    order.push({ type: "thinking", id: String(segments.length) });
    segments.push(content);
  }

  upsertTrailingSegmentBlock(
    blocks,
    { type: "thinking", thinking: segments[segments.length - 1]! },
    coalesce,
  );

  const next = [...prev];
  next[idx] = {
    ...row,
    thinkingSegments: segments,
    contentOrder: order,
    contentBlocks: blocks,
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
  seedTwin?: () => DisplayMessage | undefined,
  at: number = Date.now(),
): DisplayMessage[] {
  if (messageId) {
    const idx = findAssistantRowIndexByMessageId(prev, messageId);
    if (idx >= 0) {
      return appendTextSegmentIntoRow(prev, idx, text, messageId);
    }
    if (tailIsAssistant(prev)) {
      return appendTextSegmentIntoRow(prev, prev.length - 1, text, messageId);
    }
    // No live row owns this id and there is no assistant tail to fold into:
    // this is the first delta this client sees for the turn. If the daemon
    // persisted a prefix before we attached — re-attach, late-join, or a
    // reconnect that replays only `seq >` the snapshot watermark — that
    // prefix lives in history under this id. Seed the live row from that
    // history twin so the delta extends the persisted prefix instead of
    // opening a fresh, prefix-less bubble (the "vanishing prefix" bug). The
    // thunk is resolved here, in the cold branch only, so the steady-state
    // hot path never pays for the history lookup. No twin → genuinely new
    // turn → open a fresh bubble as before.
    const twin = seedTwin?.();
    if (twin) {
      return appendTextSegmentIntoRow([...prev, twin], prev.length, text, messageId);
    }
    return createStreamingBubble(prev, text, messageId, at);
  }

  if (!tailIsAssistant(prev)) {
    return createStreamingBubble(prev, text, messageId, at);
  }
  return appendTextSegmentIntoRow(prev, prev.length - 1, text, undefined);
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
  at: number = Date.now(),
): DisplayMessage[] {
  return [
    ...prev,
    {
      id: messageId ?? crypto.randomUUID(),
      ...(messageId ? {} : { isOptimistic: true }),
      role: "assistant",
      thinkingSegments: [thinking],
      contentOrder: [{ type: "thinking", id: "0" }],
      contentBlocks: [{ type: "thinking", thinking }],
      timestamp: at,
    },
  ];
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
  seedTwin?: () => DisplayMessage | undefined,
  at: number = Date.now(),
): DisplayMessage[] {
  if (messageId) {
    const idx = findAssistantRowIndexByMessageId(prev, messageId);
    if (idx >= 0)
      return appendThinkingSegmentIntoRow(prev, idx, thinking, messageId);
    if (tailIsAssistant(prev)) {
      return appendThinkingSegmentIntoRow(
        prev,
        prev.length - 1,
        thinking,
        messageId,
      );
    }
    // First event this client sees for the turn — seed from the history twin
    // (the persisted prefix) when present so a re-attach extends it instead of
    // dropping it. See `appendTextDelta` for the full rationale; reasoning-heavy
    // models open the turn with thinking, so the prefix can be thinking text.
    const twin = seedTwin?.();
    if (twin) {
      return appendThinkingSegmentIntoRow(
        [...prev, twin],
        prev.length,
        thinking,
        messageId,
      );
    }
    return createStreamingThinkingBubble(prev, thinking, messageId, at);
  }

  if (!tailIsAssistant(prev)) {
    return createStreamingThinkingBubble(prev, thinking, messageId, at);
  }
  return appendThinkingSegmentIntoRow(prev, prev.length - 1, thinking, undefined);
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
export function finalizeOnIdle(
  prev: DisplayMessage[],
  at: number = Date.now(),
): DisplayMessage[] {
  let changed = false;
  const updated = prev.map((m) => {
    if (m.role !== "assistant") return m;
    const finalized = finalizeRunningToolCalls(m, at);
    if (!finalized) return m;
    changed = true;
    return { ...m, ...finalized };
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
  at: number = Date.now(),
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
        timestamp: at,
        attachments,
      },
    ];
  }

  const finalized = finalizeRunningToolCalls(last, at);
  const adoptServerId = last.isOptimistic === true && !!event.messageId;
  return [
    ...prev.slice(0, -1),
    {
      ...last,
      ...(adoptServerId ? { id: event.messageId!, isOptimistic: false } : {}),
      ...(attachments ? { attachments } : {}),
      ...(finalized ?? {}),
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
 *     the server `messageId`, clear `isOptimistic`, and clear any
 *     `queueStatus`/`queuePosition`: the echo is emitted only once the daemon
 *     is processing the message (a direct send, or a queued send right after
 *     it is dequeued), so a persisted echo means the row is no longer waiting
 *     in the queue. With no `messageId` (synthetic echo) there is nothing to
 *     upgrade to, so the optimistic row is left as-is.
 *  3. Otherwise append a new user row — passive client or synthetic
 *     prompt. Keyed by `messageId` when present so reconcile/refetch merges
 *     by id; otherwise optimistic.
 */
export function applyUserMessageEcho(
  prev: DisplayMessage[],
  event: { text: string; messageId?: string; clientMessageId?: string },
  at: number = Date.now(),
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
      queueStatus: undefined,
      queuePosition: undefined,
    };
    return next;
  }

  return [
    ...prev,
    {
      id: serverId ?? crypto.randomUUID(),
      ...(serverId === undefined ? { isOptimistic: true } : {}),
      // Carry the nonce so the folded row shares the persisted server row's
      // identity keys — the transcript overlay and the reseed prune both
      // correlate on it (see `messageMatchKeys`).
      ...(event.clientMessageId
        ? { clientMessageId: event.clientMessageId }
        : {}),
      role: "user",
      textSegments: [event.text],
      contentOrder: [{ type: "text", id: "0" }],
      contentBlocks: [{ type: "text", text: event.text }],
      timestamp: at,
    },
  ];
}

// ---------------------------------------------------------------------------
// conversation_error
// ---------------------------------------------------------------------------

/** Handle conversation error: finalize tool calls, remove empty bubbles. */
export function handleConversationError(
  prev: DisplayMessage[],
  at: number = Date.now(),
): DisplayMessage[] {
  const lastIdx = prev.length - 1;
  const last = prev[lastIdx];
  if (!last || last.role !== "assistant") return prev;

  const finalized = finalizeRunningToolCalls(last, at);
  const hasContent =
    messagePlainText(last).trim().length > 0 ||
    (last.thinkingSegments != null && last.thinkingSegments.length > 0) ||
    (last.toolCalls != null && last.toolCalls.length > 0) ||
    (last.surfaces != null && last.surfaces.length > 0);

  if (!hasContent) return prev.slice(0, -1);

  const updated = [...prev];
  updated[lastIdx] = {
    ...last,
    ...(finalized ?? {}),
  };
  return updated;
}
