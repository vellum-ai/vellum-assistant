/**
 * Recovery step: promote channel inbound events stranded between processing
 * and delivery onto the delivery-retry sweep after a crash.
 *
 * A channel turn is marked `processing_status = 'processed'` the moment its
 * agent turn persists (`markProcessed` in `inbound-stages/background-dispatch.ts`),
 * but its reply delivery finalizes afterwards, in memory, ending in
 * `markDeliveryDelivered` / `recordDeliveryFailure`. A daemon that dies inside
 * that window leaves the row `processed` + `delivery_status = 'pending'`, and
 * nothing recovers it: the delivery-retry sweep selects only
 * `delivery_status = 'failed'`, and `recoverOrphanedChannelEvents` only
 * promotes `processing_status = 'pending'` rows. The user-visible symptom is
 * either a reply that never reaches the channel (durable delivery had not run
 * yet) or, when the reply had already streamed live into Slack, a delivered
 * message whose assistant row never gains its sent-message id
 * (`slackMeta.channelTs` / `providerMeta.messageId`), which drops the row out
 * of every projection keyed on that id.
 *
 * This step, run once from the monitor process at startup, promotes those
 * orphans to `delivery_status = 'failed'` with an immediate `retry_after` so
 * the existing delivery-retry arm of the sweep re-delivers from the stored
 * payload. That arm is idempotent against a reply that already streamed: the
 * `slackStreamMessageTs` breadcrumb makes it edit the visible message in
 * place, and the sent-message-id reconciliation stamps the row. Guards:
 *
 *   - **Boot-time fence.** Only rows created BEFORE this daemon booted are
 *     touched. A newer row belongs to a live turn on the running daemon;
 *     promoting it would let the sweep race the in-flight delivery. Mirrors
 *     `recoverOrphanedChannelEvents`.
 *   - **Delivery must actually be owed.** `processed` + `pending` is the
 *     normal terminal state for events the inbound intercepts settle without
 *     a reply delivery (reactions, edits, deletes, admission denials), so the
 *     promotion requires the payload keys only the turn-and-deliver path
 *     writes: `replyCallbackUrl` (stored at ingress for deliverable turns)
 *     AND `replyMessageId` (stored by `storeReplyMessageId` right after the
 *     turn persists its reply row).
 */

import { getLogger } from "../../util/logger.js";
import { withBootFencedRecoveryDb } from "./db.js";

const log = getLogger("recovery-stranded-delivery-events");

export function recoverStrandedDeliveryEvents(): void {
  withBootFencedRecoveryDb("stranded-delivery-events", (db, bootTime) => {
    const now = Date.now();
    const result = db
      .query(
        `UPDATE channel_inbound_events
            SET delivery_status = 'failed',
                retry_after = ?,
                updated_at = ?
          WHERE processing_status = 'processed'
            AND delivery_status = 'pending'
            AND raw_payload IS NOT NULL
            AND json_extract(raw_payload, '$.replyCallbackUrl') IS NOT NULL
            AND json_extract(raw_payload, '$.replyMessageId') IS NOT NULL
            AND created_at < ?`,
      )
      .run(now, now, bootTime);
    if (result.changes > 0) {
      log.info(
        { promoted: result.changes, bootTime },
        "Promoted stranded processed channel events onto the delivery-retry sweep",
      );
    }
  });
}
