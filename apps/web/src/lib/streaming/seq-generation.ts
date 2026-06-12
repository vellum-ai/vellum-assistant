/**
 * Seq-space generation counter.
 *
 * The daemon's global `seq` counter defines a "seq space". That space is
 * abandoned when the counter restarts (daemon restart) or the client
 * attaches to a different assistant (seq is per-assistant). Snapshot
 * pipelines capture the generation when a fetch starts and compare it
 * when the response is applied: a response fetched against an abandoned
 * space carries old-space seq values that must not be recorded as
 * frontiers, or they would classify every new-space event as an
 * already-applied replay.
 */

let generation = 0;

/** Current seq-space generation. Capture before an async snapshot fetch. */
export function getSeqGeneration(): number {
  return generation;
}

/** Mark the current seq space abandoned (restart / assistant switch). */
export function bumpSeqGeneration(): void {
  generation++;
}
