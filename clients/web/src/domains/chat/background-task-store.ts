/**
 * Zustand store for background bash/host_bash task lifecycle state.
 *
 * Maintains a map of BackgroundTaskEntry records keyed by the `bg-xxxxxxxx`
 * task id, with an ordered list of ids for stable rendering. Unlike the ACP
 * run store, there is no streaming event buffer: a background task is just
 * metadata plus a terminal status/exit-code/output, so the entry settles in a
 * single `completeTask` instead of accumulating chunks. Anchoring is by the
 * synchronous result-parsed task id, so no `byToolUseId`/`highWaterMark`/seq
 * machinery is needed.
 *
 * @see https://zustand.docs.pmnd.rs/guides/flux-inspired-practice
 * @see https://zustand.docs.pmnd.rs/guides/updating-state
 */

import { create } from "zustand";

import type {
  BackgroundToolCompletedEvent,
  BackgroundToolStartedEvent,
} from "@vellumai/assistant-api";
import { createSelectors } from "@/utils/create-selectors";
import {
  isActiveBackgroundTaskStatus,
  type BackgroundTaskStatus,
} from "@/utils/background-task-status";
import {
  mergeTerminalStatus,
  seedEntriesFromHistory,
} from "@/domains/chat/store-helpers/merge-history-entry";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface BackgroundTaskEntry {
  id: string;
  toolName: string;
  conversationId: string;
  command: string;
  startedAt: number;
  status: BackgroundTaskStatus;
  exitCode?: number | null;
  output?: string;
  completedAt?: number;
}

export interface BackgroundTaskState {
  byId: Record<string, BackgroundTaskEntry>;
  orderedIds: string[];
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface BackgroundTaskActions {
  /**
   * Record a started background task. Inserts a "running" entry and appends its
   * id to `orderedIds`. Idempotent — a replayed start for a known id is ignored
   * so the entry's original metadata and ordering are preserved.
   */
  startTask: (event: BackgroundToolStartedEvent) => void;

  /**
   * Settle a background task from its terminal event — status, exit code,
   * captured output, and completion time. No-op for an unknown id. Never
   * regresses an optimistically-cancelled entry to "failed": the daemon's
   * cancellation still emits a `background_tool_completed` with a non-zero
   * status, which would otherwise flash the card from "cancelled" to "failed".
   */
  completeTask: (event: BackgroundToolCompletedEvent) => void;

  /**
   * Optimistically mark a running task "cancelled" (user pressed Stop). No-op
   * for an unknown or already-terminal task so a finished task is never
   * regressed. The authoritative `completedAt`/`exitCode`/`output` land later
   * via {@link completeTask}, which preserves this "cancelled" status.
   */
  cancelTask: (id: string) => void;

  /**
   * Roll back an optimistic {@link cancelTask} when the cancel request fails —
   * restore the prior status and clear `completedAt`. No-op unless the task is
   * still in the optimistic "cancelled" state, so a real terminal that already
   * landed is never regressed back to active.
   */
  restoreTaskStatus: (id: string, prev: BackgroundTaskStatus) => void;

  /**
   * Retire running tasks absent from an authoritative active-task snapshot —
   * the daemon restarted and lost the subprocess before persisting a terminal
   * row, so no completion event will ever settle them. Marks each still-running
   * task "cancelled".
   *
   * `knownIds` is the snapshot of task ids that existed when the active-task
   * fetch was issued. A running task is retired only if it IS in `knownIds` AND
   * NOT in `activeIds`, so a task that started while the fetch was in flight (in
   * `byId` but absent from both sets) is left untouched. Callers must capture
   * the id snapshot before issuing the fetch and pass it here. No-op for tasks
   * already terminal or present in the snapshot.
   */
  retireMissing: (
    activeIds: string[] | Set<string>,
    knownIds: Iterable<string>,
  ) => void;

  /**
   * Idempotent merge of history entries keyed by id. Adds unseen entries (with
   * ordering) and folds terminal metadata into known ones via
   * {@link mergeHistoryEntry}.
   */
  seedFromHistory: (entries: BackgroundTaskEntry[]) => void;

  reset: () => void;
}

export type BackgroundTaskStore = BackgroundTaskState & BackgroundTaskActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: BackgroundTaskState = {
  byId: {},
  orderedIds: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fold a history entry into an existing one. A terminal history status wins
 * over a live running one; a live terminal status is not regressed by a
 * non-terminal history status. Terminal metadata fills in where missing.
 */
function mergeHistoryEntry(
  existing: BackgroundTaskEntry,
  incoming: BackgroundTaskEntry,
): BackgroundTaskEntry {
  const status = mergeTerminalStatus(
    existing.status,
    incoming.status,
    isActiveBackgroundTaskStatus,
  );

  return {
    ...existing,
    status,
    exitCode: incoming.exitCode ?? existing.exitCode,
    output: incoming.output ?? existing.output,
    completedAt: incoming.completedAt ?? existing.completedAt,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useBackgroundTaskStoreBase = create<BackgroundTaskStore>()((set, get) => ({
  ...INITIAL_STATE,

  startTask: (event) => {
    const { byId, orderedIds } = get();
    if (byId[event.id]) return;

    const entry: BackgroundTaskEntry = {
      id: event.id,
      toolName: event.toolName,
      conversationId: event.conversationId,
      command: event.command,
      startedAt: event.startedAt,
      status: "running",
    };

    set({
      byId: { ...byId, [event.id]: entry },
      orderedIds: [...orderedIds, event.id],
    });
  },

  completeTask: (event) => {
    const { byId } = get();
    const existing = byId[event.id];
    if (!existing) return;

    // Preserve an optimistic cancel: the daemon's cancellation reports a
    // "failed" terminal, which must not regress the user-visible "cancelled".
    const status =
      existing.status === "cancelled" && event.status === "failed"
        ? "cancelled"
        : event.status;

    set({
      byId: {
        ...byId,
        [event.id]: {
          ...existing,
          status,
          exitCode: event.exitCode,
          output: event.output,
          completedAt: event.completedAt,
        },
      },
    });
  },

  cancelTask: (id) => {
    const { byId } = get();
    const existing = byId[id];
    if (!existing || !isActiveBackgroundTaskStatus(existing.status)) return;

    set({
      byId: {
        ...byId,
        [id]: { ...existing, status: "cancelled" },
      },
    });
  },

  restoreTaskStatus: (id, prev) => {
    const { byId } = get();
    const existing = byId[id];
    // Only revert our own optimistic cancel. The optimistic `cancelTask` never
    // sets `completedAt`, so a non-null `completedAt` means a real terminal
    // already landed — even one that preserved the "cancelled" status (a racing
    // failed `completeTask`). Reviving it would flash a finished task back to
    // active.
    if (
      !existing ||
      existing.status !== "cancelled" ||
      existing.completedAt != null
    ) {
      return;
    }

    set({
      byId: {
        ...byId,
        [id]: { ...existing, status: prev, completedAt: undefined },
      },
    });
  },

  retireMissing: (activeIds, knownIds) => {
    const { byId } = get();
    const active = new Set(activeIds);
    const known = new Set(knownIds);
    let changed = false;
    const next = { ...byId };
    for (const entry of Object.values(byId)) {
      // Retire only tasks known before the snapshot and absent from it; a task
      // started while the fetch was in flight is in `byId` but not `known`, so
      // it is left running.
      if (
        !isActiveBackgroundTaskStatus(entry.status) ||
        !known.has(entry.id) ||
        active.has(entry.id)
      ) {
        continue;
      }
      next[entry.id] = { ...entry, status: "cancelled" };
      changed = true;
    }
    if (changed) set({ byId: next });
  },

  seedFromHistory: (entries) => {
    const { byId, orderedIds } = get();
    set(
      seedEntriesFromHistory({
        entries,
        byId,
        orderedIds,
        idOf: (entry) => entry.id,
        merge: mergeHistoryEntry,
      }),
    );
  },

  reset: () => set({ byId: {}, orderedIds: [] }),
}));

export const useBackgroundTaskStore = createSelectors(useBackgroundTaskStoreBase);
