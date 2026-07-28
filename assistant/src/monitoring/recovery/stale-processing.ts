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

import { getLogger } from "../../util/logger.js";
import { readDaemonBootTime } from "../daemon-boot-time.js";
import { openRecoveryDb } from "./db.js";

const log = getLogger("recovery-stale-processing");

export function clearStaleProcessing(): void {
  const bootTime = readDaemonBootTime();
  if (bootTime == null) {
    // Without the boot-time fence we can't distinguish a dead process's flag
    // from a live turn's, so skip; the next daemon restart reconciles.
    log.warn("Skipping stale-processing clear — daemon boot time unavailable");
    return;
  }

  const db = openRecoveryDb();
  if (db == null) {
    return;
  }
  try {
    // Throws here (missing `processing_started_at` column) propagate to the
    // orchestrator as "schema not ready yet" and retry on the next monitor run.
    const result = db
      .query(
        `UPDATE conversations
            SET processing_started_at = NULL
          WHERE processing_started_at IS NOT NULL
            AND processing_started_at < ?`,
      )
      .run(bootTime);
    if (result.changes > 0) {
      log.info(
        { cleared: result.changes, bootTime },
        "Cleared stale conversation processing flags from a previous process",
      );
    }
  } finally {
    db.close();
  }
}
