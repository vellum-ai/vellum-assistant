/**
 * Zustand store for ACP run lifecycle state.
 *
 * Maintains a map of AcpRunEntry records keyed by acpSessionId, with an
 * ordered list of IDs for stable rendering. Event buffers are append-only —
 * message/thought chunks are stored as individual events and coalesced by the
 * projections for display, so the buffer stays a cheap append.
 *
 * @see https://zustand.docs.pmnd.rs/guides/flux-inspired-practice
 * @see https://zustand.docs.pmnd.rs/guides/updating-state
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import { isActiveAcpStatus, type AcpRunStatus } from "@/utils/acp-run-status";
import {
  mergeTerminalStatus,
  seedEntriesFromHistory,
} from "@/domains/chat/store-helpers/merge-history-entry";
import {
  optimisticCancel,
  optimisticRestore,
  optimisticRetire,
  type OptimisticLifecycleConfig,
} from "@/domains/chat/store-helpers/optimistic-lifecycle";

import { setToolUseAnchor } from "./store-helpers/by-tool-use-id-index";

// ---------------------------------------------------------------------------
// Optimistic-steer marker contract
// ---------------------------------------------------------------------------

/** Content prefix `appendLocalMarker` stamps onto an optimistic steering note. */
export const STEER_MARKER_PREFIX = "↻ Steering: ";

/** Synthetic `messageId` prefix `appendLocalMarker` gives a steer marker. */
export const LOCAL_MARKER_ID_PREFIX = "local-marker-";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface AcpRunRawEvent {
  /**
   * Daemon-assigned sequence number. Live events always carry one; persisted
   * events from older daemons may not. Seqless events are appended without
   * deduping and excluded from the high-water mark.
   */
  seq?: number;
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
  /** Files touched by this tool call (for the file-diff affordance). */
  locations?: { path: string; line?: number }[];
  /** Raw tool input/output (ACP rawInput/rawOutput); absent on older daemons. */
  rawInput?: unknown;
  rawOutput?: unknown;
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
  /** Cumulative input tokens across all turns, when available. */
  inputTokens?: number;
  /** Cumulative output tokens across all turns, when available. */
  outputTokens?: number;
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
   *
   * Returns the marker's id (pass it to {@link removeLocalMarker} to roll the
   * marker back), or `null` if the session is unknown.
   */
  appendLocalMarker: (params: {
    acpSessionId: string;
    content: string;
  }) => string | null;

  /**
   * Remove a local marker by the id returned from {@link appendLocalMarker}.
   * Rolls back an optimistic steer note when the steer request fails so the
   * transcript doesn't keep showing an instruction the agent never received.
   * No-op for an unknown session or already-removed marker.
   */
  removeLocalMarker: (params: {
    acpSessionId: string;
    markerId: string;
  }) => void;

  setTerminal: (params: {
    acpSessionId: string;
    status: AcpRunStatus;
    stopReason?: string;
    error?: string;
    completedAt: number;
  }) => void;

  /**
   * Optimistically mark an active run as cancelled (user pressed Stop). No-op
   * for unknown or already-terminal runs so a finished run is never regressed.
   * Pairs with the error handler preserving `cancelled`: the daemon's cancel
   * still emits `acp_session_error`, which would otherwise flash the card to
   * `failed` before history rehydrates it as `cancelled`.
   */
  cancelRun: (params: { acpSessionId: string; completedAt: number }) => void;

  /**
   * Roll back an optimistic {@link cancelRun} when the cancel request fails —
   * restore the prior status and clear `completedAt`. No-op unless the run is
   * still in the optimistic `cancelled` state, so a real terminal that already
   * landed is never regressed back to active.
   */
  restoreRunStatus: (params: {
    acpSessionId: string;
    status: AcpRunStatus;
  }) => void;

  /**
   * Retire active runs that an authoritative `/acp/sessions` snapshot no longer
   * reports — the daemon restarted and lost the in-memory subprocess before it
   * persisted a terminal history row, so no event will ever settle the run.
   * Marks each still-active run `cancelled` with a `daemon_restarted` stop
   * reason. No-op for runs already terminal.
   */
  retireMissingRuns: (params: {
    acpSessionIds: string[];
    completedAt: number;
  }) => void;

  updateUsage: (params: {
    acpSessionId: string;
    usedTokens: number;
    contextSize: number;
    inputTokens?: number;
    outputTokens?: number;
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

/**
 * Append an event to a run's buffer. Message/thought chunks are kept as
 * individual events — coalescing happens in the step projection for display.
 * Leaving the raw buffer un-coalesced lets history reconciliation
 * ({@link mergeEvents}) dedup by `seq` without mixing a coalesced live chunk
 * with the individual persisted chunks it would otherwise span (which double-
 * counted the overlapping text).
 */
function appendEvent(
  events: AcpRunRawEvent[],
  event: AcpRunRawEvent,
): AcpRunRawEvent[] {
  return [...events, event];
}

/**
 * Seq-keyed union of live + history events. Buffer length is not recency: a
 * stale-but-longer history snapshot can have a lower max seq than the few live
 * events already received, so keeping the longer buffer would drop them. Dedup
 * by `seq` instead, preferring the existing (live) event on collision, and
 * sort ascending by seq. Events lacking `seq` (older/fallback data) are appended
 * without deduping so a missing seq never collapses distinct events.
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

  const merged = Array.from(bySeq.values()).sort(
    (a, b) => (a.seq ?? 0) - (b.seq ?? 0),
  );
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

  const status = mergeTerminalStatus(
    existing.status,
    incoming.status,
    isActiveAcpStatus,
  );

  return {
    ...existing,
    events,
    status,
    stopReason: incoming.stopReason ?? existing.stopReason,
    error: incoming.error ?? existing.error,
    completedAt: incoming.completedAt ?? existing.completedAt,
    usedTokens: incoming.usedTokens || existing.usedTokens,
    contextSize: incoming.contextSize || existing.contextSize,
    inputTokens: incoming.inputTokens ?? existing.inputTokens,
    outputTokens: incoming.outputTokens ?? existing.outputTokens,
    costAmount: incoming.costAmount ?? existing.costAmount,
    costCurrency: incoming.costCurrency ?? existing.costCurrency,
    task: existing.task ?? incoming.task,
    parentToolUseId: existing.parentToolUseId ?? incoming.parentToolUseId,
  };
}

/**
 * Raise a session's high-water mark to the given seq if higher. A seqless event
 * (no numeric seq) never advances the mark — it must not gate live replay.
 */
function bumpHighWaterMark(
  highWaterMark: Map<string, number>,
  acpSessionId: string,
  seq: number | undefined,
): Map<string, number> {
  if (typeof seq !== "number") return highWaterMark;
  const prev = highWaterMark.get(acpSessionId);
  if (prev !== undefined && prev >= seq) return highWaterMark;
  return new Map(highWaterMark).set(acpSessionId, seq);
}

/**
 * Build the optimistic cancel/restore/retire config for the acp-run store. An
 * optimistic cancel stamps `completedAt`; a retire also records a stop reason
 * (e.g. `daemon_restarted`).
 */
function acpLifecycleConfig(
  completedAt?: number,
  stopReason?: string,
): OptimisticLifecycleConfig<AcpRunEntry, AcpRunStatus> {
  return {
    getStatus: (entry) => entry.status,
    isActive: isActiveAcpStatus,
    cancelledStatus: "cancelled",
    applyCancel: (entry) => ({ ...entry, status: "cancelled", completedAt }),
    applyRestore: (entry, prev) => ({
      ...entry,
      status: prev,
      completedAt: undefined,
    }),
    applyRetire: (entry) => ({
      ...entry,
      status: "cancelled",
      stopReason,
      completedAt,
    }),
  };
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

      const nextByToolUseId = existing.parentToolUseId
        ? byToolUseId
        : setToolUseAnchor(
            byToolUseId,
            params.parentToolUseId,
            params.acpSessionId,
          );

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
    const nextByToolUseId = setToolUseAnchor(
      byToolUseId,
      params.parentToolUseId,
      params.acpSessionId,
    );

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
    if (!existing) return null;

    // Fractional seq sorts after existing events but never collides with a
    // daemon integer seq; the events-length-derived messageId is unique so it
    // can't coalesce into an adjacent real message. highWaterMark is left
    // untouched so the next real daemon event survives the dedup gate.
    const maxSeq = existing.events.reduce(
      (max, ev) => (typeof ev.seq === "number" && ev.seq > max ? ev.seq : max),
      0,
    );
    const markerId = `${LOCAL_MARKER_ID_PREFIX}${existing.events.length}`;
    const marker: AcpRunRawEvent = {
      seq: maxSeq + 0.5,
      updateType: "agent_message_chunk",
      messageId: markerId,
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
    return markerId;
  },

  removeLocalMarker: (params) => {
    const { byId } = get();
    const existing = byId[params.acpSessionId];
    if (!existing) return;

    const events = existing.events.filter(
      (ev) => ev.messageId !== params.markerId,
    );
    if (events.length === existing.events.length) return;

    set({
      byId: {
        ...byId,
        [params.acpSessionId]: { ...existing, events },
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

  cancelRun: (params) => {
    const { byId } = get();
    const next = optimisticCancel(
      byId[params.acpSessionId],
      acpLifecycleConfig(params.completedAt),
    );
    if (!next) return;

    set({ byId: { ...byId, [params.acpSessionId]: next } });
  },

  restoreRunStatus: (params) => {
    const { byId } = get();
    const next = optimisticRestore(
      byId[params.acpSessionId],
      params.status,
      acpLifecycleConfig(),
    );
    if (!next) return;

    set({ byId: { ...byId, [params.acpSessionId]: next } });
  },

  retireMissingRuns: (params) => {
    const { byId } = get();
    const config = acpLifecycleConfig(params.completedAt, "daemon_restarted");
    let changed = false;
    const next = { ...byId };
    for (const id of params.acpSessionIds) {
      const retired = optimisticRetire(next[id], config);
      if (!retired) continue;
      next[id] = retired;
      changed = true;
    }
    if (changed) set({ byId: next });
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
          // Cumulative totals/cost aren't on every usage_update — streaming
          // events carry only used/size until the prompt finishes — so preserve
          // the last known value when an event omits them; otherwise a resumed
          // run's live usage_update would null out the persisted meter.
          inputTokens: params.inputTokens ?? existing.inputTokens,
          outputTokens: params.outputTokens ?? existing.outputTokens,
          costAmount: params.costAmount ?? existing.costAmount,
          costCurrency: params.costCurrency ?? existing.costCurrency,
        },
      },
    });
  },

  seedFromHistory: (entries) => {
    const { byId, orderedIds, byToolUseId, highWaterMark } = get();

    // Union live + history events by seq and always merge terminal/status/
    // usage metadata from history so a live entry can't stay stale. The shared
    // helper owns the byId/orderedIds insertion; the seq high-water mark and the
    // tool-use index are acp-specific and folded in from the merged result.
    const { byId: nextById, orderedIds: nextOrderedIds } = seedEntriesFromHistory(
      {
        entries,
        byId,
        orderedIds,
        idOf: (entry) => entry.acpSessionId,
        merge: mergeHistoryEntry,
      },
    );

    let nextByToolUseId = byToolUseId;
    let nextHighWaterMark = highWaterMark;

    for (const entry of entries) {
      // byId / orderedIds / merge are handled above by seedEntriesFromHistory;
      // this loop only maintains the spawn-anchor index and the seq high-water
      // mark. Use the shared setToolUseAnchor helper for the index.
      nextByToolUseId = setToolUseAnchor(
        nextByToolUseId,
        entry.parentToolUseId,
        entry.acpSessionId,
      );

      for (const event of nextById[entry.acpSessionId].events) {
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
