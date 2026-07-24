/**
 * Recovery step: promote orphaned `pending` channel inbound events onto the
 * retry sweep after a crash.
 *
 * A channel turn that arrives while its conversation is mid-turn is deferred
 * in-memory (`withChannelTurnAdmission` in `runtime/routes/inbound-stages/`)
 * with the inbound row still `processing_status = 'pending'`, and a turn that is
 * actively processing stays `pending` until it finalizes. A daemon that dies
 * during either window loses the in-memory task, and neither existing path
 * recovers the row: the retry sweep only selects `failed` rows, and a duplicate
 * webhook redelivery short-circuits on the existing inbound row — so the channel
 * message would be silently stranded.
 *
 * This step, run once from the monitor process at startup, promotes those
 * orphans to `failed` with an immediate `retry_after` so the busy-aware sweep
 * reprocesses (and delivers) them from the stored payload. Guards:
 *
 *   - **Boot-time fence.** Only rows created BEFORE this daemon booted are
 *     touched. A `pending` row created at/after boot belongs to a live
 *     in-memory admission on the running daemon; promoting it would let the
 *     sweep race that in-memory turn. Mirrors `clear-stale-processing`.
 *   - **Payload required.** Only rows that still carry a `raw_payload` are
 *     eligible — the sweep replays from it. A payload intentionally cleared
 *     (e.g. a secret-bearing ingress) is left untouched.
 */

import { getLogger } from "../../util/logger.js";
import { readDaemonBootTime } from "../daemon-boot-time.js";
import { openRecoveryDb } from "./db.js";

const log = getLogger("recovery-orphaned-channel-events");

export function recoverOrphanedChannelEvents(): void {
  const bootTime = readDaemonBootTime();
  if (bootTime == null) {
    // Without the fence we cannot tell a dead process's orphan from a live
    // daemon's just-arrived pending row, so skip; the next restart reconciles.
    log.warn(
      "Skipping orphaned-channel-event recovery — daemon boot time unavailable",
    );
    return;
  }

  const db = openRecoveryDb();
  if (db == null) {
    return;
  }
  try {
    const now = Date.now();
    // Throws here (missing column) propagate to the orchestrator as "schema not
    // ready yet" and retry on the next monitor run.
    const result = db
      .query(
        `UPDATE channel_inbound_events
            SET processing_status = 'failed',
                retry_after = ?,
                updated_at = ?
          WHERE processing_status = 'pending'
            AND raw_payload IS NOT NULL
            AND created_at < ?`,
      )
      .run(now, now, bootTime);
    if (result.changes > 0) {
      log.info(
        { promoted: result.changes, bootTime },
        "Promoted orphaned pending channel events onto the retry sweep",
      );
    }
  } finally {
    db.close();
  }
}
