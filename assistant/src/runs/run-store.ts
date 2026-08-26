/**
 * Runs: a first-class record for async work, separate from the one-shot
 * notification.
 *
 * A run is created when work starts and **updated in place** as it
 * progresses, so an hour of skill learning produces one live row rather than a
 * stream of events. States are
 * `queued → running → succeeded | failed | cancelled | interrupted`, with
 * `needs_input` as a side state `running` can enter and leave.
 *
 * Three properties are load-bearing:
 *
 *   - **Runs enter the notification pipeline once, at most.** Start and
 *     progress skip it entirely: nothing is being decided and nothing is being
 *     pushed. Only a transition worth interrupting for becomes a real
 *     notification, and it goes through `emitNotificationSignal` like every
 *     other producer, so routing, dedupe, and copy rendering keep working with
 *     no second system to maintain.
 *   - **Short runs never surface.** A run writes no row until it has been
 *     alive for {@link SURFACE_DELAY_MS}. Work that finishes inside that window
 *     with nothing to report leaves no trace, which is what stops the feed
 *     filling with rows for work nobody was waiting on.
 *   - **The feed row is the persistence.** Runs are rows in the home feed
 *     keyed `run:<runId>`, so they inherit the writer's replace-in-place merge,
 *     the `home_feed_updated` broadcast, and client read state without a
 *     parallel store to reconcile.
 *
 * Runs are a Vellum-surface concept. Telegram and Slack users do not get run
 * chatter; only the notifying transitions above fan out to channels.
 */

import type {
  FeedItem,
  FeedItemRun,
  FeedItemRunState,
} from "../api/responses/home.js";
import { isTerminalRunState } from "../api/responses/home.js";
import { appendFeedItem, readHomeFeed } from "../home/feed-writer.js";
import { publishFeedToast } from "../home/publish-feed-toast.js";
import { bucketCompat, bucketExpiresAt } from "../notifications/bucket.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("run-store");

/**
 * How long work must be alive before it earns a row.
 *
 * Deliberately a guess, and instrumented rather than tuned blind: the point is
 * that a sub-second subagent call never flickers a spinner into the bell. Long
 * enough that ordinary fast work stays invisible, short enough that a user who
 * kicked something off and opened the bell sees it there.
 */
export const SURFACE_DELAY_MS = 4_000;

/**
 * Window inside which starting the same work twice collapses onto one run.
 *
 * Keyed on the caller's `collapseKey`, so a retry loop that re-enters the same
 * job does not stack rows.
 */
const COLLAPSE_WINDOW_MS = 30_000;

/** Runs still running after this long are swept to `interrupted`. */
export const RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface StartRunOptions {
  /** Producer-scoped kind, e.g. `subagent`, `skill_learning`, `scheduled_run`. */
  kind: string;
  /** Human label. A noun phrase: "Learning skill: linear-triage". */
  label: string;
  /** Root this run hangs off, when it is a child. */
  parentRunId?: string;
  /** Conversation the run's work happens in, for the row's link. */
  conversationId?: string;
  /**
   * Collapses repeat starts of the same work within
   * {@link COLLAPSE_WINDOW_MS} onto one run. Omitted = never collapses.
   */
  collapseKey?: string;
  /** Free-form metadata carried onto the feed row (schedule id, skill id). */
  metadata?: Record<string, unknown>;
  /**
   * Never notify for this run, whatever it does.
   *
   * For routine infrastructure whose failures the user cannot act on
   * (heartbeat, compaction, filing, memory sweeps). Its row stays in Activity
   * and its failures roll into a System health counter instead, which is the
   * whole point of the noise audit: one row per underlying fault, not one per
   * occurrence.
   */
  silent?: boolean;
}

export interface FinishRunOptions {
  /**
   * Whether the successful outcome is worth showing. Routine successes are a
   * silent Activity row folded into the digest; notable ones toast and sit in
   * Worth knowing. The default is routine, because a default of "always"
   * rebuilds the noise this replaced.
   */
  notable?: boolean;
  /** What the run produced, shown on the row and in any notification. */
  summary?: string;
  /** Conversation or artifact the row should link to. */
  conversationId?: string;
}

export interface FailRunOptions {
  /** Why it failed, in prose. Never a raw error constant. */
  reason: string;
  /** Whether the client should offer Retry. */
  retryable?: boolean;
}

interface RunRecord {
  runId: string;
  kind: string;
  label: string;
  parentRunId?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  silent: boolean;
  state: FeedItemRunState;
  startedAtMs: number;
  progressNote?: string;
  /** Set once the run has written a feed row, so later writes replace it. */
  surfaced: boolean;
  /** Timer that surfaces a run which outlives {@link SURFACE_DELAY_MS}. */
  surfaceTimer?: ReturnType<typeof setTimeout>;
  childTotal: number;
  childDone: number;
}

/** Live runs, by id. A run leaves the registry when it reaches a terminal state. */
const liveRuns = new Map<string, RunRecord>();

/** `collapseKey → runId`, with the start time, for the collapse window. */
const collapseIndex = new Map<string, { runId: string; startedAtMs: number }>();

let runCounter = 0;

function nextRunId(kind: string): string {
  runCounter += 1;
  return `${kind}-${Date.now().toString(36)}-${runCounter.toString(36)}`;
}

/** Feed-item id for a run. Stable, so every write replaces the same row. */
export function runItemId(runId: string): string {
  return `run:${runId}`;
}

/**
 * The handle a producer drives its run through.
 *
 * Every method is fire-and-forget safe: they never throw, and a producer that
 * drops one has its run swept to `interrupted` rather than leaving a spinner
 * turning forever.
 */
export interface RunHandle {
  readonly runId: string;
  /** Report a step. Rewrites the live row; never creates a notification. */
  progress(note: string): void;
  /** Block on the user. Promotes the run to Needs you and notifies. */
  needsInput(note: string): Promise<void>;
  /** Finish successfully. */
  succeed(options?: FinishRunOptions): Promise<void>;
  /** Finish with a reason the user can act on. */
  fail(options: FailRunOptions): Promise<void>;
  /** Finish because something cancelled it. Silent. */
  cancel(): Promise<void>;
}

/**
 * Begin a run.
 *
 * Returns a handle immediately and writes nothing yet: the row appears only if
 * the work outlives {@link SURFACE_DELAY_MS}, or lands a transition that has to
 * be shown regardless.
 */
export function startRun(options: StartRunOptions): RunHandle {
  const now = Date.now();

  if (options.collapseKey) {
    const previous = collapseIndex.get(options.collapseKey);
    if (previous && now - previous.startedAtMs < COLLAPSE_WINDOW_MS) {
      const existing = liveRuns.get(previous.runId);
      if (existing) {
        log.debug(
          { runId: existing.runId, collapseKey: options.collapseKey },
          "Collapsed a repeat start onto the run already in flight",
        );
        return makeHandle(existing);
      }
    }
  }

  const runId = nextRunId(options.kind);
  const record: RunRecord = {
    runId,
    kind: options.kind,
    label: options.label,
    state: "running",
    startedAtMs: now,
    silent: options.silent ?? false,
    surfaced: false,
    childTotal: 0,
    childDone: 0,
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    ...(options.conversationId
      ? { conversationId: options.conversationId }
      : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
  liveRuns.set(runId, record);

  if (options.collapseKey) {
    collapseIndex.set(options.collapseKey, { runId, startedAtMs: now });
  }

  if (record.parentRunId) {
    const parent = liveRuns.get(record.parentRunId);
    if (parent) {
      parent.childTotal += 1;
      void writeRunRow(parent);
    }
  }

  record.surfaceTimer = setTimeout(() => {
    record.surfaceTimer = undefined;
    // Re-read: the run may have finished on another tick between the timer
    // firing and this callback running.
    if (liveRuns.has(runId)) {
      void writeRunRow(record);
    }
  }, SURFACE_DELAY_MS);
  // Long-lived work must not hold the process open on this timer alone.
  record.surfaceTimer.unref?.();

  return makeHandle(record);
}

function makeHandle(record: RunRecord): RunHandle {
  return {
    runId: record.runId,
    progress(note: string) {
      record.progressNote = note;
      // Progress on a run that has not surfaced yet is remembered but not
      // written: a step reported at 200ms is still work nobody is waiting on.
      if (record.surfaced) {
        void writeRunRow(record);
      }
    },
    needsInput(note: string) {
      return transition(record, "needs_input", { progressNote: note });
    },
    succeed(options?: FinishRunOptions) {
      return transition(record, "succeeded", {
        notable: options?.notable ?? false,
        summary: options?.summary,
        conversationId: options?.conversationId,
      });
    },
    fail(options: FailRunOptions) {
      return transition(record, "failed", {
        failureReason: options.reason,
        retryable: options.retryable ?? true,
      });
    },
    cancel() {
      return transition(record, "cancelled", {});
    },
  };
}

interface TransitionPayload {
  progressNote?: string;
  summary?: string;
  failureReason?: string;
  retryable?: boolean;
  notable?: boolean;
  conversationId?: string;
}

/**
 * Move a run to a new state, write its row, and, for the transitions worth
 * interrupting for, hand one signal to the notification pipeline.
 *
 * A run whose parent is live also settles its share of the parent's child
 * count, so the root row can report "2 of 3 done" without walking a tree.
 */
async function transition(
  record: RunRecord,
  state: FeedItemRunState,
  payload: TransitionPayload,
): Promise<void> {
  try {
    if (isTerminalRunState(record.state)) {
      return;
    }

    record.state = state;
    if (payload.progressNote !== undefined) {
      record.progressNote = payload.progressNote;
    }
    if (payload.conversationId) {
      record.conversationId = payload.conversationId;
    }

    const terminal = isTerminalRunState(state);
    if (terminal) {
      if (record.surfaceTimer) {
        clearTimeout(record.surfaceTimer);
        record.surfaceTimer = undefined;
      }
      liveRuns.delete(record.runId);

      if (record.parentRunId) {
        const parent = liveRuns.get(record.parentRunId);
        if (parent) {
          parent.childDone += 1;
          void writeRunRow(parent);
        }
      }
    }

    // A run that finished routinely inside the surface window is exactly the
    // case the delay exists for: nothing to report, nobody waiting, no row.
    const routineAndInvisible =
      terminal &&
      !record.surfaced &&
      state === "succeeded" &&
      payload.notable !== true;
    if (!routineAndInvisible) {
      await writeRunRow(record, payload);
    }

    await notifyIfWorthInterrupting(record, state, payload);
  } catch (err) {
    log.warn(
      { err, runId: record.runId, state },
      "Failed to apply a run transition",
    );
  }
}

/**
 * The three transitions that become real notifications, and nothing else.
 *
 * They go in through `emitNotificationSignal` so the decision engine still
 * picks channels and writes the copy, and dedupe still applies.
 */
async function notifyIfWorthInterrupting(
  record: RunRecord,
  state: FeedItemRunState,
  payload: TransitionPayload,
): Promise<void> {
  if (record.silent) {
    return;
  }
  let sourceEventName: string | null = null;
  let requiresAction = false;
  if (state === "needs_input") {
    sourceEventName = "run.needs_input";
    requiresAction = true;
  } else if (state === "failed") {
    sourceEventName = "run.failed";
  } else if (state === "succeeded" && payload.notable === true) {
    sourceEventName = "run.finished_notable";
  }
  if (!sourceEventName) {
    return;
  }

  await emitNotificationSignal({
    sourceEventName,
    sourceChannel: "assistant_tool",
    sourceContextId: record.conversationId ?? "",
    dedupeKey: `${sourceEventName}:${record.runId}`,
    attentionHints: {
      requiresAction,
      urgency: requiresAction ? "high" : "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    contextPayload: {
      runId: record.runId,
      runKind: record.kind,
      runLabel: record.label,
      ...(payload.summary ? { summary: payload.summary } : {}),
      ...(payload.failureReason
        ? { failureReason: payload.failureReason }
        : {}),
      ...(payload.progressNote ? { progressNote: payload.progressNote } : {}),
    },
    // The run row already carries the durable record, and a run's feed
    // presence is its own row rather than a second notification card.
    suppressHomeFeedMirror: true,
  });
}

/**
 * Project a run onto its feed row and hand it to the writer.
 *
 * The writer replaces same-id rows in place and preserves array position, so a
 * progress update rewrites the live row rather than reshuffling the list under
 * someone reading it.
 */
async function writeRunRow(
  record: RunRecord,
  payload: TransitionPayload = {},
): Promise<void> {
  const bucket = record.silent
    ? "activity"
    : bucketForRun(record.state, payload.notable === true);
  const compat = bucketCompat(bucket);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const startedAt = new Date(record.startedAtMs).toISOString();
  const terminal = isTerminalRunState(record.state);

  const run: FeedItemRun = {
    runId: record.runId,
    kind: record.kind,
    state: record.state,
    startedAt,
    ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
    ...(terminal ? { endedAt: now } : {}),
    ...(record.progressNote ? { progressNote: record.progressNote } : {}),
    ...(payload.failureReason
      ? { failureReason: payload.failureReason }
      : {}),
    ...(record.childTotal > 0
      ? { childTotal: record.childTotal, childDone: record.childDone }
      : {}),
    ...(payload.retryable !== undefined ? { retryable: payload.retryable } : {}),
  };

  const expiresAt = terminal ? bucketExpiresAt(bucket, nowMs) : undefined;

  const item: FeedItem = {
    id: runItemId(record.runId),
    type: "run",
    bucket,
    title: record.label,
    summary: composeRunSummary(record, payload),
    timestamp: now,
    createdAt: startedAt,
    // A run row is a status, not an unread message: it lands `seen` so a live
    // spinner never lights the bell's unread dot. Only its notifying
    // transitions ask for attention, and they do so through the pipeline.
    status: bucket === "activity" ? "seen" : "new",
    run,
    priority: compat.priority,
    noteworthy: compat.noteworthy,
    category: compat.category,
    ...(expiresAt ? { expiresAt } : {}),
    ...(record.conversationId
      ? { conversationId: record.conversationId }
      : {}),
    ...(record.metadata ? { metadata: record.metadata } : {}),
  };

  record.surfaced = true;
  await appendFeedItem(item);
  // After the row lands, so a toast can never point at a row that is not
  // there yet. `publishFeedToast` re-applies the terminal-transitions-only
  // rule, so a progress rewrite of a Worth-knowing row cannot toast twice.
  publishFeedToast(item);
}

/**
 * Which section a run row sits in, by state.
 *
 * Running work is not something to act on, so it lives at the top of Activity
 * rather than earning a section of its own. A run that blocks on the user
 * moves to the top section, and a fixable failure or a notable success is
 * worth knowing about.
 */
export function bucketForRun(
  state: FeedItemRunState,
  notable: boolean,
): "needs_you" | "worth_knowing" | "activity" {
  if (state === "needs_input") {
    return "needs_you";
  }
  if (state === "failed") {
    return "worth_knowing";
  }
  if (state === "succeeded" && notable) {
    return "worth_knowing";
  }
  return "activity";
}

function composeRunSummary(
  record: RunRecord,
  payload: TransitionPayload,
): string {
  if (payload.summary) {
    return payload.summary;
  }
  if (payload.failureReason) {
    return payload.failureReason;
  }
  if (record.progressNote) {
    return record.progressNote;
  }
  switch (record.state) {
    case "queued":
      return "Queued.";
    case "running":
      return "Running.";
    case "needs_input":
      return "Waiting on you.";
    case "succeeded":
      return "Finished.";
    case "failed":
      return "Did not finish.";
    case "cancelled":
      return "Cancelled.";
    case "interrupted":
      return "Stopped before it finished.";
  }
}

/** Live run ids, for the sweeps that reconcile rows against them. */
export function getLiveRunIds(): Set<string> {
  return new Set(liveRuns.keys());
}

/**
 * Mark a run row `interrupted` without going through its handle.
 *
 * Used by the sweeps for runs whose producer is gone: the process died
 * mid-run, or a producer forgot to close one. Nothing is driving the run any
 * more, so the row offers Re-run and never pushes.
 */
export async function markRunInterrupted(item: FeedItem): Promise<void> {
  if (!item.run || isTerminalRunState(item.run.state)) {
    return;
  }
  const compat = bucketCompat("activity");
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  await appendFeedItem({
    ...item,
    bucket: "activity",
    status: item.status === "new" ? "seen" : item.status,
    summary: "Stopped before it finished. Nothing is running it now.",
    timestamp: now,
    priority: compat.priority,
    noteworthy: compat.noteworthy,
    category: compat.category,
    expiresAt: bucketExpiresAt("activity", nowMs),
    run: { ...item.run, state: "interrupted", endedAt: now, retryable: true },
  });
}

/**
 * Reconcile persisted run rows against the live registry.
 *
 * Called at startup, where every non-terminal row is by definition orphaned
 * (nothing has started running yet), and by the periodic sweep, where a
 * non-terminal row whose run is not live means its producer went away.
 */
export async function reconcileOrphanedRuns(): Promise<number> {
  const live = getLiveRunIds();
  const now = Date.now();
  let closed = 0;
  for (const item of readHomeFeed().items) {
    if (item.type !== "run" || !item.run) {
      continue;
    }
    if (isTerminalRunState(item.run.state)) {
      continue;
    }
    const startedMs = Date.parse(item.run.startedAt);
    const tooOld =
      !Number.isNaN(startedMs) && now - startedMs > RUN_MAX_AGE_MS;
    if (live.has(item.run.runId) && !tooOld) {
      continue;
    }
    await markRunInterrupted(item);
    closed += 1;
  }
  if (closed > 0) {
    log.info({ closed }, "Closed run rows with nothing driving them");
  }
  return closed;
}

/** Test seam: drop the in-memory registries. */
export function resetRunStoreForTests(): void {
  for (const record of liveRuns.values()) {
    if (record.surfaceTimer) {
      clearTimeout(record.surfaceTimer);
    }
  }
  liveRuns.clear();
  collapseIndex.clear();
}
