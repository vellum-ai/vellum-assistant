/**
 * Thread candidate builder for notification thread reuse.
 *
 * Builds a lightweight candidate set of recent notification conversations
 * per channel that the decision engine can choose to reuse instead of
 * starting a new thread. Includes guardian-specific context (pending
 * unresolved request count) when available.
 *
 * The candidate set is intentionally compact — only the fields the LLM
 * needs for a routing decision, not full conversation contents.
 */

import { and, desc, eq, isNotNull } from 'drizzle-orm';

import { getDb } from '../memory/db.js';
import { countPendingByConversation } from '../memory/guardian-approvals.js';
import { conversations, notificationDeliveries, notificationDecisions, notificationEvents } from '../memory/schema.js';
import { getLogger } from '../util/logger.js';
import type { NotificationChannel } from './types.js';

const log = getLogger('thread-candidates');

/** Maximum number of candidate threads to surface per channel. */
const MAX_CANDIDATES_PER_CHANNEL = 5;

/** Only consider conversations updated within this window (ms). */
const CANDIDATE_RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// -- Public types -------------------------------------------------------------

/** Guardian-specific context attached to a thread candidate when available. */
export interface GuardianCandidateContext {
  /** Number of unresolved (pending) guardian approval requests in this conversation. */
  pendingUnresolvedRequestCount: number;
}

/** A single candidate conversation that the decision engine can select for reuse. */
export interface ThreadCandidate {
  conversationId: string;
  title: string | null;
  updatedAt: number;
  /** The source event name from the most recent notification delivered to this conversation. */
  latestSourceEventName: string | null;
  channel: NotificationChannel;
  /** Guardian-specific context, present only when there are relevant guardian records. */
  guardianContext?: GuardianCandidateContext;
}

/** Candidate set for the decision engine, keyed by channel. */
export type ThreadCandidateSet = Partial<Record<NotificationChannel, ThreadCandidate[]>>;

// -- Core builder -------------------------------------------------------------

/**
 * Build the thread candidate set for all selected channels.
 *
 * Queries recent notification-sourced conversations that were delivered
 * to each channel and enriches them with guardian-specific metadata
 * when available.
 *
 * Errors are caught per-channel so a failure in one channel does not
 * block candidates for others.
 */
export function buildThreadCandidates(
  channels: NotificationChannel[],
  assistantId: string,
): ThreadCandidateSet {
  const result: ThreadCandidateSet = {};
  const cutoff = Date.now() - CANDIDATE_RECENCY_WINDOW_MS;

  for (const channel of channels) {
    try {
      const candidates = buildCandidatesForChannel(channel, assistantId, cutoff);
      if (candidates.length > 0) {
        result[channel] = candidates;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn({ err: errMsg, channel }, 'Failed to build thread candidates for channel');
    }
  }

  return result;
}

// -- Per-channel query --------------------------------------------------------

/**
 * Query recent notification conversations for a given channel.
 *
 * Joins notification_deliveries -> notification_decisions -> notification_events
 * to find conversations that were created by the notification pipeline for
 * this channel, then enriches with guardian context.
 */
function buildCandidatesForChannel(
  channel: NotificationChannel,
  assistantId: string,
  cutoffMs: number,
): ThreadCandidate[] {
  const db = getDb();

  // Find recent notification deliveries for this channel that have a
  // conversationId and were successfully sent.
  const rows = db
    .select({
      conversationId: notificationDeliveries.conversationId,
      channel: notificationDeliveries.channel,
      deliverySentAt: notificationDeliveries.sentAt,
      sourceEventName: notificationEvents.sourceEventName,
      convTitle: conversations.title,
      convUpdatedAt: conversations.updatedAt,
    })
    .from(notificationDeliveries)
    .innerJoin(
      notificationDecisions,
      eq(notificationDeliveries.notificationDecisionId, notificationDecisions.id),
    )
    .innerJoin(
      notificationEvents,
      eq(notificationDecisions.notificationEventId, notificationEvents.id),
    )
    .innerJoin(
      conversations,
      eq(notificationDeliveries.conversationId, conversations.id),
    )
    .where(
      and(
        eq(notificationDeliveries.channel, channel),
        eq(notificationDeliveries.assistantId, assistantId),
        eq(notificationDeliveries.status, 'sent'),
        isNotNull(notificationDeliveries.conversationId),
      ),
    )
    .orderBy(desc(notificationDeliveries.sentAt))
    .limit(MAX_CANDIDATES_PER_CHANNEL * 3) // over-fetch to allow deduplication
    .all();

  // Deduplicate by conversationId (keep the most recent delivery per conversation)
  const seen = new Set<string>();
  const candidates: ThreadCandidate[] = [];

  for (const row of rows) {
    if (!row.conversationId) continue;
    if (seen.has(row.conversationId)) continue;

    // Apply recency filter on the conversation's updatedAt
    if (row.convUpdatedAt < cutoffMs) continue;

    seen.add(row.conversationId);

    const candidate: ThreadCandidate = {
      conversationId: row.conversationId,
      title: row.convTitle,
      updatedAt: row.convUpdatedAt,
      latestSourceEventName: row.sourceEventName ?? null,
      channel: channel,
    };

    // Enrich with guardian context
    const guardianContext = buildGuardianContext(row.conversationId, assistantId);
    if (guardianContext) {
      candidate.guardianContext = guardianContext;
    }

    candidates.push(candidate);

    if (candidates.length >= MAX_CANDIDATES_PER_CHANNEL) break;
  }

  return candidates;
}

// -- Guardian context enrichment ----------------------------------------------

/**
 * Build guardian-specific context for a candidate conversation.
 * Returns null when there is no guardian-relevant data.
 */
function buildGuardianContext(
  conversationId: string,
  assistantId: string,
): GuardianCandidateContext | null {
  try {
    const pendingCount = countPendingByConversation(conversationId, assistantId);
    if (pendingCount > 0) {
      return { pendingUnresolvedRequestCount: pendingCount };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn({ err: errMsg, conversationId }, 'Failed to query guardian context for candidate');
  }

  return null;
}

// -- Prompt serialization -----------------------------------------------------

/**
 * Serialize a thread candidate set into a compact text block suitable for
 * injection into the decision engine's user prompt.
 *
 * Designed to be token-efficient while giving the LLM enough context
 * to make a reuse decision.
 */
export function serializeCandidatesForPrompt(candidateSet: ThreadCandidateSet): string | null {
  const channelEntries = Object.entries(candidateSet) as [NotificationChannel, ThreadCandidate[]][];
  if (channelEntries.length === 0) return null;

  const sections: string[] = [];

  for (const [channel, candidates] of channelEntries) {
    if (candidates.length === 0) continue;

    const lines: string[] = [`Channel: ${channel}`];
    for (const c of candidates) {
      const parts: string[] = [
        `  - id=${c.conversationId}`,
        `title="${c.title ?? '(untitled)'}"`,
        `updated=${new Date(c.updatedAt).toISOString()}`,
      ];
      if (c.latestSourceEventName) {
        parts.push(`lastEvent="${c.latestSourceEventName}"`);
      }
      if (c.guardianContext) {
        parts.push(`pendingRequests=${c.guardianContext.pendingUnresolvedRequestCount}`);
      }
      lines.push(parts.join(' '));
    }
    sections.push(lines.join('\n'));
  }

  if (sections.length === 0) return null;
  return sections.join('\n\n');
}
