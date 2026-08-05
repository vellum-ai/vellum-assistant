/**
 * Commit-pressure probe — what was updating React when something went wrong.
 *
 * Motivation: `Maximum update depth exceeded` (React error 185) is thrown from
 * whatever `setState` happens to run *after* the limit is already breached, so
 * the reported stack frame names a victim rather than a cause. React increments
 * its counter on every commit that finishes with an ordinary update already
 * queued (`react-dom-client` — `committedLanes & 261930 && pendingLanes & 42`,
 * where `42` is `Sync | InputContinuous | Default`) and resets it on the first
 * commit that does not. Fifty-one consecutive such commits throw — which a
 * genuine render loop produces, but so does enough independent update traffic
 * landing mid-commit, which is what a streaming conversation looks like.
 *
 * Distinguishing those two from a production stack alone is not possible, so
 * this module keeps a rolling tally of who is scheduling updates and how
 * tightly commits are packed. `sentry-init` attaches the snapshot to error-185
 * events; the next occurrence names the traffic instead of a bystander.
 *
 * Hot-path constraints: recording is a couple of integer writes against two
 * fixed buckets — no allocation, no timers, no array growth. The source set is
 * capped so an unexpected caller cannot grow the payload without bound.
 */

import type { QueryClient } from "@tanstack/react-query";

/**
 * Length of one tally bucket. Two are kept (current + previous), so a snapshot
 * covers between one and two seconds of history depending on where in the
 * current bucket it lands.
 */
const BUCKET_MS = 1000;

/**
 * Gap below which two commits count as back-to-back. A frame is ~16.7ms, so
 * anything under half a frame means React re-entered the commit phase without
 * yielding to paint — the observable analogue of the counter React itself
 * keeps.
 */
const BACK_TO_BACK_MS = 8;

/** Cap on distinct source keys, so a caller passing dynamic strings can't
 *  grow the Sentry payload without bound. Overflow is tallied as `other`. */
const MAX_SOURCES = 24;

/**
 * Known high-frequency update sources on the conversation route. Callers are
 * not restricted to these — the type documents the ones we deliberately
 * instrumented, and `query:*` keys are minted from live query ids.
 */
export type UpdateSource =
  | "audio-amplitude"
  | "composer-peek"
  | "smooth-stream"
  | "spoken-word-cursor"
  | "transcript-scroll"
  | "viewport-min-height"
  | (string & {});

export interface CommitPressureSnapshot {
  /** Span the tallies cover. Between `BUCKET_MS` and `2 × BUCKET_MS`. */
  windowMs: number;
  /** Updates recorded in the window, all sources. */
  updates: number;
  /** Per-source update counts, highest first. */
  sources: Record<string, number>;
  /** Commits observed in the window (chat-route subtree only). */
  commits: number;
  /** Longest run of commits separated by less than {@link BACK_TO_BACK_MS}. */
  maxBackToBackCommits: number;
  /**
   * Commits with no recorded update since the previous commit: traffic the
   * per-source tallies cannot name. When this dwarfs `updates`, the driver is
   * an uninstrumented updater and `sources` lists bystanders (LUM-3062).
   */
  unattributedCommits: number;
  /**
   * Longest consecutive run of unattributed commits. A long run fingerprints
   * a per-commit updater outside the instrumented set, such as a setState in
   * a passive effect; instrumented traffic interleaving every other commit
   * caps the run at 1, so read it together with `unattributedCommits`.
   */
  maxUnattributedCommits: number;
}

interface Bucket {
  startedAt: number;
  updates: number;
  commits: number;
  unattributed: number;
  sources: Map<string, number>;
}

function emptyBucket(startedAt: number): Bucket {
  return {
    startedAt,
    updates: 0,
    commits: 0,
    unattributed: 0,
    sources: new Map(),
  };
}

let current: Bucket = emptyBucket(0);
let previous: Bucket = emptyBucket(0);

// Back-to-back run tracking spans buckets: a run that starts in one second and
// ends in the next is exactly the case worth catching.
let lastCommitAt = 0;
let backToBackRun = 0;
let maxBackToBackRun = 0;

// Attribution tracking. A commit is attributed when at least one
// `recordUpdate` landed since the previous commit; anything else is update
// traffic the source tallies cannot see. Spans buckets like the back-to-back
// run, for the same reason.
let updateSinceLastCommit = false;
let unattributedRun = 0;
let maxUnattributedRun = 0;

function now(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

/** Roll buckets forward so `current` always covers the live second. */
function roll(ts: number): void {
  const age = ts - current.startedAt;
  if (age < BUCKET_MS) {
    return;
  }
  if (age >= BUCKET_MS * 2) {
    // Idle gap — everything on record is stale.
    previous = emptyBucket(ts);
    maxBackToBackRun = 0;
    backToBackRun = 0;
    updateSinceLastCommit = false;
    unattributedRun = 0;
    maxUnattributedRun = 0;
  } else {
    previous = current;
  }
  current = emptyBucket(ts);
}

/**
 * Record that `source` scheduled a React update. Call this at the `setState`
 * call site of any updater that fires more than a few times a second while a
 * conversation streams.
 */
export function recordUpdate(source: UpdateSource): void {
  const ts = now();
  roll(ts);
  updateSinceLastCommit = true;
  current.updates += 1;
  const key =
    current.sources.has(source) || current.sources.size < MAX_SOURCES
      ? source
      : "other";
  current.sources.set(key, (current.sources.get(key) ?? 0) + 1);
}

/**
 * Record a React commit. Called from a dependency-less layout effect in the
 * chat route, so it counts commits of that subtree, not every root commit.
 * Layout-effect timing keeps attribution honest: the commit is recorded
 * before ResizeObserver, rAF, and timer callbacks run, so an instrumented
 * update firing in those callbacks attributes the commit it schedules, not
 * the one that just finished. Updates scheduled inside the render or layout
 * window itself are still consumed by the finishing commit, so an isolated
 * `unattributedCommits` tick with a run of 1 is scheduling noise; the signal
 * is counts rivaling `commits` and long runs.
 */
export function recordCommit(): void {
  const ts = now();
  roll(ts);
  current.commits += 1;
  if (updateSinceLastCommit) {
    unattributedRun = 0;
  } else {
    current.unattributed += 1;
    unattributedRun += 1;
    if (unattributedRun > maxUnattributedRun) {
      maxUnattributedRun = unattributedRun;
    }
  }
  updateSinceLastCommit = false;
  if (lastCommitAt !== 0 && ts - lastCommitAt < BACK_TO_BACK_MS) {
    backToBackRun += 1;
    if (backToBackRun > maxBackToBackRun) {
      maxBackToBackRun = backToBackRun;
    }
  } else {
    backToBackRun = 1;
    if (maxBackToBackRun === 0) {
      maxBackToBackRun = 1;
    }
  }
  lastCommitAt = ts;
}

/**
 * Current tallies, or `null` when nothing has been recorded — a null snapshot
 * means the probe never ran (route never mounted, error raised elsewhere) and
 * should be read as "no data", not as "no pressure".
 */
export function snapshotCommitPressure(): CommitPressureSnapshot | null {
  const ts = now();
  roll(ts);
  const updates = current.updates + previous.updates;
  const commits = current.commits + previous.commits;
  if (updates === 0 && commits === 0) {
    return null;
  }

  const merged = new Map<string, number>(previous.sources);
  for (const [key, count] of current.sources) {
    merged.set(key, (merged.get(key) ?? 0) + count);
  }
  const sources: Record<string, number> = {};
  for (const [key, count] of [...merged].sort((a, b) => b[1] - a[1])) {
    sources[key] = count;
  }

  return {
    windowMs: Math.round(ts - previous.startedAt),
    updates,
    sources,
    commits,
    maxBackToBackCommits: maxBackToBackRun,
    unattributedCommits: current.unattributed + previous.unattributed,
    maxUnattributedCommits: maxUnattributedRun,
  };
}

/**
 * Label a query for the tally. HeyAPI mints keys as `[{ _id, path }]`, so the
 * endpoint id is the stable, bounded name; hand-written keys lead with a
 * string. Anything else collapses to one bucket rather than minting a key per
 * query.
 */
function queryLabel(queryKey: readonly unknown[]): string {
  const head = queryKey[0];
  if (typeof head === "string") {
    return head;
  }
  if (head && typeof head === "object" && "_id" in head) {
    const id = (head as { _id: unknown })._id;
    if (typeof id === "string") {
      return id;
    }
  }
  return "unknown";
}

/**
 * Tally every query-cache update as an update source. Query notifications
 * re-render through `useSyncExternalStore`, so they are part of the same
 * commit traffic as the timer-driven sources — and the notify path is what the
 * LUM-2859 stack was standing in when the limit tripped.
 *
 * Returns the unsubscribe handle.
 */
export function installQueryPressureProbe(
  queryClient: QueryClient,
): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") {
      return;
    }
    recordUpdate(`query:${queryLabel(event.query.queryKey)}`);
  });
}

/** Test seam — drops all recorded history. */
export function resetCommitPressure(): void {
  current = emptyBucket(0);
  previous = emptyBucket(0);
  lastCommitAt = 0;
  backToBackRun = 0;
  maxBackToBackRun = 0;
  updateSinceLastCommit = false;
  unattributedRun = 0;
  maxUnattributedRun = 0;
}
