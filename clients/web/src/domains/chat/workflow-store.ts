/**
 * Zustand store for workflow (`run_workflow`) run lifecycle state.
 *
 * Maintains a map of WorkflowEntry records keyed by runId, with an
 * ordered list of IDs for stable rendering and a `byToolUseId` index that
 * anchors an inline transcript card to its spawning tool call. Direct
 * named actions call `set()` to apply pure transitions so UI components
 * can derive display state deterministically.
 *
 * Per-run leaves are tracked in a seq-keyed Map. Reference-stability
 * discipline mirrors the subagent store: `byId`, `byToolUseId`, and a
 * run's `leaves` Map are cloned only when the specific mutation touches
 * them, so unrelated subscribers don't re-render.
 *
 * @see https://zustand.docs.pmnd.rs/guides/flux-inspired-practice
 * @see https://zustand.docs.pmnd.rs/guides/updating-state
 */

import { create } from "zustand";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { workflowsRunsByIdAbortPost } from "@/generated/daemon/sdk.gen";
import { createSelectors } from "@/utils/create-selectors";
import { isActiveStatus } from "@/utils/workflow-status";
import type {
  WorkflowRunStatus,
  WorkflowJournalResponse,
} from "@vellumai/assistant-api";

import { fetchWorkflowJournal } from "./fetch-workflow-journal";
import { fetchWorkflowRun } from "./fetch-workflow-run";
import { setToolUseAnchor } from "./store-helpers/by-tool-use-id-index";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type WorkflowLeafStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowLeaf {
  seq: number;
  label?: string;
  promptSummary?: string;
  status: WorkflowLeafStatus;
  resultSummary?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface WorkflowEntry {
  runId: string;
  label?: string;
  status: WorkflowRunStatus;
  phase?: string;
  /** Latest `workflow_progress` `log(...)` line, shown as a secondary status. */
  message?: string;
  agentsSpawned: number;
  inputTokens: number;
  outputTokens: number;
  summary?: string;
  startedAt: number;
  /**
   * Tool-use block ID of the spawning tool call in the parent conversation.
   * Lets the transcript anchor the inline card to its exact spawn tool call
   * regardless of optimistic→reconciled message id swaps. Indexed in
   * `byToolUseId`. Optional — older daemons omit it.
   */
  toolUseId?: string;
  /** Leaf agents/workflows spawned by this run, keyed by `seq`. */
  leaves: Map<number, WorkflowLeaf>;
}

export interface WorkflowState {
  byId: Record<string, WorkflowEntry>;
  orderedIds: string[];
  /**
   * Index of spawning tool-use block id → runId. Populated when a
   * `workflow_started` event carries `toolUseId`, letting the transcript
   * anchor the inline card to its exact spawn tool call even after the
   * optimistic streaming message id is reconciled away.
   *
   * The map reference is only replaced when a new `toolUseId` is indexed;
   * unrelated mutations keep it stable so subscribers don't re-render.
   */
  byToolUseId: Map<string, string>;
  /**
   * Tracks journal fetches, keyed by a `${runId}:${phase}` tuple
   * (`phase` is `"live"` while the run is active, `"final"` once it is
   * terminal) → the entry's `startedAt` at fetch time. The phase split
   * lets a run fetch its journal once mid-flight and once after it
   * finishes, reconciling any leaves a dropped SSE event left stale,
   * while still deduping repeat fetches within the same phase. The
   * `startedAt` value allows a re-fetch when a store rebuild produces a
   * newer entry.
   */
  fetchedAt: Map<string, number>;
  /**
   * RunIds whose row has been hydrated on demand (or attempted) for
   * history / post-reload cards that have no live store entry. Prevents
   * re-issuing the run-row fetch — including for genuinely unknown runs
   * that 404 — so a perpetually-null card doesn't spam requests.
   */
  hydratedRunIds: Set<string>;
  /**
   * RunIds whose row genuinely no longer exists (a hydration 404 — e.g. the run
   * outlived its retention-pruned row). The transcript un-suppresses the raw
   * tool chip for these so a historical `run_workflow` call whose card can never
   * hydrate stays visible (its stored result) instead of vanishing.
   */
  notFoundRunIds: Set<string>;
  /**
   * RunIds whose last on-demand hydration failed transiently (daemon
   * unreachable / 5xx — `fetchWorkflowRun` returned `null`). Unlike a 404 this
   * is retryable, so the in-flight marker is cleared; recording it here lets the
   * transcript keep the raw tool result visible instead of suppressing it behind
   * a card that has no entry to render. An entry arriving later (a live event,
   * or a successful retry) overrides this — the transcript checks `byId` first.
   */
  hydrationFailedRunIds: Set<string>;
  /**
   * Monotonic counter bumped on every `reset()` (a conversation switch).
   * Async actions capture it before their network await and bail on resume if
   * it changed, so a late response from a previous conversation cannot
   * repopulate the cleared store. Not part of the rendered state — selectors
   * never subscribe to it.
   */
  generation: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface WorkflowActions {
  startRun: (params: {
    runId: string;
    toolUseId?: string;
    label?: string;
    timestamp: number;
  }) => void;

  applyProgress: (params: {
    runId: string;
    phase?: string;
    agentsSpawned?: number;
    label?: string;
    message?: string;
  }) => void;

  leafStarted: (params: {
    runId: string;
    seq: number;
    label?: string;
    promptSummary?: string;
  }) => void;

  leafFinished: (params: {
    runId: string;
    seq: number;
    status: "completed" | "failed";
    label?: string;
    inputTokens?: number;
    outputTokens?: number;
    resultSummary?: string;
  }) => void;

  completeRun: (params: {
    runId: string;
    status: WorkflowRunStatus;
    agentsSpawned: number;
    inputTokens: number;
    outputTokens: number;
    summary?: string;
  }) => void;

  backfillFromJournal: (runId: string, resp: WorkflowJournalResponse) => void;

  /**
   * Fetch the journal from the daemon for a single run, deduped per
   * `(runId, live|final)` phase so each run reconciles its leaves once
   * mid-flight and once after it goes terminal (or if the entry was
   * rebuilt with a newer startedAt). Dedup state lives in the store so it
   * survives component lifecycle. Clears the phase marker on failure so
   * callers can retry.
   */
  fetchJournalIfNeeded: (assistantId: string, runId: string) => Promise<void>;

  /**
   * Hydrate a run's store entry on demand from its row + journal. For
   * history / post-reload cards whose runId is recoverable from a
   * persisted `run_workflow` tool result but for which no live
   * `workflow_started` event replays, so the store is otherwise empty.
   * No-ops when the run is already present (live / already hydrated) and
   * is attempted at most once per runId.
   */
  hydrateRunIfNeeded: (assistantId: string, runId: string) => Promise<void>;

  /**
   * Best-effort abort of a running workflow. Reads `assistantId` from the
   * resolved-assistants store via `.getState()` so callers don't need to
   * pass or close over that value.
   */
  abortRun: (runId: string) => Promise<void>;

  reset: () => void;
}

export type WorkflowStore = WorkflowState & WorkflowActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: WorkflowState = {
  byId: {},
  orderedIds: [],
  byToolUseId: new Map<string, string>(),
  fetchedAt: new Map<string, number>(),
  hydratedRunIds: new Set<string>(),
  notFoundRunIds: new Set<string>(),
  hydrationFailedRunIds: new Set<string>(),
  generation: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh run entry in the "running" state with no leaves. */
function makeShellEntry(runId: string, startedAt: number): WorkflowEntry {
  return {
    runId,
    status: "running",
    agentsSpawned: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt,
    leaves: new Map<number, WorkflowLeaf>(),
  };
}

/**
 * Flip every still-running leaf to terminal `cancelled` — applied when a run
 * ends abnormally (aborted / cap_exceeded / interrupted / failed): the engine
 * emits no `leaf_finished` event and writes no journal row for in-flight leaves,
 * so they would otherwise spin forever. Returns the SAME Map reference when
 * nothing changed (a clean run with no running leaves) to keep selectors stable.
 * Shared by `completeRun` and the terminal-transition path of
 * `backfillFromJournal` so the two cannot diverge.
 */
function sweepRunningLeavesToCancelled(
  leaves: Map<number, WorkflowLeaf>
): Map<number, WorkflowLeaf> {
  let next = leaves;
  for (const [seq, leaf] of leaves) {
    if (leaf.status !== "running") continue;
    if (next === leaves) next = new Map(leaves);
    next.set(seq, { ...leaf, status: "cancelled" });
  }
  return next;
}

/**
 * Journal-fetch dedup key. A run is allowed one fetch while `live` and one
 * once `final` (terminal), so a `final` fetch can reconcile leaves a
 * dropped mid-run SSE event left stuck "running".
 */
function journalFetchKey(status: WorkflowRunStatus, runId: string): string {
  return `${runId}:${isActiveStatus(status) ? "live" : "final"}`;
}

/** Map a journal leaf's open-string status to a live leaf status. */
function mapJournalLeafStatus(status: string): WorkflowLeafStatus {
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  // The journal only records finished leaves, so an unknown status is
  // treated as a terminal success.
  return "completed";
}

/**
 * The run status after a live activity event (progress / leaf start). A run
 * hydrated as `interrupted` and then resumed emits no `workflow_started`
 * (`resume()` suppresses it), so its first live signal is a progress or leaf
 * event — which proves the run is active again, so flip it back to `running`.
 * Genuine terminals (completed/failed/aborted/cap_exceeded) are preserved so a
 * late, out-of-order event after completion can't resurrect a finished run.
 */
function statusAfterLiveActivity(status: WorkflowRunStatus): WorkflowRunStatus {
  return status === "interrupted" ? "running" : status;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useWorkflowStoreBase = create<WorkflowStore>()((set, get) => ({
  ...INITIAL_STATE,

  startRun: (params) => {
    const { byId, orderedIds, byToolUseId } = get();
    const existing = byId[params.runId];

    if (existing) {
      // Fill in label/toolUseId if a prior shell entry (e.g. from a racing
      // progress event) lacked them.
      const nextLabel = existing.label ?? params.label;
      const nextToolUseId = existing.toolUseId ?? params.toolUseId;
      const labelChanged = nextLabel !== existing.label;
      const toolUseIdChanged = nextToolUseId !== existing.toolUseId;
      if (!labelChanged && !toolUseIdChanged) return;

      const updated: WorkflowEntry = {
        ...existing,
        label: nextLabel,
        toolUseId: nextToolUseId,
      };
      const nextByToolUseId = toolUseIdChanged
        ? setToolUseAnchor(byToolUseId, params.toolUseId, params.runId)
        : byToolUseId;
      set({
        byId: { ...byId, [params.runId]: updated },
        byToolUseId: nextByToolUseId,
      });
      return;
    }

    const entry: WorkflowEntry = {
      ...makeShellEntry(params.runId, params.timestamp),
      label: params.label,
      toolUseId: params.toolUseId,
    };
    // Only clone the tool-use index when this start carries a `toolUseId`;
    // otherwise keep the existing reference stable.
    const nextByToolUseId = setToolUseAnchor(
      byToolUseId,
      params.toolUseId,
      params.runId,
    );
    set({
      byId: { ...byId, [params.runId]: entry },
      orderedIds: [...orderedIds, params.runId],
      byToolUseId: nextByToolUseId,
    });
  },

  applyProgress: (params) => {
    const { byId, orderedIds } = get();
    const existing = byId[params.runId];

    const base = existing ?? makeShellEntry(params.runId, Date.now());
    const updated: WorkflowEntry = {
      ...base,
      // A live progress event proves the run is active — a resumed interrupted
      // run flips back to running (resume() emits no workflow_started).
      status: statusAfterLiveActivity(base.status),
      phase: params.phase ?? base.phase,
      // Keep the last log line when a phase-only event arrives; replace it
      // when this event carries a fresh one.
      message: params.message ?? base.message,
      agentsSpawned: params.agentsSpawned ?? base.agentsSpawned,
      label: base.label ?? params.label,
    };

    set({
      byId: { ...byId, [params.runId]: updated },
      orderedIds: existing ? orderedIds : [...orderedIds, params.runId],
    });
  },

  leafStarted: (params) => {
    const { byId, orderedIds } = get();
    const existing = byId[params.runId];
    const base = existing ?? makeShellEntry(params.runId, Date.now());

    // A live leaf event proves the run is active — a resumed interrupted run
    // flips back to running (resume() emits no workflow_started).
    const nextStatus = statusAfterLiveActivity(base.status);

    const current = base.leaves.get(params.seq);
    // Never downgrade an already-terminal leaf back to running. The run-level
    // status still flips (the leaf event proves activity); only the terminal
    // leaf itself is left as-is.
    if (current && current.status !== "running") {
      if (nextStatus !== base.status) {
        set({
          byId: { ...byId, [params.runId]: { ...base, status: nextStatus } },
        });
      }
      return;
    }

    const leaf: WorkflowLeaf = {
      seq: params.seq,
      status: "running",
      label: params.label ?? current?.label,
      promptSummary: params.promptSummary ?? current?.promptSummary,
    };
    const nextLeaves = new Map(base.leaves).set(params.seq, leaf);

    // workflow_leaf_started is the live spawn signal, so keep the run-level
    // Agents metric (which reads agentsSpawned first) at least the number of
    // leaves seen. Otherwise it stays stale between the sparser progress events
    // — e.g. a second batch shows the prior batch's count until the next
    // progress/completion arrives. Monotonic: progress/backfill/completion only
    // raise it further.
    const nextAgentsSpawned = Math.max(base.agentsSpawned, nextLeaves.size);

    set({
      byId: {
        ...byId,
        [params.runId]: {
          ...base,
          status: nextStatus,
          agentsSpawned: nextAgentsSpawned,
          leaves: nextLeaves,
        },
      },
      orderedIds: existing ? orderedIds : [...orderedIds, params.runId],
    });
  },

  leafFinished: (params) => {
    const { byId, orderedIds } = get();
    const existing = byId[params.runId];
    const base = existing ?? makeShellEntry(params.runId, Date.now());

    // A leaf only exists on an already-present run, so `current` implies
    // `existing`.
    const current = base.leaves.get(params.seq);
    const leaf: WorkflowLeaf = {
      seq: params.seq,
      status: params.status,
      label: params.label ?? current?.label,
      promptSummary: current?.promptSummary,
      inputTokens: params.inputTokens ?? current?.inputTokens,
      outputTokens: params.outputTokens ?? current?.outputTokens,
      resultSummary: params.resultSummary ?? current?.resultSummary,
    };

    // Idempotent: skip the write when the leaf is already at this terminal
    // status and the event carries no new data.
    if (
      current &&
      current.status === leaf.status &&
      current.label === leaf.label &&
      current.inputTokens === leaf.inputTokens &&
      current.outputTokens === leaf.outputTokens &&
      current.resultSummary === leaf.resultSummary
    ) {
      return;
    }

    const nextLeaves = new Map(base.leaves).set(params.seq, leaf);

    // Surface live run-level token usage (the panel metrics read the run, not
    // the leaves) without staying 0 until workflow_completed. Take the per-leaf
    // SUM but never drop below an aggregate a server snapshot already set
    // (backfillFromJournal / completeRun). Recomputing the sum — rather than
    // delta-accumulating — counts each leaf exactly once regardless of arrival
    // order: a journal fetch that already folded a leaf's usage into the run
    // aggregate cannot be double-counted by a late workflow_leaf_finished (whose
    // journal-repaired leaf carries no tokens), and a duplicate finish is
    // idempotent. completeRun still overwrites with the authoritative final.
    let leafInputTokens = 0;
    let leafOutputTokens = 0;
    for (const l of nextLeaves.values()) {
      leafInputTokens += l.inputTokens ?? 0;
      leafOutputTokens += l.outputTokens ?? 0;
    }

    set({
      byId: {
        ...byId,
        [params.runId]: {
          ...base,
          inputTokens: Math.max(base.inputTokens, leafInputTokens),
          outputTokens: Math.max(base.outputTokens, leafOutputTokens),
          leaves: nextLeaves,
        },
      },
      orderedIds: existing ? orderedIds : [...orderedIds, params.runId],
    });
  },

  completeRun: (params) => {
    const { byId, orderedIds } = get();
    const existing = byId[params.runId];
    const base = existing ?? makeShellEntry(params.runId, Date.now());

    // A run ending terminal sweeps any still-running leaf to `cancelled` so
    // orphaned in-flight leaves (no leaf_finished, no journal row) don't spin
    // forever; a clean `completed` run has none, so the Map reference is stable.
    const nextLeaves = isActiveStatus(params.status)
      ? base.leaves
      : sweepRunningLeavesToCancelled(base.leaves);

    const updated: WorkflowEntry = {
      ...base,
      status: params.status,
      agentsSpawned: params.agentsSpawned,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      summary: params.summary ?? base.summary,
      leaves: nextLeaves,
    };

    set({
      byId: { ...byId, [params.runId]: updated },
      orderedIds: existing ? orderedIds : [...orderedIds, params.runId],
    });
  },

  backfillFromJournal: (runId, resp) => {
    const { byId, orderedIds } = get();
    const existing = byId[runId];
    const base = existing ?? makeShellEntry(runId, Date.now());

    let leavesChanged = false;
    let nextLeaves = base.leaves;
    for (const journalLeaf of resp.leaves) {
      const current = base.leaves.get(journalLeaf.seq);
      const journalStatus = mapJournalLeafStatus(journalLeaf.status);

      if (!current) {
        if (!leavesChanged) {
          nextLeaves = new Map(base.leaves);
          leavesChanged = true;
        }
        nextLeaves.set(journalLeaf.seq, {
          seq: journalLeaf.seq,
          status: journalStatus,
          label: journalLeaf.label,
          promptSummary: journalLeaf.promptSummary,
          resultSummary: journalLeaf.resultSummary,
          inputTokens: journalLeaf.inputTokens,
          outputTokens: journalLeaf.outputTokens,
        });
        continue;
      }

      // A terminal journal row is authoritative for a leaf that finished, so it
      // replaces a non-authoritative live placeholder: a stale "running" leaf (a
      // missed finish event) OR a "cancelled" leaf that completeRun swept when the
      // run ended before that leaf's finish event arrived. A genuinely cancelled
      // leaf has no journal row, so it stays "cancelled"; a real "completed"/
      // "failed" leaf (from a finish event) is authoritative and never overridden.
      if (
        (current.status === "running" || current.status === "cancelled") &&
        journalStatus !== "running"
      ) {
        if (!leavesChanged) {
          nextLeaves = new Map(base.leaves);
          leavesChanged = true;
        }
        nextLeaves.set(journalLeaf.seq, {
          ...current,
          status: journalStatus,
          label: current.label ?? journalLeaf.label,
          promptSummary: current.promptSummary ?? journalLeaf.promptSummary,
          resultSummary: current.resultSummary ?? journalLeaf.resultSummary,
          inputTokens: current.inputTokens ?? journalLeaf.inputTokens,
          outputTokens: current.outputTokens ?? journalLeaf.outputTokens,
        });
      }
    }

    // A journal response is a server-side snapshot from when the fetch ran, so a
    // `:live` request in flight when `workflow_completed` arrives can resolve with
    // a stale "running" status and lower counters. Never regress the entry: keep
    // an already-terminal status over a stale active one, and treat the monotonic
    // counters as lower bounds (max), so a late stale response cannot flip a
    // finished run back to loading.
    const nextStatus = isActiveStatus(base.status)
      ? resp.status ?? base.status
      : base.status;

    // If the journal transitions an active run to terminal (the client missed
    // `workflow_completed`, e.g. a reconnect gap), apply the same cancellation
    // sweep completeRun does, so leaves that never wrote a journal row don't
    // spin forever under a terminal run.
    const finalLeaves =
      isActiveStatus(base.status) && !isActiveStatus(nextStatus)
        ? sweepRunningLeavesToCancelled(nextLeaves)
        : nextLeaves;

    const updated: WorkflowEntry = {
      ...base,
      status: nextStatus,
      agentsSpawned: Math.max(
        base.agentsSpawned,
        resp.agentsSpawned ?? base.agentsSpawned
      ),
      inputTokens: Math.max(
        base.inputTokens,
        resp.inputTokens ?? base.inputTokens
      ),
      outputTokens: Math.max(
        base.outputTokens,
        resp.outputTokens ?? base.outputTokens
      ),
      phase: resp.phase ?? base.phase,
      leaves: finalLeaves,
    };

    set({
      byId: { ...byId, [runId]: updated },
      orderedIds: existing ? orderedIds : [...orderedIds, runId],
    });
  },

  fetchJournalIfNeeded: async (assistantId, runId) => {
    const { byId, fetchedAt } = get();
    const entry = byId[runId];
    if (!entry) return;

    const key = journalFetchKey(entry.status, runId);
    const prev = fetchedAt.get(key);
    if (prev !== undefined && prev >= entry.startedAt) return;

    // Mark as fetched before the await to prevent concurrent duplicates.
    const nextFetchedAt = new Map(fetchedAt);
    nextFetchedAt.set(key, entry.startedAt);
    set({ fetchedAt: nextFetchedAt });

    const generation = get().generation;
    const resp = await fetchWorkflowJournal(assistantId, runId);

    if (!resp) {
      const next = new Map(get().fetchedAt);
      next.delete(key);
      set({ fetchedAt: next });
      return;
    }

    // A conversation switch (reset) during the await invalidates this fetch —
    // backfilling now would leak this run into the new conversation's store.
    if (get().generation !== generation) return;

    get().backfillFromJournal(runId, resp);
  },

  hydrateRunIfNeeded: async (assistantId, runId) => {
    const { byId, hydratedRunIds } = get();
    // Already live / hydrated — don't clobber an entry built from live
    // events or a prior hydration.
    if (byId[runId]) return;
    // Attempt at most once per run while in flight / after a genuine 404.
    if (hydratedRunIds.has(runId)) return;
    set({ hydratedRunIds: new Set(hydratedRunIds).add(runId) });

    const generation = get().generation;
    const run = await fetchWorkflowRun(assistantId, runId);
    // A conversation switch (reset) during the await invalidates this hydration:
    // populating the store now would leak a previous conversation's run (and
    // could reopen a stale detail panel) into the new conversation.
    if (get().generation !== generation) return;
    // A genuine 404 stays marked so a missing run's card doesn't re-fetch on
    // every render. A transient failure (null — daemon unreachable / 5xx) clears
    // the marker so a later mount can retry instead of leaving the card blank.
    if (run === "not_found") {
      // Record the missing run so the transcript stops suppressing its chip.
      set({ notFoundRunIds: new Set(get().notFoundRunIds).add(runId) });
      return;
    }
    if (run === null) {
      // Clear the in-flight marker so a later mount can retry, and record the
      // transient failure so the transcript keeps the raw tool result visible
      // instead of suppressing it behind a card that has no entry to render.
      const nextHydrated = new Set(get().hydratedRunIds);
      nextHydrated.delete(runId);
      set({
        hydratedRunIds: nextHydrated,
        hydrationFailedRunIds: new Set(get().hydrationFailedRunIds).add(runId),
      });
      return;
    }

    get().startRun({
      runId,
      label: run.name ?? undefined,
      timestamp: Date.now(),
    });
    if (isActiveStatus(run.status)) {
      get().applyProgress({ runId, agentsSpawned: run.agentsSpawned });
    } else {
      get().completeRun({
        runId,
        status: run.status,
        agentsSpawned: run.agentsSpawned,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
      });
    }

    await get().fetchJournalIfNeeded(assistantId, runId);
  },

  abortRun: async (runId) => {
    const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
    if (!assistantId) return;
    try {
      await workflowsRunsByIdAbortPost({
        path: { assistant_id: assistantId, id: runId },
        throwOnError: true,
      });
    } catch {
      // Best-effort — the workflow may have already completed.
    }
  },

  reset: () =>
    set({
      byId: {},
      orderedIds: [],
      byToolUseId: new Map<string, string>(),
      fetchedAt: new Map<string, number>(),
      hydratedRunIds: new Set<string>(),
      notFoundRunIds: new Set<string>(),
      hydrationFailedRunIds: new Set<string>(),
      // Invalidate any in-flight async action so its late response can't
      // repopulate the now-cleared store. Bump, never reset to 0.
      generation: get().generation + 1,
    }),
}));

export const useWorkflowStore = createSelectors(useWorkflowStoreBase);
