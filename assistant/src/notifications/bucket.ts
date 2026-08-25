/**
 * Bucket derivation: which of the three notification sections a signal lands
 * in, and how loudly it arrives.
 *
 * One field, derived by fixed rules rather than chosen by the decision
 * engine. The model keeps channel selection and wording; it has no say in
 * importance, which has to be predictable for the sections to mean anything.
 *
 * The rules, in the order they apply:
 *
 *   1. Anything requiring an action or a decision is **needs you**.
 *   2. Anything the assistant deliberately chose to tell you, plus fixable
 *      failures and escalations, is **worth knowing**.
 *   3. Everything else is **activity**.
 *
 * `priority`, `noteworthy`, and `category` are no longer independent ranking
 * dimensions. They survive on the wire as projections of the bucket
 * ({@link bucketCompat}) so clients built against the pre-bucket contract keep
 * sorting and grouping sensibly, and nothing computes them on its own.
 */

import type {
  FeedItemBucket,
  FeedItemCategory,
} from "../api/responses/home.js";
import type { NotificationSignal } from "./signal.js";

/** Events where work is blocked on the user answering or deciding something. */
const NEEDS_YOU_EVENTS: ReadonlySet<string> = new Set([
  "guardian.question",
  "guardian.channel_activation",
  "ingress.access_request",
  "ingress.access_request.callback_handoff",
  "credential.health_alert",
  "tool_confirmation.required_action",
  "run.needs_input",
]);

/**
 * Events that carry a real outcome or observation with nothing blocked: a
 * reminder the user asked for, something the assistant chose to share, a
 * watcher finding, a reply that landed while they were away, and the run
 * transitions worth interrupting for.
 */
const WORTH_KNOWING_EVENTS: ReadonlySet<string> = new Set([
  "user.send_notification",
  "schedule.notify",
  "watcher.notification",
  "watcher.escalation",
  "chat.assistant_reply",
  "run.finished_notable",
  "run.failed",
]);

/**
 * Derive the bucket for a signal. Pure and total: every signal lands in
 * exactly one bucket, and the same signal always lands in the same one.
 */
export function deriveBucket(
  signal: Pick<NotificationSignal, "sourceEventName" | "attentionHints">,
): FeedItemBucket {
  if (NEEDS_YOU_EVENTS.has(signal.sourceEventName)) {
    return "needs_you";
  }
  // Rule 1 is about the signal, not the registry: a producer that declares
  // its signal blocks the user gets the top section whatever it is named.
  if (signal.attentionHints.requiresAction) {
    return "needs_you";
  }
  if (WORTH_KNOWING_EVENTS.has(signal.sourceEventName)) {
    return "worth_knowing";
  }
  return "activity";
}

/**
 * Sort weight for a bucket, as the `priority` field older clients order by.
 *
 * Spaced so the three sections never interleave, and so a future sub-rank
 * inside a section has room.
 */
const BUCKET_PRIORITY: Record<FeedItemBucket, number> = {
  needs_you: 90,
  worth_knowing: 60,
  activity: 30,
};

/**
 * Category a bucket projects onto, for clients that paint the chip.
 *
 * Categories were an independent dimension that only ever tinted a chip;
 * collapsing them onto the bucket keeps those clients rendering something
 * coherent without reintroducing a second ranking axis.
 */
const BUCKET_CATEGORY: Record<FeedItemBucket, FeedItemCategory> = {
  needs_you: "security",
  worth_knowing: "system",
  activity: "background",
};

export interface BucketCompatProjection {
  priority: number;
  noteworthy: boolean;
  category: FeedItemCategory;
}

/**
 * The pre-bucket fields a row still carries, derived from its bucket alone.
 *
 * `noteworthy` split the feed into inbox-style and activity-style surfaces on
 * shipped clients, which is exactly the needs-you/worth-knowing versus
 * activity split, so it projects cleanly.
 */
export function bucketCompat(bucket: FeedItemBucket): BucketCompatProjection {
  return {
    priority: BUCKET_PRIORITY[bucket],
    noteworthy: bucket !== "activity",
    category: BUCKET_CATEGORY[bucket],
  };
}

/**
 * How long a row of each bucket stays in the feed, in milliseconds.
 *
 * Needs-you rows expire on resolution rather than on a clock, so they carry
 * no TTL: a pending approval that aged out of the bell would be a silent
 * loss of the thing the section exists for.
 */
const BUCKET_TTL_MS: Record<FeedItemBucket, number | null> = {
  needs_you: null,
  worth_knowing: 7 * 24 * 60 * 60 * 1000,
  activity: 48 * 60 * 60 * 1000,
};

/**
 * Absolute expiry for a row of this bucket, or `undefined` when it does not
 * expire on a clock. `nowMs` is injected so callers can write deterministic
 * tests without freezing the process clock.
 */
export function bucketExpiresAt(
  bucket: FeedItemBucket,
  nowMs: number,
): string | undefined {
  const ttl = BUCKET_TTL_MS[bucket];
  return ttl === null ? undefined : new Date(nowMs + ttl).toISOString();
}
