// ---------------------------------------------------------------------------
// Memory retrospective — kind-aware message accounting.
// ---------------------------------------------------------------------------
//
// After a successful run, `finalizeSuccessfulRetrospective` persists
// `lastProcessedMessageId` and THEN (flag-gated) appends the
// `skill-authored-card` assistant message to the source conversation — so the
// card always lands past the cursor the run just wrote. To the generic
// `countMessagesAfter` / `getMessagesAfter` helpers that card is
// indistinguishable from real conversation content: an otherwise-idle
// conversation would wake another retrospective over the assistant's own card
// and re-review its `_surfaceFallback` text.
//
// These wrappers exclude skill-card rows from retrospective accounting on
// BOTH paths — the trigger check's message count (including its
// zero-new-messages early-out) and the job's new-message slice — without
// touching the generic persistence helpers' semantics for other callers.
//
// The cursor is never blindly advanced over a card: the job still takes its
// cutoff from the last NON-card row of the filtered slice, so a real message
// that lands between the cutoff snapshot and the card insert can never be
// skipped. A trailing card simply stays past the cursor, invisible to
// accounting; once newer real messages arrive it is copied into the next
// run's fork as inert prefix context.

import { and, eq, like } from "drizzle-orm";

import {
  countMessagesAfter,
  getMessagesAfter,
  type MessageRow,
} from "../../../persistence/conversation-crud.js";
import { getDb } from "../../../persistence/db-connection.js";
import { messages } from "../../../persistence/schema/index.js";
import { SKILL_CARD_MESSAGE_KIND } from "./memory-retrospective-constants.js";

/** True when a message row's metadata carries the skill-card kind. */
export function isSkillCardMessage(row: { metadata: string | null }): boolean {
  if (!row.metadata) return false;
  try {
    const meta: unknown = JSON.parse(row.metadata);
    return (
      !!meta &&
      typeof meta === "object" &&
      (meta as Record<string, unknown>).kind === SKILL_CARD_MESSAGE_KIND
    );
  } catch {
    return false;
  }
}

/**
 * `getMessagesAfter` minus skill-card rows. The retrospective job's
 * new-message slice: a card-only tail yields an empty slice (the job's
 * `no_new_messages` early return), and a mixed tail's cutoff lands on the
 * last real message rather than the card.
 */
export function getRetrospectiveMessagesAfter(
  conversationId: string,
  afterMessageId: string | null,
): MessageRow[] {
  return getMessagesAfter(conversationId, afterMessageId).filter(
    (row) => !isSkillCardMessage(row),
  );
}

/**
 * `countMessagesAfter` minus skill-card rows. Stays count-shaped — the
 * trigger check runs after every agent turn and the generic count helper
 * exists precisely so that path never loads message bodies — so the total
 * comes from `countMessagesAfter` and the handful of card rows past the
 * cursor are counted separately and subtracted.
 */
export function countRetrospectiveMessagesAfter(
  conversationId: string,
  afterMessageId: string | null,
): number {
  const total = countMessagesAfter(conversationId, afterMessageId);
  if (total === 0) return 0;
  const cardCount = countSkillCardMessagesAfter(conversationId, afterMessageId);
  return Math.max(0, total - cardCount);
}

/**
 * Count skill-card rows strictly after the `(createdAt, id)` cursor. A LIKE
 * prefilter keeps the scan from loading every row's metadata (cards are rare
 * — at most one per successful retrospective run); each candidate is then
 * JSON-verified by {@link isSkillCardMessage} so an incidental substring
 * match in unrelated metadata can never exclude a real message from
 * accounting. The cursor comparison mirrors `countMessagesAfter`'s
 * tie-breaker semantics, including the null/`""` "count everything" cases
 * and the vanished-reference "no new work" case.
 */
function countSkillCardMessagesAfter(
  conversationId: string,
  afterMessageId: string | null,
): number {
  // The `""` sentinel (failure-only state rows) counts everything, matching
  // `countMessagesAfter`.
  const cursorId =
    afterMessageId === null || afterMessageId === "" ? null : afterMessageId;
  const db = getDb();
  const candidates = db
    .select({
      id: messages.id,
      createdAt: messages.createdAt,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        like(messages.metadata, `%"kind":"${SKILL_CARD_MESSAGE_KIND}"%`),
      ),
    )
    .all();
  if (candidates.length === 0) return 0;

  let ref: { createdAt: number } | undefined;
  if (cursorId !== null) {
    ref = db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, cursorId))
      .get();
    // Vanished reference: `countMessagesAfter` reported 0, so there is
    // nothing to subtract from.
    if (!ref) return 0;
  }

  let count = 0;
  for (const row of candidates) {
    if (!isSkillCardMessage(row)) continue;
    if (cursorId !== null && ref) {
      const after =
        row.createdAt > ref.createdAt ||
        (row.createdAt === ref.createdAt && row.id > cursorId);
      if (!after) continue;
    }
    count++;
  }
  return count;
}
