/**
 * Recovery step: clear conversation processing flags left set by a previous
 * daemon that died mid-turn.
 *
 * `conversations.processing_started_at` is persisted at every turn boundary so
 * out-of-process callers can tell a live turn from an idle conversation. A
 * daemon that dies mid-turn leaves the flag set with no in-memory agent loop
 * behind it, so clients would render the conversation busy forever and
 * background jobs (e.g. memory retrospectives) would skip it.
 *
 * Runs from the monitor process, fenced by the current daemon's boot time: a
 * flag set before this daemon booted belongs to a process that has exited and
 * is cleared; a flag set at or after boot belongs to a live turn in the running
 * daemon and is left untouched. Without the fence the sweep — running ~seconds
 * into the daemon's lifetime, by which point live turns may have started —
 * could null a running turn's flag.
 *
 * The resume-attempt counter is intentionally left alone: it must survive the
 * flag clear so the interrupted-turn resume cap holds across boots (reset only
 * by a clean turn end in `setConversationProcessingStartedAt`).
 *
 * Ordered before `inflight-content` in the recovery run so that step's
 * `processing_started_at` "is this a live turn" guard reads the cleared state.
 */

import { isProcessAlive } from "../../persistence/processing-claim.js";
import { getLogger } from "../../util/logger.js";
import { withBootFencedRecoveryDb } from "./db.js";

const log = getLogger("recovery-stale-processing");

export function clearStaleProcessing(
  isAlive: (pid: number) => boolean = isProcessAlive,
): void {
  withBootFencedRecoveryDb("stale-processing", (db, bootTime) => {
    // A flag from before boot is stale unless a live process still holds it:
    // a schedule worker that outlived the previous daemon can be mid-turn,
    // and clearing its claim would let the new daemon start a second turn.
    const rows = db
      .query(
        `SELECT id, processing_pid FROM conversations
          WHERE processing_started_at IS NOT NULL
            AND processing_started_at < ?`,
      )
      .all(bootTime) as Array<{ id: string; processing_pid: number | null }>;
    const clear = db.query(
      `UPDATE conversations
          SET processing_started_at = NULL, processing_pid = NULL
        WHERE id = ?`,
    );
    let cleared = 0;
    let kept = 0;
    for (const row of rows) {
      if (row.processing_pid != null && isAlive(row.processing_pid)) {
        kept++;
        continue;
      }
      clear.run(row.id);
      cleared++;
    }
    if (cleared > 0 || kept > 0) {
      log.info(
        { cleared, kept, bootTime },
        "Cleared stale conversation processing flags from a previous process",
      );
    }
  });
}
