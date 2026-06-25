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
import type { AcpRunStatus } from "@/utils/acp-run-status";

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
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
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

  setTerminal: (params: {
    acpSessionId: string;
    status: AcpRunStatus;
    stopReason?: string;
    error?: string;
    completedAt: number;
  }) => void;

  updateUsage: (params: {
    acpSessionId: string;
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
  }) => void;

  /**
   * Idempotent merge of history entries keyed by acpSessionId. Never clobbers
   * a live entry's longer event buffer with a shorter historical one — the
   * entry with more events wins. Sets `highWaterMark` to the max seq seen and
   * indexes `byToolUseId`.
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
    if (byId[params.acpSessionId]) return;

    const entry: AcpRunEntry = {
      acpSessionId: params.acpSessionId,
      agent: params.agent,
      parentConversationId: params.parentConversationId,
      task: params.task,
      status: "initializing",
      startedAt: params.startedAt,
      parentToolUseId: params.parentToolUseId,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
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
          inputTokens: params.inputTokens,
          outputTokens: params.outputTokens,
          totalCost: params.totalCost,
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
      // Prefer the entry with more events so a live buffer is never clobbered
      // by a shorter historical snapshot.
      nextById[entry.acpSessionId] =
        existing && existing.events.length >= entry.events.length
          ? existing
          : entry;

      if (!nextOrderedIds.includes(entry.acpSessionId)) {
        nextOrderedIds.push(entry.acpSessionId);
      }

      if (entry.parentToolUseId) {
        nextByToolUseId = new Map(nextByToolUseId).set(
          entry.parentToolUseId,
          entry.acpSessionId,
        );
      }

      for (const event of entry.events) {
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
