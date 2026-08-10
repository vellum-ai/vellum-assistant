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
 * ## Reserve, then commit
 *
 * A claim is taken in two steps, for the same reason `StringDedupCache`
 * (telegram-webhook, email-webhook, whatsapp-webhook, mailgun-webhook) takes
 * one in two steps: a reservation and a delivery are not the same fact.
 *
 * {@link reserveInboundEvent} claims the key on a short lease, which is enough
 * to keep a concurrent redelivery out while the first copy is in flight.
 * {@link commitInboundEvent} converts it to the full window once the message
 * actually reached the assistant. Between those, two things can go wrong and
 * both have to end with the delivery still deliverable:
 *
 * - The handoff fails and the gateway answers 503. {@link releaseInboundEvent}
 *   drops the claim, because asking the vendor to retry while holding the row
 *   that answers the retry as a duplicate is how a message is lost with both
 *   sides reporting success. That is the rollback `deleteInbound` was written
 *   for on the assistant side and which nothing there ever calls.
 * - The gateway dies outright: a deploy, an OOM, a host failure. Nothing runs,
 *   so nothing can release. The lease is what covers this. A `pending` row is
 *   reclaimable as soon as it expires, so the delivery is retryable minutes
 *   later rather than being answered as already-delivered for a day, which
 *   would outlive the vendor's retry schedule and lose the message for good.
 *
 * The bias is deliberate: re-delivering a message the assistant already took
 * is recoverable, and the assistant's own `recordInbound` catches that case
 * today. Dropping one is not recoverable by anything.
 *
 * Rows expire. The assistant's are permanent because they carry more than
 * dedup; these answer one question, and a vendor still retrying a day later is
 * sending something new rather than the same thing again.
 */

import { and, eq, gt, lte } from "drizzle-orm";

import { getGatewayDb } from "./connection.js";
import { inboundSeenEvents } from "./schema.js";

/** Which delivery, in the terms every channel's dedup already uses. */
export interface InboundEventKey {
  sourceChannel: string;
  externalChatId: string;
  externalMessageId: string;
}

/**
 * How long a committed claim blocks a redelivery of the same message.
 *
 * A day, matching the window every other webhook route in the gateway holds
 * (`StringDedupCache` in telegram-webhook, email-webhook, whatsapp-webhook,
 * mailgun-webhook) and the Slack socket dedup. Vendor retry schedules are
 * measured in hours at the outside, so this covers the retries and little
 * else.
 */
export const INBOUND_DEDUP_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * How long an unfinished claim blocks one, before it is assumed abandoned.
 *
 * Bounded below by how long a handoff can legitimately take, so a slow
 * assistant is not overtaken by the vendor's own retry: the forward is capped
 * by `runtimeTimeoutMs`, 30s by default, and this is an order of magnitude
 * above that. Bounded above by how long a message may sit undeliverable after
 * a crash, which is why it is minutes rather than the full window.
 */
export const INBOUND_CLAIM_LEASE_MS = 5 * 60 * 1_000;

/** The composite key's columns, for the upsert's conflict target. */
const KEY_COLUMNS = [
  inboundSeenEvents.sourceChannel,
  inboundSeenEvents.externalChatId,
  inboundSeenEvents.externalMessageId,
];

function keyMatches(key: InboundEventKey) {
  return and(
    eq(inboundSeenEvents.sourceChannel, key.sourceChannel),
    eq(inboundSeenEvents.externalChatId, key.externalChatId),
    eq(inboundSeenEvents.externalMessageId, key.externalMessageId),
  );
}

/**
 * Claim `key` for processing. Returns false when it is already claimed.
 *
 * One statement, because two would be a race: between a `SELECT` that found
 * nothing and the `INSERT` that followed it, a concurrent redelivery of the
 * same message would pass the same check and both would proceed. The upsert
 * takes the row only when there is none or the one there has expired, and
 * `RETURNING` reports which happened, so the returned rows are the claim.
 *
 * The claim is `pending` and short-lived until {@link commitInboundEvent}
 * says otherwise.
 */
export function reserveInboundEvent(
  key: InboundEventKey,
  leaseMs: number = INBOUND_CLAIM_LEASE_MS,
): boolean {
  const now = Date.now();
  const claim = {
    state: "pending" as const,
    seenAt: now,
    expiresAt: now + leaseMs,
  };
  const claimed = getGatewayDb()
    .insert(inboundSeenEvents)
    .values({ ...key, ...claim })
    .onConflictDoUpdate({
      target: KEY_COLUMNS,
      set: claim,
      // Only an expired row may be taken over. Without this the upsert would
      // hand every redelivery a fresh claim, which is the opposite of dedup.
      setWhere: lte(inboundSeenEvents.expiresAt, now),
    })
    .returning({ externalMessageId: inboundSeenEvents.externalMessageId })
    .all();
  return claimed.length > 0;
}

/**
 * Promote a claim to the full dedup window, the delivery having landed.
 *
 * Scoped to a row still `pending`, so a commit arriving after its own lease
 * expired and the key was reclaimed cannot reach into the claim that replaced
 * it. A commit that matches nothing is not an error: the delivery succeeded,
 * and the worst that follows is the vendor's next retry being forwarded again
 * and deduped by the assistant.
 */
export function commitInboundEvent(
  key: InboundEventKey,
  ttlMs: number = INBOUND_DEDUP_TTL_MS,
): void {
  const now = Date.now();
  getGatewayDb()
    .update(inboundSeenEvents)
    .set({ state: "committed", expiresAt: now + ttlMs })
    .where(and(keyMatches(key), eq(inboundSeenEvents.state, "pending")))
    .run();
}

/**
 * Give up a claim, so the vendor's retry is not answered as a duplicate.
 *
 * For the delivery that was claimed and then could not be handed off. Scoped
 * to `pending` for the same reason the commit is: a release is only ever the
 * caller giving up its own in-flight claim, never a retraction of a delivery
 * that already landed. Silent when there is nothing to release, since
 * releasing twice and releasing an expired claim both leave what the caller
 * wanted.
 */
export function releaseInboundEvent(key: InboundEventKey): void {
  getGatewayDb()
    .delete(inboundSeenEvents)
    .where(and(keyMatches(key), eq(inboundSeenEvents.state, "pending")))
    .run();
}

/** The live claim on `key`, if there is one. For tests and diagnostics. */
export function readInboundEventClaim(key: InboundEventKey) {
  return getGatewayDb()
    .select()
    .from(inboundSeenEvents)
    .where(and(keyMatches(key), gt(inboundSeenEvents.expiresAt, Date.now())))
    .get();
}

/** Drop expired claims. Returns how many rows went. */
export function cleanupExpiredInboundEvents(): number {
  return getGatewayDb()
    .delete(inboundSeenEvents)
    .where(lte(inboundSeenEvents.expiresAt, Date.now()))
    .returning({ externalMessageId: inboundSeenEvents.externalMessageId })
    .all().length;
}
