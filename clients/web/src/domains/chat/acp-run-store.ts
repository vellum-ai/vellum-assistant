/**
 * Zustand store for ACP run lifecycle state.
 *
 * Maintains a map of AcpRunEntry records keyed by acpSessionId, with an
 * ordered list of IDs for stable rendering. Event buffers are append-only;
 * consecutive message/thought chunks of the same `messageId` are coalesced
 * into the last event so high-frequency streaming stays O(1) for projections.
 *
 * @see https://zustand.docs.pmnd.rs/guides/flux-inspired-practice
 * @see https://zustand.docs.pmnd.rs/guides/updating-state
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import { isActiveAcpStatus, type AcpRunStatus } from "@/utils/acp-run-status";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface AcpRunRawEvent {
  seq: number;
  updateType:
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "user_message_chunk"
    | "tool_call"
    | "tool_call_update"
    | "plan";
  content?: string;
  toolCallId?: string;
  toolTitle?: string;
  toolKind?: string;
  toolStatus?: string;
  messageId?: string;
}

export interface AcpRunEntry {
  acpSessionId: string;
  agent: string;
  parentConversationId: string;
  task?: string;
  status: AcpRunStatus;
  stopReason?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  /**
   * Tool-use block ID of the spawning tool call in the parent conversation.
   * Lets the transcript anchor the inline card to its exact spawn tool call.
   * Indexed in `byToolUseId`. Optional — older daemons omit it.
   */
  parentToolUseId?: string;
  /** Tokens currently in the agent's context window. */
  usedTokens: number;
  /** Size of the agent's context window. */
  contextSize: number;
  /** Cumulative cost reported by the agent, when available. */
  costAmount?: number;
  costCurrency?: string;
  events: AcpRunRawEvent[];
}

export interface AcpRunState {
  byId: Record<string, AcpRunEntry>;
  orderedIds: string[];
  /**
   * Index of spawning tool-use block id → acpSessionId. Populated when a run
   * is spawned with `parentToolUseId`, letting the transcript anchor the
   * inline card to its exact spawn tool call.
   */
  byToolUseId: Map<string, string>;
  /**
   * Highest `seq` seen per session. Lets consumers dedup replayed events on
   * reconnection by ignoring anything at or below the mark.
   */
  highWaterMark: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface AcpRunActions {
  spawnRun: (params: {
    acpSessionId: string;
    agent: string;
    parentConversationId: string;
    parentToolUseId?: string;
    task?: string;
    startedAt: number;
  }) => void;

  receiveEvent: (params: {
    acpSessionId: string;
    event: AcpRunRawEvent;
  }) => void;

  /**
   * Append a local-only timeline marker (e.g. an optimistic steering note)
   * without touching `highWaterMark`. Uses a fractional seq that sorts after
   * existing events but never equals a daemon integer seq, and a unique
   * synthetic `messageId` so it can't coalesce into an adjacent real message.
   * Leaving the dedup mark untouched keeps the next real daemon event (which
   * the daemon stamps with a contiguous integer seq) from being dropped.
   */
  appendLocalMarker: (params: {
    acpSessionId: string;
    content: string;
  }) => void;

  setTerminal: (params: {
    acpSessionId: string;
    status: AcpRunStatus;
    stopReason?: string;
    error?: string;
    completedAt: number;
  }) => void;

  updateUsage: (params: {
    acpSessionId: string;
    usedTokens: number;
    contextSize: number;
    costAmount?: number;
    costCurrency?: string;
  }) => void;

  /**
   * Idempotent merge of history entries keyed by acpSessionId. Unions live and
   * incoming `events` by `seq` so a live stream is never clobbered by a
   * stale-but-longer snapshot, while always merging terminal/status/usage
   * metadata from the history entry. Sets `highWaterMark` to the max seq over
   * the merged buffer and indexes `byToolUseId`.
   */
  seedFromHistory: (entries: AcpRunEntry[]) => void;

  reset: () => void;
}

export type AcpRunStore = AcpRunState & AcpRunActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: AcpRunState = {
  byId: {},
  orderedIds: [],
  byToolUseId: new Map<string, string>(),
  highWaterMark: new Map<string, number>(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COALESCE_TYPES = new Set<AcpRunRawEvent["updateType"]>([
  "agent_message_chunk",
  "agent_thought_chunk",
]);

/**
 * Append an event to a run's buffer, coalescing consecutive
 * message/thought chunks of the same `messageId` into the last event's
 * `content` by building a new last element (never mutating in place).
 */
function appendEvent(
  events: AcpRunRawEvent[],
  event: AcpRunRawEvent,
): AcpRunRawEvent[] {
  const last = events[events.length - 1];
  if (
    last &&
    COALESCE_TYPES.has(event.updateType) &&
    last.updateType === event.updateType &&
    last.messageId !== undefined &&
    last.messageId === event.messageId
  ) {
    const next = events.slice(0, -1);
    next.push({
      ...last,
      seq: event.seq,
      content: (last.content ?? "") + (event.content ?? ""),
    });
    return next;
  }
  return [...events, event];
}

/**
 * Seq-keyed union of live + history events. Buffer length is not recency: a
 * stale-but-longer history snapshot can have a lower max seq than the few live
 * events already received, so keeping the longer buffer would drop them. Dedup
 * by `seq` instead, preferring the existing (live) event on collision — it may
 * be a coalesced/newer-shaped representation — and sort ascending by seq.
 * Events lacking `seq` (older/fallback data) are appended without deduping so a
 * missing seq never collapses distinct events.
 */
function mergeEvents(
  existing: AcpRunRawEvent[],
  incoming: AcpRunRawEvent[],
): AcpRunRawEvent[] {
  const bySeq = new Map<number, AcpRunRawEvent>();
  const seqless: AcpRunRawEvent[] = [];

  for (const event of [...existing, ...incoming]) {
    if (typeof event.seq !== "number") {
      seqless.push(event);
      continue;
    }
    if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  }

  const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  return seqless.length ? [...merged, ...seqless] : merged;
}

/**
 * Merge a history entry into an existing live entry. Unions both event buffers
 * by `seq` (never dropping the newest live events) and always folds in the
 * history entry's terminal/status/usage metadata. A terminal history status
 * wins over a live non-terminal one; a live terminal status is not regressed by
 * a non-terminal history status.
 */
function mergeHistoryEntry(
  existing: AcpRunEntry,
  incoming: AcpRunEntry,
): AcpRunEntry {
  const events = mergeEvents(existing.events, incoming.events);

  const status =
    isActiveAcpStatus(existing.status) || !isActiveAcpStatus(incoming.status)
      ? incoming.status
      : existing.status;

  return {
    ...existing,
    events,
    status,
    stopReason: incoming.stopReason ?? existing.stopReason,
    error: incoming.error ?? existing.error,
    completedAt: incoming.completedAt ?? existing.completedAt,
    usedTokens: incoming.usedTokens || existing.usedTokens,
    contextSize: incoming.contextSize || existing.contextSize,
    costAmount: incoming.costAmount ?? existing.costAmount,
    costCurrency: incoming.costCurrency ?? existing.costCurrency,
    task: existing.task ?? incoming.task,
    parentToolUseId: existing.parentToolUseId ?? incoming.parentToolUseId,
  };
}

/** Raise a session's high-water mark to the given seq if higher. */
function bumpHighWaterMark(
  highWaterMark: Map<string, number>,
  acpSessionId: string,
  seq: number,
): Map<string, number> {
  const prev = highWaterMark.get(acpSessionId);
  if (prev !== undefined && prev >= seq) return highWaterMark;
  return new Map(highWaterMark).set(acpSessionId, seq);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useAcpRunStoreBase = create<AcpRunStore>()((set, get) => ({
  ...INITIAL_STATE,

  spawnRun: (params) => {
    const { byId, orderedIds, byToolUseId } = get();
    const existing = byId[params.acpSessionId];

    if (existing) {
      // A respawn for an active run is a no-op. A respawn for a terminal run
      // is a resume (steer/resume-from-history): clear terminal fields and
      // mark it running while preserving events, usage, and spawn context.
      if (isActiveAcpStatus(existing.status)) return;

      const resumed: AcpRunEntry = {
        ...existing,
        status: "running",
        stopReason: undefined,
        error: undefined,
        completedAt: undefined,
        task: existing.task ?? params.task,
        parentToolUseId: existing.parentToolUseId ?? params.parentToolUseId,
      };

      const nextByToolUseId =
        params.parentToolUseId && !existing.parentToolUseId
          ? new Map(byToolUseId).set(params.parentToolUseId, params.acpSessionId)
          : byToolUseId;

      set({
        byId: { ...byId, [params.acpSessionId]: resumed },
        byToolUseId: nextByToolUseId,
      });
      return;
    }

    const entry: AcpRunEntry = {
      acpSessionId: params.acpSessionId,
      agent: params.agent,
      parentConversationId: params.parentConversationId,
      task: params.task,
      // Daemon emits `acp_session_spawned` only after the session is already
      // running, so a spawned run starts as "running", not "initializing".
      status: "running",
      startedAt: params.startedAt,
      parentToolUseId: params.parentToolUseId,
      usedTokens: 0,
      contextSize: 0,
      events: [],
    };

    // Only clone the tool-use index when this spawn carries a
    // `parentToolUseId`; otherwise keep the reference stable.
    const nextByToolUseId = params.parentToolUseId
      ? new Map(byToolUseId).set(params.parentToolUseId, params.acpSessionId)
      : byToolUseId;

    set({
      byId: { ...byId, [params.acpSessionId]: entry },
      orderedIds: [...orderedIds, params.acpSessionId],
      byToolUseId: nextByToolUseId,
    });
  },

  receiveEvent: (params) => {
    const { byId, highWaterMark } = get();
    const existing = byId[params.acpSessionId];
    if (!existing) return;

    set({
      byId: {
        ...byId,
        [params.acpSessionId]: {
          ...existing,
          events: appendEvent(existing.events, params.event),
        },
      },
      highWaterMark: bumpHighWaterMark(
        highWaterMark,
        params.acpSessionId,
        params.event.seq,
      ),
    });
  },

  appendLocalMarker: (params) => {
    const { byId } = get();
    const existing = byId[params.acpSessionId];
    if (!existing) return;

    // Fractional seq sorts after existing events but never collides with a
    // daemon integer seq; the events-length-derived messageId is unique so it
    // can't coalesce into an adjacent real message. highWaterMark is left
    // untouched so the next real daemon event survives the dedup gate.
    const maxSeq = existing.events.reduce(
      (max, ev) => (typeof ev.seq === "number" && ev.seq > max ? ev.seq : max),
      0,
    );
    const marker: AcpRunRawEvent = {
      seq: maxSeq + 0.5,
      updateType: "agent_message_chunk",
      messageId: `local-marker-${existing.events.length}`,
      content: params.content,
    };

    set({
      byId: {
        ...byId,
        [params.acpSessionId]: {
          ...existing,
          events: [...existing.events, marker],
        },
      },
    });
  },

  setTerminal: (params) => {
    const { byId } = get();
    const existing = byId[params.acpSessionId];
    if (!existing) return;

    set({
      byId: {
        ...byId,
        [params.acpSessionId]: {
          ...existing,
          status: params.status,
          stopReason: params.stopReason ?? existing.stopReason,
          error: params.error ?? existing.error,
          completedAt: params.completedAt,
        },
      },
    });
  },

  updateUsage: (params) => {
    const { byId } = get();
    const existing = byId[params.acpSessionId];
    if (!existing) return;

    set({
      byId: {
        ...byId,
        [params.acpSessionId]: {
          ...existing,
          usedTokens: params.usedTokens,
          contextSize: params.contextSize,
          costAmount: params.costAmount,
          costCurrency: params.costCurrency,
        },
      },
    });
  },

  seedFromHistory: (entries) => {
    const { byId, orderedIds, byToolUseId, highWaterMark } = get();

    const nextById = { ...byId };
    const nextOrderedIds = [...orderedIds];
    let nextByToolUseId = byToolUseId;
    let nextHighWaterMark = highWaterMark;

    for (const entry of entries) {
      const existing = nextById[entry.acpSessionId];
      // Union live + history events by seq and always merge terminal/status/
      // usage metadata from history so a live entry can't stay stale.
      const merged = existing ? mergeHistoryEntry(existing, entry) : entry;
      nextById[entry.acpSessionId] = merged;

      if (!nextOrderedIds.includes(entry.acpSessionId)) {
        nextOrderedIds.push(entry.acpSessionId);
      }

      if (entry.parentToolUseId) {
        nextByToolUseId = new Map(nextByToolUseId).set(
          entry.parentToolUseId,
          entry.acpSessionId,
        );
      }

      for (const event of merged.events) {
        if (typeof event.seq !== "number") continue;
        nextHighWaterMark = bumpHighWaterMark(
          nextHighWaterMark,
          entry.acpSessionId,
          event.seq,
        );
      }
    }

    set({
      byId: nextById,
      orderedIds: nextOrderedIds,
      byToolUseId: nextByToolUseId,
      highWaterMark: nextHighWaterMark,
    });
  },

  reset: () =>
    set({
      byId: {},
      orderedIds: [],
      byToolUseId: new Map<string, string>(),
      highWaterMark: new Map<string, number>(),
    }),
}));

export const useAcpRunStore = createSelectors(useAcpRunStoreBase);
