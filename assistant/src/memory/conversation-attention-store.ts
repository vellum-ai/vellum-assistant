/**
 * Store operations for conversation-level attention tracking.
 *
 * Tracks whether the user has seen the latest assistant message using two
 * tables: an append-only evidence log (conversation_attention_events) and a
 * single-row projection per conversation (conversation_assistant_attention_state).
 */

import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { UserError } from "../util/errors.js";
import { getDb } from "./db.js";
import {
  conversationAssistantAttentionState,
  conversationAttentionEvents,
  conversations,
  messages,
} from "./schema.js";

// ── Types ────────────────────────────────────────────────────────────

export type SignalType =
  | "macos_notification_view"
  | "macos_conversation_opened"
  | "ios_conversation_opened"
  | "telegram_inbound_message"
  | "telegram_callback"
  | "slack_inbound_message"
  | "slack_callback";

export type Confidence = "explicit" | "inferred";

export interface AttentionEvent {
  id: string;
  conversationId: string;
  sourceChannel: string;
  signalType: SignalType;
  confidence: Confidence;
  source: string;
  evidenceText: string | null;
  metadataJson: string;
  observedAt: number;
  createdAt: number;
}

export interface AttentionState {
  conversationId: string;
  latestAssistantMessageId: string | null;
  latestAssistantMessageAt: number | null;
  lastSeenAssistantMessageId: string | null;
  lastSeenAssistantMessageAt: number | null;
  lastSeenEventAt: number | null;
  lastSeenConfidence: Confidence | null;
  lastSeenSignalType: SignalType | null;
  lastSeenSourceChannel: string | null;
  lastSeenSource: string | null;
  lastSeenEvidenceText: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Row mappers ──────────────────────────────────────────────────────

function rowToEvent(
  row: typeof conversationAttentionEvents.$inferSelect,
): AttentionEvent {
  return {
    id: row.id,
    conversationId: row.conversationId,
    sourceChannel: row.sourceChannel,
    signalType: row.signalType as SignalType,
    confidence: row.confidence as Confidence,
    source: row.source,
    evidenceText: row.evidenceText,
    metadataJson: row.metadataJson,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
  };
}

function rowToState(
  row: typeof conversationAssistantAttentionState.$inferSelect,
): AttentionState {
  return {
    conversationId: row.conversationId,
    latestAssistantMessageId: row.latestAssistantMessageId,
    latestAssistantMessageAt: row.latestAssistantMessageAt,
    lastSeenAssistantMessageId: row.lastSeenAssistantMessageId,
    lastSeenAssistantMessageAt: row.lastSeenAssistantMessageAt,
    lastSeenEventAt: row.lastSeenEventAt,
    lastSeenConfidence: row.lastSeenConfidence as Confidence | null,
    lastSeenSignalType: row.lastSeenSignalType as SignalType | null,
    lastSeenSourceChannel: row.lastSeenSourceChannel,
    lastSeenSource: row.lastSeenSource,
    lastSeenEvidenceText: row.lastSeenEvidenceText,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── projectAssistantMessage ──────────────────────────────────────────

/**
 * Update the latest-assistant cursor when a new assistant message is persisted.
 * Monotonic: the cursor never moves backward.
 */
export function projectAssistantMessage(params: {
  conversationId: string;
  messageId: string;
  messageAt: number;
}): void {
  const { conversationId, messageId, messageAt } = params;
  const db = getDb();
  const now = Date.now();

  const existing = db
    .select()
    .from(conversationAssistantAttentionState)
    .where(
      eq(conversationAssistantAttentionState.conversationId, conversationId),
    )
    .get();

  if (!existing) {
    db.insert(conversationAssistantAttentionState)
      .values({
        conversationId,
        latestAssistantMessageId: messageId,
        latestAssistantMessageAt: messageAt,
        lastSeenAssistantMessageId: null,
        lastSeenAssistantMessageAt: null,
        lastSeenEventAt: null,
        lastSeenConfidence: null,
        lastSeenSignalType: null,
        lastSeenSourceChannel: null,
        lastSeenSource: null,
        lastSeenEvidenceText: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return;
  }

  // Monotonic: only advance if the new message is strictly later
  if (
    existing.latestAssistantMessageAt != null &&
    messageAt <= existing.latestAssistantMessageAt
  ) {
    return;
  }

  db.update(conversationAssistantAttentionState)
    .set({
      latestAssistantMessageId: messageId,
      latestAssistantMessageAt: messageAt,
      updatedAt: now,
    })
    .where(
      eq(conversationAssistantAttentionState.conversationId, conversationId),
    )
    .run();
}

// ── recordConversationSeenSignal ─────────────────────────────────────

/**
 * Record a "seen" signal: appends an immutable event row and advances the
 * seen cursor in the state projection to the current latest assistant message.
 */
export function recordConversationSeenSignal(params: {
  conversationId: string;
  sourceChannel: string;
  signalType: SignalType;
  confidence: Confidence;
  source: string;
  evidenceText?: string;
  metadata?: Record<string, unknown>;
  observedAt?: number;
}): AttentionEvent {
  const {
    conversationId,
    sourceChannel,
    signalType,
    confidence,
    source,
    evidenceText,
    metadata,
    observedAt,
  } = params;

  const db = getDb();
  const now = Date.now();
  const eventId = uuid();
  const eventObservedAt = observedAt ?? now;
  const metadataJson = metadata ? JSON.stringify(metadata) : "{}";

  const event: typeof conversationAttentionEvents.$inferInsert = {
    id: eventId,
    conversationId,
    sourceChannel,
    signalType,
    confidence,
    source,
    evidenceText: evidenceText ?? null,
    metadataJson,
    observedAt: eventObservedAt,
    createdAt: now,
  };

  db.transaction((tx) => {
    // 1. Append immutable evidence row
    tx.insert(conversationAttentionEvents).values(event).run();

    // 2. Advance the seen cursor to the current latest assistant message
    const state = tx
      .select()
      .from(conversationAssistantAttentionState)
      .where(
        eq(conversationAssistantAttentionState.conversationId, conversationId),
      )
      .get();

    if (!state) {
      // No state row yet — look up the conversation's latest assistant message so
      // upgraded databases (with existing messages but no attention row) correctly
      // initialize the full state on the first seen signal.
      const latestMsg = tx
        .select({ id: messages.id, createdAt: messages.createdAt })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.role, "assistant"),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(1)
        .get();

      const latestMsgId = latestMsg?.id ?? null;
      const latestMsgAt = latestMsg?.createdAt ?? null;

      tx.insert(conversationAssistantAttentionState)
        .values({
          conversationId,
          latestAssistantMessageId: latestMsgId,
          latestAssistantMessageAt: latestMsgAt,
          lastSeenAssistantMessageId: latestMsgId,
          lastSeenAssistantMessageAt: latestMsgAt,
          lastSeenEventAt: eventObservedAt,
          lastSeenConfidence: confidence,
          lastSeenSignalType: signalType,
          lastSeenSourceChannel: sourceChannel,
          lastSeenSource: source,
          lastSeenEvidenceText: evidenceText ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return;
    }

    // Only advance the seen cursor if there is a latest assistant message to mark as seen,
    // and the seen cursor hasn't already reached or passed it (monotonic invariant).
    const shouldAdvanceSeen =
      state.latestAssistantMessageAt != null &&
      (state.lastSeenAssistantMessageAt == null ||
        state.latestAssistantMessageAt > state.lastSeenAssistantMessageAt);

    // Guard seen metadata monotonicity: only update lastSeen* metadata when the
    // new signal's observedAt is at least as recent as the existing projection.
    // Out-of-order delivery (e.g. delayed channel callbacks) must not regress
    // the projected channel/source/confidence metadata.
    const isNewerSignal =
      state.lastSeenEventAt == null || eventObservedAt >= state.lastSeenEventAt;

    const updates: Record<string, unknown> = {
      updatedAt: now,
    };

    if (isNewerSignal) {
      updates.lastSeenEventAt = eventObservedAt;
      updates.lastSeenConfidence = confidence;
      updates.lastSeenSignalType = signalType;
      updates.lastSeenSourceChannel = sourceChannel;
      updates.lastSeenSource = source;
      updates.lastSeenEvidenceText = evidenceText ?? null;
    }

    if (shouldAdvanceSeen) {
      updates.lastSeenAssistantMessageId = state.latestAssistantMessageId;
      updates.lastSeenAssistantMessageAt = state.latestAssistantMessageAt;
    }

    tx.update(conversationAssistantAttentionState)
      .set(updates)
      .where(
        eq(conversationAssistantAttentionState.conversationId, conversationId),
      )
      .run();
  });

  return rowToEvent(event as typeof conversationAttentionEvents.$inferSelect);
}

// ── markConversationUnread ───────────────────────────────────────────

function resolveAssistantCursor(params: {
  db: Pick<ReturnType<typeof getDb>, "select">;
  conversationId: string;
  latestAssistantMessageId?: string | null;
  latestAssistantMessageAt?: number | null;
}): {
  latestAssistantMessageId: string;
  latestAssistantMessageAt: number;
  previousAssistantMessageId: string | null;
  previousAssistantMessageAt: number | null;
} | null {
  const {
    db,
    conversationId,
    latestAssistantMessageId,
    latestAssistantMessageAt,
  } = params;

  // Unread classification compares timestamps strictly, so rewinding to a
  // same-timestamp sibling would leave the latest reply classified as seen.
  const previousAssistantMessageBefore = (before: number) =>
    db
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.role, "assistant"),
          lt(messages.createdAt, before),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1)
      .get();

  if (latestAssistantMessageId && latestAssistantMessageAt != null) {
    const previousMessage = previousAssistantMessageBefore(
      latestAssistantMessageAt,
    );

    return {
      latestAssistantMessageId,
      latestAssistantMessageAt,
      previousAssistantMessageId: previousMessage?.id ?? null,
      previousAssistantMessageAt: previousMessage?.createdAt ?? null,
    };
  }

  const latestMessage = db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "assistant"),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1)
    .get();

  if (!latestMessage) {
    return null;
  }

  const previousMessage = previousAssistantMessageBefore(
    latestMessage.createdAt,
  );
  return {
    latestAssistantMessageId: latestMessage.id,
    latestAssistantMessageAt: latestMessage.createdAt,
    previousAssistantMessageId: previousMessage?.id ?? null,
    previousAssistantMessageAt: previousMessage?.createdAt ?? null,
  };
}

/**
 * Rewind the seen cursor so the current latest assistant reply becomes unread.
 * This uses the existing attention projection instead of adding a separate
 * manual-unread state machine.
 */
export function markConversationUnread(conversationId: string): void {
  const db = getDb();
  const now = Date.now();

  db.transaction((tx) => {
    const state = tx
      .select()
      .from(conversationAssistantAttentionState)
      .where(
        eq(conversationAssistantAttentionState.conversationId, conversationId),
      )
      .get();

    const cursor = resolveAssistantCursor({
      db: tx,
      conversationId,
      latestAssistantMessageId: state?.latestAssistantMessageId,
      latestAssistantMessageAt: state?.latestAssistantMessageAt,
    });

    if (!cursor) {
      throw new UserError(
        "Conversation has no assistant message to mark unread",
      );
    }

    const isAlreadyUnread =
      state != null &&
      (state.lastSeenAssistantMessageAt == null ||
        state.lastSeenAssistantMessageAt < cursor.latestAssistantMessageAt);

    if (isAlreadyUnread) {
      return;
    }

    if (!state) {
      tx.insert(conversationAssistantAttentionState)
        .values({
          conversationId,
          latestAssistantMessageId: cursor.latestAssistantMessageId,
          latestAssistantMessageAt: cursor.latestAssistantMessageAt,
          lastSeenAssistantMessageId: cursor.previousAssistantMessageId,
          lastSeenAssistantMessageAt: cursor.previousAssistantMessageAt,
          lastSeenEventAt: null,
          lastSeenConfidence: null,
          lastSeenSignalType: null,
          lastSeenSourceChannel: null,
          lastSeenSource: null,
          lastSeenEvidenceText: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return;
    }

    tx.update(conversationAssistantAttentionState)
      .set({
        lastSeenAssistantMessageId: cursor.previousAssistantMessageId,
        lastSeenAssistantMessageAt: cursor.previousAssistantMessageAt,
        updatedAt: now,
      })
      .where(
        eq(conversationAssistantAttentionState.conversationId, conversationId),
      )
      .run();
  });
}

// ── getAttentionStateByConversationIds ───────────────────────────────

/**
 * Batch read for conversation list enrichment.
 * Returns a map of conversationId -> AttentionState.
 */
export function getAttentionStateByConversationIds(
  conversationIds: string[],
): Map<string, AttentionState> {
  if (conversationIds.length === 0) return new Map();

  const db = getDb();
  const rows = db
    .select()
    .from(conversationAssistantAttentionState)
    .where(
      inArray(
        conversationAssistantAttentionState.conversationId,
        conversationIds,
      ),
    )
    .all();

  const result = new Map<string, AttentionState>();
  for (const row of rows) {
    result.set(row.conversationId, rowToState(row));
  }
  return result;
}

// ── listConversationAttention ────────────────────────────────────────

export type AttentionFilterState = "seen" | "unseen" | "all";

export interface ListConversationAttentionParams {
  state?: AttentionFilterState;
  sourceChannel?: string;
  source?: string;
  limit?: number;
  before?: number;
}

/**
 * Filtered list for assistant/LLM reporting API.
 * Supports filters: state (seen/unseen/all), source channel, limit, before cursor.
 */
export function listConversationAttention(
  params: ListConversationAttentionParams,
): AttentionState[] {
  const {
    state: filterState = "all",
    sourceChannel,
    source,
    limit = 50,
    before,
  } = params;

  const db = getDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];

  if (sourceChannel) {
    conditions.push(eq(conversations.originChannel, sourceChannel));
  }

  if (source) {
    conditions.push(eq(conversations.source, source));
  }

  if (before !== undefined) {
    conditions.push(
      lt(conversationAssistantAttentionState.latestAssistantMessageAt, before),
    );
  }

  if (filterState === "unseen") {
    // Unseen: latest assistant message exists but no seen cursor, or seen cursor is behind latest
    conditions.push(
      sql`${conversationAssistantAttentionState.latestAssistantMessageAt} IS NOT NULL`,
    );
    conditions.push(
      or(
        isNull(conversationAssistantAttentionState.lastSeenAssistantMessageAt),
        sql`${conversationAssistantAttentionState.lastSeenAssistantMessageAt} < ${conversationAssistantAttentionState.latestAssistantMessageAt}`,
      )!,
    );
  } else if (filterState === "seen") {
    // Seen: seen cursor equals latest assistant message
    conditions.push(
      sql`${conversationAssistantAttentionState.latestAssistantMessageAt} IS NOT NULL`,
    );
    conditions.push(
      sql`${conversationAssistantAttentionState.lastSeenAssistantMessageAt} = ${conversationAssistantAttentionState.latestAssistantMessageAt}`,
    );
  }

  let query = db
    .select({
      conversationId: conversationAssistantAttentionState.conversationId,
      latestAssistantMessageId:
        conversationAssistantAttentionState.latestAssistantMessageId,
      latestAssistantMessageAt:
        conversationAssistantAttentionState.latestAssistantMessageAt,
      lastSeenAssistantMessageId:
        conversationAssistantAttentionState.lastSeenAssistantMessageId,
      lastSeenAssistantMessageAt:
        conversationAssistantAttentionState.lastSeenAssistantMessageAt,
      lastSeenEventAt: conversationAssistantAttentionState.lastSeenEventAt,
      lastSeenConfidence:
        conversationAssistantAttentionState.lastSeenConfidence,
      lastSeenSignalType:
        conversationAssistantAttentionState.lastSeenSignalType,
      lastSeenSourceChannel:
        conversationAssistantAttentionState.lastSeenSourceChannel,
      lastSeenSource: conversationAssistantAttentionState.lastSeenSource,
      lastSeenEvidenceText:
        conversationAssistantAttentionState.lastSeenEvidenceText,
      createdAt: conversationAssistantAttentionState.createdAt,
      updatedAt: conversationAssistantAttentionState.updatedAt,
    })
    .from(conversationAssistantAttentionState);

  // Only join conversations table when filtering by source or sourceChannel
  if (source || sourceChannel) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query = (query as any).innerJoin(
      conversations,
      eq(conversationAssistantAttentionState.conversationId, conversations.id),
    );
  }

  const rows = (conditions.length > 0 ? query.where(and(...conditions)) : query)
    .orderBy(desc(conversationAssistantAttentionState.latestAssistantMessageAt))
    .limit(limit)
    .all();

  return rows.map(rowToState);
}
