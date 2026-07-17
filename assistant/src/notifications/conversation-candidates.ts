/**
 * Conversation candidate builder for notification conversation reuse.
 *
 * Builds a lightweight candidate set of recent notification conversations
 * per channel that the decision engine can choose to reuse instead of
 * starting a new conversation. Includes guardian-specific context (pending
 * unresolved request count) when available.
 *
 * The candidate set is intentionally compact — only the fields the LLM
 * needs for a routing decision, not full conversation contents.
 */

import { and, desc, eq, isNotNull } from "drizzle-orm";

import { listPendingRequestsByScopeOrEmpty } from "../channels/gateway-guardian-requests.js";
import { getDb } from "../persistence/db-connection.js";
import {
  conversations,
  notificationDecisions,
  notificationDeliveries,
  notificationEvents,
} from "../persistence/schema/index.js";
import { getLogger } from "../util/logger.js";
import type { NotificationChannel } from "./types.js";

const log = getLogger("conversation-candidates");

/** Maximum number of candidate conversations to surface per channel. */
const MAX_CANDIDATES_PER_CHANNEL = 5;

/** Only consider conversations updated within this window (ms). */
const CANDIDATE_RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// -- Public types -------------------------------------------------------------

/** Guardian-specific context attached to a conversation candidate when available. */
export interface GuardianCandidateContext {
  /** Number of unresolved (pending) guardian approval requests in this conversation. */
  pendingUnresolvedRequestCount: number;
}

/** A single candidate conversation that the decision engine can select for reuse. */
export interface ConversationCandidate {
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
export type ConversationCandidateSet = Partial<
  Record<NotificationChannel, ConversationCandidate[]>
>;

// -- Core builder -------------------------------------------------------------

/**
 * Build the conversation candidate set for all selected channels.
 *
 * Queries recent notification-sourced conversations that were delivered
 * to each channel and enriches them with guardian-specific metadata
 * when available.
 *
 * Errors are caught per-channel so a failure in one channel does not
 * block candidates for others.
 */
export async function buildConversationCandidates(
  channels: NotificationChannel[],
): Promise<ConversationCandidateSet> {
  const result: ConversationCandidateSet = {};
  const cutoff = Date.now() - CANDIDATE_RECENCY_WINDOW_MS;

  for (const channel of channels) {
    try {
      const candidates = await buildCandidatesForChannel(channel, cutoff);
      if (candidates.length > 0) {
        result[channel] = candidates;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        { err: errMsg, channel },
        "Failed to build conversation candidates for channel",
      );
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
async function buildCandidatesForChannel(
  channel: NotificationChannel,
  cutoffMs: number,
): Promise<ConversationCandidate[]> {
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
      eq(
        notificationDeliveries.notificationDecisionId,
        notificationDecisions.id,
      ),
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
        eq(notificationDeliveries.status, "sent"),
        isNotNull(notificationDeliveries.conversationId),
      ),
    )
    .orderBy(desc(notificationDeliveries.sentAt))
    .limit(MAX_CANDIDATES_PER_CHANNEL * 3) // over-fetch to allow deduplication
    .all();

  // Deduplicate by conversationId (keep the most recent delivery per conversation)
  const seen = new Set<string>();
  const candidates: ConversationCandidate[] = [];

  for (const row of rows) {
    if (!row.conversationId) continue;
    if (seen.has(row.conversationId)) continue;

    // Apply recency filter on the conversation's updatedAt
    if (row.convUpdatedAt < cutoffMs) continue;

    seen.add(row.conversationId);

    candidates.push({
      conversationId: row.conversationId,
      title: row.convTitle,
      updatedAt: row.convUpdatedAt,
      latestSourceEventName: row.sourceEventName ?? null,
      channel: channel,
    });

    if (candidates.length >= MAX_CANDIDATES_PER_CHANNEL) break;
  }

  // Enrich each candidate with its count of pending guardian requests. The
  // gateway owns the addressing convention and counts by conversation scope:
  // the request's source conversation plus any conversation its card was
  // delivered to (e.g. an access request whose synthetic source id differs
  // from the in-app card's destination conversation).
  //
  // Enrichment only: the degrading read logs a lookup failure and falls back
  // to an empty list, so an unreachable gateway degrades the candidate to
  // "no context" instead of discarding the channel's whole candidate set.
  for (const candidate of candidates) {
    const pendingCount = (
      await listPendingRequestsByScopeOrEmpty(
        candidate.conversationId,
        candidate.channel,
      )
    ).length;
    if (pendingCount > 0) {
      candidate.guardianContext = {
        pendingUnresolvedRequestCount: pendingCount,
      };
    }
  }

  return candidates;
}

// -- Prompt serialization -----------------------------------------------------

/**
 * Serialize a conversation candidate set into a compact text block suitable for
 * injection into the decision engine's user prompt.
 *
 * Designed to be token-efficient while giving the LLM enough context
 * to make a reuse decision.
 */
export function serializeCandidatesForPrompt(
  candidateSet: ConversationCandidateSet,
): string | null {
  const channelEntries = Object.entries(candidateSet) as [
    NotificationChannel,
    ConversationCandidate[],
  ][];
  if (channelEntries.length === 0) return null;

  const sections: string[] = [];

  for (const [channel, candidates] of channelEntries) {
    if (candidates.length === 0) continue;

    const lines: string[] = [`Channel: ${channel}`];
    for (const c of candidates) {
      // Escape title to prevent format corruption from quotes or newlines in
      // user/model-provided text. JSON.stringify produces a safe single-line
      // quoted string; we strip the outer quotes since we wrap in our own.
      const safeTitle = c.title
        ? JSON.stringify(c.title).slice(1, -1)
        : "(untitled)";
      const parts: string[] = [
        `  - id=${c.conversationId}`,
        `title="${safeTitle}"`,
        `updated=${new Date(c.updatedAt).toISOString()}`,
      ];
      if (c.latestSourceEventName) {
        const safeEventName = JSON.stringify(c.latestSourceEventName).slice(
          1,
          -1,
        );
        parts.push(`lastEvent="${safeEventName}"`);
      }
      if (c.guardianContext) {
        parts.push(
          `pendingRequests=${c.guardianContext.pendingUnresolvedRequestCount}`,
        );
      }
      lines.push(parts.join(" "));
    }
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) return null;
  return sections.join("\n\n");
}
