// ---------------------------------------------------------------------------
// Conversation lineage: the read model for referential forks.
// ---------------------------------------------------------------------------
//
// A referential fork holds only the rows written after it was created. The
// history it inherits stays on its parent and is read through
// `fork_parent_message_id`, so forking costs one conversation row instead of a
// copy of every message and attachment in the source.
//
// A conversation's logical message set is therefore a chain of segments:
//
//   [C (unbounded), parent(C) through its fork point, parent(parent(C)), ...]
//
// where each ancestor contributes only the rows at or before the fork point
// the child was taken from. `resolveConversationLineage` walks that chain and
// `lineageMessageFilter` turns it into one SQL predicate, so a lineage read is
// a single indexed query rather than a fetch per generation.
//
// Copied forks stop the walk. Their inherited prefix is physically present on
// their own row, so following the parent pointer would return those rows a
// second time. `fork_strategy` is the discriminator, and its NULL default
// reads as `cloning`, which is what every fork created before referential
// forking existed is.

import { and, eq, gt, lt, or, type SQL } from "drizzle-orm";

import { messages } from "./schema/index.js";

/**
 * Upper bound of an ancestor's contribution to a lineage, as the
 * `(createdAt, id)` pair of the message the child was forked from. The
 * composite bound mirrors the cursor ordering used everywhere else in this
 * module: `createdAt` alone cannot separate rows written inside the same
 * millisecond, which would make a fork boundary include or drop a sibling row
 * depending on insertion order.
 */
export interface LineageBound {
  createdAt: number;
  id: string;
}

/**
 * One conversation's contribution to a lineage. `through` is null for the
 * conversation the lineage was resolved for, which contributes all of its own
 * rows; ancestors carry the bound their child was forked at.
 */
export interface LineageSegment {
  conversationId: string;
  through: LineageBound | null;
}

/**
 * Maximum ancestors walked from the starting conversation. A fork of a fork is
 * already rare and the retrospective never creates one, so this is a guard
 * against a malformed pointer chain rather than a real depth limit: exceeding
 * it truncates the lineage, which renders a short history, instead of walking
 * unboundedly on a hot read path.
 */
export const MAX_LINEAGE_DEPTH = 32;

/** The `fork_strategy` value that makes a fork read through its parent. */
export const REFERENTIAL_FORK_STRATEGY = "reference";

/**
 * Whether a conversation reads its inherited history from its parent.
 *
 * All three pointers must be present: a row claiming `reference` without a
 * parent conversation or fork message has no resolvable bound, and reading it
 * as referential would silently drop the prefix instead of surfacing the
 * inconsistency as a short conversation.
 */
export function isReferentialFork(row: {
  forkStrategy: string | null;
  forkParentConversationId: string | null;
  forkParentMessageId: string | null;
}): boolean {
  return (
    row.forkStrategy === REFERENTIAL_FORK_STRATEGY &&
    row.forkParentConversationId !== null &&
    row.forkParentMessageId !== null
  );
}

/**
 * Row shape the lineage walk needs. Declared structurally so this module can
 * be driven by a caller's already-loaded conversation row without importing
 * `conversation-crud.ts`, which imports this module.
 */
export interface LineageConversationRow {
  id: string;
  forkStrategy: string | null;
  forkParentConversationId: string | null;
  forkParentMessageId: string | null;
}

export interface LineageResolverDeps {
  /** Load a conversation row, or null when it no longer exists. */
  loadConversation: (id: string) => LineageConversationRow | null;
  /** Load a message's `(createdAt, id)` bound, or null when it is gone. */
  loadMessageBound: (messageId: string) => LineageBound | null;
}

/**
 * Walk a conversation's fork chain into the ordered segments that make up its
 * logical message set. The first segment is always the conversation itself.
 *
 * The walk stops at the first conversation that is not a referential fork, at
 * a parent row or fork message that no longer exists, at a repeated
 * conversation id (a cycle a corrupted pointer could otherwise spin on), and
 * at {@link MAX_LINEAGE_DEPTH}. Every stop degrades the same way: the lineage
 * is shorter than it should be, so the conversation renders without part of
 * its inherited prefix. None of them throw, because a read path that raises on
 * a dangling pointer takes down a conversation the user can still partly see.
 *
 * A vanished fork message is worth calling out: the bound is what scopes the
 * parent's contribution, so continuing without it would splice in the parent's
 * ENTIRE history, including messages written after the fork was taken. Cutting
 * the lineage short is the conservative direction.
 *
 * Bounds TIGHTEN down the chain rather than being replaced. A fork taken
 * through an inherited message cuts at a point that lies inside its parent's
 * own inherited window, and each further ancestor must respect that narrower
 * cut as well as its own: if B reads A through m4 and C reads B through the
 * inherited m2, then C sees A only through m2. Carrying B's m4 into A's
 * segment would re-expose m3 and m4, which C explicitly forked before.
 */
export function resolveConversationLineage(
  conversationId: string,
  deps: LineageResolverDeps,
): LineageSegment[] {
  const segments: LineageSegment[] = [{ conversationId, through: null }];
  const visited = new Set<string>([conversationId]);

  let current = deps.loadConversation(conversationId);
  let tightest: LineageBound | null = null;
  while (current !== null && segments.length < MAX_LINEAGE_DEPTH) {
    if (!isReferentialFork(current)) {
      break;
    }
    const parentId = current.forkParentConversationId as string;
    if (visited.has(parentId)) {
      break;
    }
    const bound = deps.loadMessageBound(current.forkParentMessageId as string);
    if (bound === null) {
      break;
    }
    const parent = deps.loadConversation(parentId);
    if (parent === null) {
      break;
    }
    tightest = tightest === null ? bound : earlierBound(tightest, bound);
    segments.push({ conversationId: parentId, through: tightest });
    visited.add(parentId);
    current = parent;
  }

  return segments;
}

/** The earlier of two bounds in `(createdAt, id)` order. */
function earlierBound(a: LineageBound, b: LineageBound): LineageBound {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? a : b;
  }
  return a.id <= b.id ? a : b;
}

/**
 * Whether a lineage is a single unbounded segment, i.e. the conversation owns
 * every row it reads. Lets callers keep the plain `conversation_id = ?`
 * predicate for the overwhelmingly common non-fork case instead of paying for
 * the OR-of-segments form.
 */
export function isSingleSegmentLineage(segments: LineageSegment[]): boolean {
  return segments.length === 1;
}

/**
 * Build the `messages` predicate selecting every row in a lineage.
 *
 * Each ancestor segment is scoped by a `(createdAt, id)` upper bound applied
 * the same way the cursor comparisons elsewhere in this module apply theirs:
 * strictly-earlier `createdAt`, or an equal `createdAt` with an id that does
 * not sort after the bound. The fork message itself is included, because a
 * fork is taken THROUGH that message.
 *
 * Ancestor segments additionally exclude unfinalized rows. An ancestor's
 * `finalized = 0` row is a message its own live turn is still writing; a
 * descendant reading it would see partial content that the ancestor rewrites
 * inline when the turn completes. The row enters the window on its own once
 * it finalizes. A segment with no bound is the conversation's own tail and
 * keeps its unfinalized rows: a conversation always sees its own in-flight
 * message.
 */
export function lineageMessageFilter(segments: LineageSegment[]): SQL {
  const clauses = segments.map((segment) => {
    const owner = eq(messages.conversationId, segment.conversationId);
    if (segment.through === null) {
      return owner;
    }
    const { createdAt, id } = segment.through;
    return and(
      owner,
      eq(messages.finalized, 1),
      or(
        lt(messages.createdAt, createdAt),
        and(
          eq(messages.createdAt, createdAt),
          or(eq(messages.id, id), lt(messages.id, id)),
        ),
      ),
    ) as SQL;
  });
  return (clauses.length === 1 ? clauses[0]! : or(...clauses)!) as SQL;
}

/**
 * Predicate for rows in a lineage created strictly after a cursor, in the
 * lineage's global `(createdAt, id)` order rather than per conversation. Used
 * by the "everything after message X" reads, whose cursor can sit on an
 * ancestor while the rows it must return live on the descendant.
 */
export function lineageMessagesAfterFilter(
  segments: LineageSegment[],
  after: LineageBound,
): SQL {
  return and(
    lineageMessageFilter(segments),
    or(
      gt(messages.createdAt, after.createdAt),
      and(eq(messages.createdAt, after.createdAt), gt(messages.id, after.id)),
    ),
  ) as SQL;
}
