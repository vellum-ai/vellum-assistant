/**
 * Build candidate thread sets per notification channel.
 *
 * Queries recent notification-sourced conversations and enriches them with
 * guardian-specific context (pending request counts, call session associations)
 * so the decision engine can make an informed reuse-vs-new-thread choice.
 *
 * The candidate set is intentionally lightweight: only metadata needed for the
 * decision prompt is included, keeping token overhead low and the audit trail
 * readable.
 */

import { and, desc, eq } from 'drizzle-orm';

import { getDb } from '../memory/db.js';
import {
  guardianActionDeliveries,
  guardianActionRequests,
  notificationDeliveries,
  notificationDecisions,
  notificationEvents,
} from '../memory/schema.js';
import { getLogger } from '../util/logger.js';
import type { NotificationChannel, ThreadCandidate } from './types.js';

const log = getLogger('thread-candidates');

/** Maximum number of candidate threads surfaced per channel. */
const MAX_CANDIDATES_PER_CHANNEL = 5;

/** Only consider threads updated within this window (ms). */
const CANDIDATE_RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Build the set of candidate threads for a given channel that the decision
 * engine may select for reuse.
 *
 * Returns an empty array when no recent notification threads exist for the
 * channel, which signals the engine to use start_new.
 */
export function buildCandidatesForChannel(
  channel: NotificationChannel,
  assistantId: string,
): ThreadCandidate[] {
  try {
    const db = getDb();
    const cutoff = Date.now() - CANDIDATE_RECENCY_WINDOW_MS;

    // Find recent notification deliveries for this channel that have a
    // paired conversation. We join through decisions -> events to get
    // the sourceEventName and filter by assistantId.
    const rows = db
      .select({
        conversationId: notificationDeliveries.conversationId,
        renderedTitle: notificationDeliveries.renderedTitle,
        deliveryUpdatedAt: notificationDeliveries.updatedAt,
        sourceEventName: notificationEvents.sourceEventName,
        channel: notificationDeliveries.channel,
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
      .where(
        and(
          eq(notificationDeliveries.channel, channel),
          eq(notificationDeliveries.assistantId, assistantId),
          eq(notificationDeliveries.status, 'sent'),
        ),
      )
      .orderBy(desc(notificationDeliveries.updatedAt))
      .limit(MAX_CANDIDATES_PER_CHANNEL * 3) // over-fetch to allow dedup
      .all();

    // Deduplicate by conversationId (keep the most recent delivery per conversation)
    const seen = new Set<string>();
    const candidates: ThreadCandidate[] = [];

    for (const row of rows) {
      if (!row.conversationId) continue;
      if (row.deliveryUpdatedAt < cutoff) continue;
      if (seen.has(row.conversationId)) continue;
      seen.add(row.conversationId);

      const candidate: ThreadCandidate = {
        conversationId: row.conversationId,
        title: row.renderedTitle,
        updatedAt: row.deliveryUpdatedAt,
        latestSourceEventName: row.sourceEventName,
        channel: channel,
      };

      // Enrich with guardian-specific context when applicable
      enrichGuardianContext(db, candidate);

      candidates.push(candidate);
      if (candidates.length >= MAX_CANDIDATES_PER_CHANNEL) break;
    }

    return candidates;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: errMsg, channel, assistantId },
      'Failed to build thread candidates — returning empty set',
    );
    return [];
  }
}

/**
 * Build candidate sets for all selected channels in a single call.
 * Returns a map of channel -> candidates.
 */
export function buildCandidatesForChannels(
  channels: NotificationChannel[],
  assistantId: string,
): Partial<Record<NotificationChannel, ThreadCandidate[]>> {
  const result: Partial<Record<NotificationChannel, ThreadCandidate[]>> = {};
  for (const channel of channels) {
    const candidates = buildCandidatesForChannel(channel, assistantId);
    if (candidates.length > 0) {
      result[channel] = candidates;
    }
  }
  return result;
}

/**
 * Validate that a model-selected conversationId is present in the provided
 * candidate set for the given channel. Returns true only if the id is a
 * valid candidate.
 */
export function isValidCandidateId(
  conversationId: string,
  candidates: ThreadCandidate[],
): boolean {
  return candidates.some((c) => c.conversationId === conversationId);
}

// -- Guardian context enrichment -----------------------------------------------

function enrichGuardianContext(
  db: ReturnType<typeof getDb>,
  candidate: ThreadCandidate,
): void {
  try {
    // Look for guardian action deliveries targeting this conversation
    const deliveries = db
      .select({
        requestId: guardianActionDeliveries.requestId,
      })
      .from(guardianActionDeliveries)
      .where(
        eq(guardianActionDeliveries.destinationConversationId, candidate.conversationId),
      )
      .all();

    if (deliveries.length === 0) return;

    const requestIds = [...new Set(deliveries.map((d) => d.requestId))];

    // Count pending requests and find the most recent callSessionId
    let pendingCount = 0;
    let recentCallSessionId: string | null = null;
    let recentCreatedAt = 0;

    for (const requestId of requestIds) {
      const request = db
        .select({
          status: guardianActionRequests.status,
          callSessionId: guardianActionRequests.callSessionId,
          createdAt: guardianActionRequests.createdAt,
        })
        .from(guardianActionRequests)
        .where(eq(guardianActionRequests.id, requestId))
        .get();

      if (!request) continue;

      if (request.status === 'pending') {
        pendingCount++;
      }
      if (request.createdAt > recentCreatedAt) {
        recentCreatedAt = request.createdAt;
        recentCallSessionId = request.callSessionId;
      }
    }

    if (pendingCount > 0) {
      candidate.pendingGuardianRequestCount = pendingCount;
    }
    if (recentCallSessionId) {
      candidate.recentCallSessionId = recentCallSessionId;
    }
  } catch (err) {
    // Guardian enrichment is best-effort; log and continue
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: errMsg, conversationId: candidate.conversationId },
      'Guardian context enrichment failed — continuing without',
    );
  }
}
