/**
 * Gateway-side claim on an inbound delivery, so a vendor's retry does not
 * become a second turn.
 *
 * This is the dedup half of the assistant's `recordInbound`, forked to run
 * before the handoff rather than after it. The key is identical, deliberately:
 * `(sourceChannel, externalChatId, externalMessageId)`, the triple every
 * channel already dedups on. What is not forked is everything else that
 * function does. `recordInbound` also binds the conversation, writes the
 * permanent event row, and opens the delivery-status record the outbound
 * reply is tracked on, and none of that is administrative in the way a
 * duplicate check is. Those stay where the messages are.
 *
 * The claim is a reservation, not a receipt. It is taken before the delivery
 * is handed off and released when the handoff fails, so a message lost to an
 * assistant outage is one the vendor's next retry can still deliver. That is
 * the rollback `deleteInbound` was written for on the assistant side and which
 * nothing there ever calls.
 *
 * Rows expire. The assistant's are permanent because they carry more than
 * dedup; these answer one question, and a vendor still retrying a day later is
 * sending something new rather than the same thing again.
 */

import type { Database } from "bun:sqlite";

import { getGatewayDb } from "./connection.js";

/** Which delivery, in the terms every channel's dedup already uses. */
export interface InboundEventKey {
  sourceChannel: string;
  externalChatId: string;
  externalMessageId: string;
}

/**
 * How long a claim blocks a redelivery of the same message.
 *
 * A day, matching the window every other webhook route in the gateway holds
 * (`StringDedupCache` in telegram-webhook, email-webhook, whatsapp-webhook,
 * mailgun-webhook) and the Slack socket dedup. Vendor retry schedules are
 * measured in hours at the outside, so this covers the retries and little
 * else.
 */
export const INBOUND_DEDUP_TTL_MS = 24 * 60 * 60 * 1_000;

function rawDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

/**
 * Claim `key` for processing. Returns false when it is already claimed.
 *
 * One statement, because two would be a race: between a `SELECT` that found
 * nothing and the `INSERT` that followed it, a concurrent redelivery of the
 * same message would pass the same check and both would proceed. The upsert
 * takes the row only when there is none or the one there has expired, and
 * SQLite reports that as a changed row, so the return value is the claim.
 *
 * Written as SQL rather than through Drizzle for the change count, which is
 * the whole answer here and which the query builder does not surface.
 */
export function reserveInboundEvent(
  key: InboundEventKey,
  ttlMs: number = INBOUND_DEDUP_TTL_MS,
): boolean {
  const now = Date.now();
  return (
    rawDb()
      .prepare(
        `INSERT INTO inbound_seen_events
           (source_channel, external_chat_id, external_message_id, seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source_channel, external_chat_id, external_message_id)
         DO UPDATE SET seen_at = excluded.seen_at, expires_at = excluded.expires_at
         WHERE inbound_seen_events.expires_at <= ?`,
      )
      .run(
        key.sourceChannel,
        key.externalChatId,
        key.externalMessageId,
        now,
        now + ttlMs,
        now,
      ).changes > 0
  );
}

/**
 * Give up a claim, so the vendor's retry is not answered as a duplicate.
 *
 * For the delivery that was claimed and then could not be handed off. Silent
 * when there is nothing to release: releasing twice, or releasing a claim that
 * has already expired, is the same outcome the caller wanted.
 */
export function releaseInboundEvent(key: InboundEventKey): void {
  rawDb()
    .prepare(
      `DELETE FROM inbound_seen_events
        WHERE source_channel = ?
          AND external_chat_id = ?
          AND external_message_id = ?`,
    )
    .run(key.sourceChannel, key.externalChatId, key.externalMessageId);
}

/** Whether `key` is currently claimed. Read-only, for tests and diagnostics. */
export function hasInboundEventClaim(key: InboundEventKey): boolean {
  const row = rawDb()
    .prepare(
      `SELECT 1 FROM inbound_seen_events
        WHERE source_channel = ?
          AND external_chat_id = ?
          AND external_message_id = ?
          AND expires_at > ?`,
    )
    .get(
      key.sourceChannel,
      key.externalChatId,
      key.externalMessageId,
      Date.now(),
    );
  return row !== undefined && row !== null;
}

/** Drop expired claims. Returns how many rows went. */
export function cleanupExpiredInboundEvents(): number {
  return rawDb()
    .prepare("DELETE FROM inbound_seen_events WHERE expires_at <= ?")
    .run(Date.now()).changes;
}
