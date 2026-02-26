/**
 * Store operations for conversation-level attention tracking.
 *
 * Tracks whether the user has seen the latest assistant message using two
 * tables: an append-only evidence log (conversation_attention_events) and a
 * single-row projection per conversation (conversation_assistant_attention_state).
 */

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

import { getLogger } from '../util/logger.js';
import { getDb } from './db.js';
import { conversationAssistantAttentionState, conversationAttentionEvents } from './schema.js';

const log = getLogger('conversation-attention-store');

// ── Types ────────────────────────────────────────────────────────────

export type SignalType =
  | 'macos_notification_view'
  | 'macos_conversation_opened'
  | 'telegram_inbound_message'
  | 'telegram_callback';

export type Confidence = 'explicit' | 'inferred';

export interface AttentionEvent {
  id: string;
  conversationId: string;
  assistantId: string;
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
  assistantId: string;
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

function rowToEvent(row: typeof conversationAttentionEvents.$inferSelect): AttentionEvent {
  return {
    id: row.id,
    conversationId: row.conversationId,
    assistantId: row.assistantId,
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

function rowToState(row: typeof conversationAssistantAttentionState.$inferSelect): AttentionState {
  return {
    conversationId: row.conversationId,
    assistantId: row.assistantId,
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
  assistantId: string;
  messageId: string;
  messageAt: number;
}): void {
  const { conversationId, assistantId, messageId, messageAt } = params;
  const db = getDb();
  const now = Date.now();

  const existing = db
    .select()
    .from(conversationAssistantAttentionState)
    .where(eq(conversationAssistantAttentionState.conversationId, conversationId))
    .get();

  if (!existing) {
    db.insert(conversationAssistantAttentionState)
      .values({
        conversationId,
        assistantId,
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
  if (existing.latestAssistantMessageAt !== null && messageAt <= existing.latestAssistantMessageAt) {
    return;
  }

  db.update(conversationAssistantAttentionState)
    .set({
      latestAssistantMessageId: messageId,
      latestAssistantMessageAt: messageAt,
      updatedAt: now,
    })
    .where(eq(conversationAssistantAttentionState.conversationId, conversationId))
    .run();
}

// ── recordConversationSeenSignal ─────────────────────────────────────

/**
 * Record a "seen" signal: appends an immutable event row and advances the
 * seen cursor in the state projection to the current latest assistant message.
 */
export function recordConversationSeenSignal(params: {
  conversationId: string;
  assistantId: string;
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
    assistantId,
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
  const metadataJson = metadata ? JSON.stringify(metadata) : '{}';

  const event: typeof conversationAttentionEvents.$inferInsert = {
    id: eventId,
    conversationId,
    assistantId,
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
      .where(eq(conversationAssistantAttentionState.conversationId, conversationId))
      .get();

    if (!state) {
      // No state row yet — create one with seen cursor only (no latest assistant message yet)
      tx.insert(conversationAssistantAttentionState)
        .values({
          conversationId,
          assistantId,
          latestAssistantMessageId: null,
          latestAssistantMessageAt: null,
          lastSeenAssistantMessageId: null,
          lastSeenAssistantMessageAt: null,
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
      state.latestAssistantMessageAt !== null &&
      (state.lastSeenAssistantMessageAt === null ||
        state.latestAssistantMessageAt > state.lastSeenAssistantMessageAt);

    const updates: Record<string, unknown> = {
      lastSeenEventAt: eventObservedAt,
      lastSeenConfidence: confidence,
      lastSeenSignalType: signalType,
      lastSeenSourceChannel: sourceChannel,
      lastSeenSource: source,
      lastSeenEvidenceText: evidenceText ?? null,
      updatedAt: now,
    };

    if (shouldAdvanceSeen) {
      updates.lastSeenAssistantMessageId = state.latestAssistantMessageId;
      updates.lastSeenAssistantMessageAt = state.latestAssistantMessageAt;
    }

    tx.update(conversationAssistantAttentionState)
      .set(updates)
      .where(eq(conversationAssistantAttentionState.conversationId, conversationId))
      .run();
  });

  return rowToEvent(event as typeof conversationAttentionEvents.$inferSelect);
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
    .where(inArray(conversationAssistantAttentionState.conversationId, conversationIds))
    .all();

  const result = new Map<string, AttentionState>();
  for (const row of rows) {
    result.set(row.conversationId, rowToState(row));
  }
  return result;
}

// ── listConversationAttention ────────────────────────────────────────

export type AttentionFilterState = 'seen' | 'unseen' | 'all';

export interface ListConversationAttentionParams {
  assistantId: string;
  state?: AttentionFilterState;
  sourceChannel?: string;
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
    assistantId,
    state: filterState = 'all',
    sourceChannel,
    limit = 50,
    before,
  } = params;

  const db = getDb();
  const conditions = [eq(conversationAssistantAttentionState.assistantId, assistantId)];

  if (sourceChannel) {
    conditions.push(eq(conversationAssistantAttentionState.lastSeenSourceChannel, sourceChannel));
  }

  if (before !== undefined) {
    conditions.push(
      lt(conversationAssistantAttentionState.latestAssistantMessageAt, before),
    );
  }

  if (filterState === 'unseen') {
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
  } else if (filterState === 'seen') {
    // Seen: seen cursor equals latest assistant message
    conditions.push(
      sql`${conversationAssistantAttentionState.latestAssistantMessageAt} IS NOT NULL`,
    );
    conditions.push(
      sql`${conversationAssistantAttentionState.lastSeenAssistantMessageAt} = ${conversationAssistantAttentionState.latestAssistantMessageAt}`,
    );
  }

  const rows = db
    .select()
    .from(conversationAssistantAttentionState)
    .where(and(...conditions))
    .orderBy(desc(conversationAssistantAttentionState.latestAssistantMessageAt))
    .limit(limit)
    .all();

  return rows.map(rowToState);
}
