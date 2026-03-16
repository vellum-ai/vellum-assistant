/**
 * Reply matcher — detects incoming messages that are replies to active
 * sequence enrollments and auto-exits them.
 *
 * Called from the watcher engine after new events are stored.
 * Matches by sender email against active enrollment contact_email
 * AND conversationId — both must match for a reply to trigger an exit.
 */

import { getLogger } from "../util/logger.js";
import { recordEvent } from "./analytics.js";
import {
  exitEnrollment,
  findActiveEnrollmentsByEmail,
  getSequence,
} from "./store.js";

const log = getLogger("sequence:reply-matcher");

interface WatcherEventPayload {
  id?: string;
  threadId?: string;
  from?: string;
  subject?: string;
  [key: string]: unknown;
}

/**
 * Extract a bare email address from a "Name <email>" or plain "email" string.
 * Handles RFC 5322 addresses where display names or trailing comments may
 * contain angle brackets (e.g., `"Acme <support@acme.com>" <owner@example.com>`).
 * Picks the last `@`-containing segment so display-name fragments don't shadow
 * the actual mailbox. Strips parenthetical comments in the fallback path.
 */
export function extractEmail(from: string): string | undefined {
  // Strip parenthetical comments first to avoid matching addresses inside them
  const cleaned = from.replace(/\(.*?\)/g, "");
  const segments = [...cleaned.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  if (segments.length > 0) {
    const emailSegment = [...segments].reverse().find((s) => s.includes("@"));
    if (emailSegment) return emailSegment.trim().toLowerCase();
  }
  const stripped = from
    .replace(/<[^>]+>/g, "")
    .replace(/\(.*?\)/g, "")
    .trim()
    .toLowerCase();
  if (stripped.includes("@")) return stripped;
  return undefined;
}

export interface ReplyMatchResult {
  enrollmentId: string;
  contactEmail: string;
  sequenceId: string;
  sequenceName: string;
  conversationId?: string;
}

/**
 * Check a batch of watcher event payloads for replies to active
 * sequence enrollments. Returns matched enrollments that were exited.
 */
export function checkForSequenceReplies(
  payloads: WatcherEventPayload[],
): ReplyMatchResult[] {
  const results: ReplyMatchResult[] = [];

  for (const payload of payloads) {
    const senderEmail = extractEmail(payload.from ?? "");
    if (!senderEmail) continue;

    const enrollments = findActiveEnrollmentsByEmail(senderEmail);
    if (enrollments.length === 0) continue;

    for (const enrollment of enrollments) {
      const seq = getSequence(enrollment.sequenceId);
      if (!seq || !seq.exitOnReply) continue;

      // Only match when the enrollment has a conversation ID and it matches
      // the incoming payload's thread ID. Enrollments that haven't sent their
      // first email yet (conversationId is null) are not eligible for
      // reply-based exit — otherwise any unrelated inbound email from the
      // contact would prematurely kill the enrollment.
      // Note: payload.threadId is the external provider's thread identifier
      // (e.g. Gmail API thread ID) which maps to enrollment.conversationId.
      const conversationMatch =
        enrollment.conversationId != null &&
        enrollment.conversationId === payload.threadId;

      if (!conversationMatch) continue;

      recordEvent(
        enrollment.sequenceId,
        enrollment.id,
        "reply",
        enrollment.currentStep,
        {
          senderEmail,
          conversationId: payload.threadId,
        },
      );
      exitEnrollment(enrollment.id, "replied");

      log.info(
        {
          enrollmentId: enrollment.id,
          senderEmail,
          conversationId: payload.threadId,
        },
        "Sequence enrollment exited on reply",
      );

      results.push({
        enrollmentId: enrollment.id,
        contactEmail: enrollment.contactEmail,
        sequenceId: enrollment.sequenceId,
        sequenceName: seq.name,
        conversationId: payload.threadId,
      });
    }
  }

  return results;
}
