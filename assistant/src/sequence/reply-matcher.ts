/**
 * Reply matcher — detects incoming messages that are replies to active
 * sequence enrollments and auto-exits them.
 *
 * Called from the watcher engine after new events are stored.
 * Matches by sender email against active enrollment contact_email
 * AND thread_id — both must match for a reply to trigger an exit.
 */

import { getLogger } from '../util/logger.js';
import { findActiveEnrollmentsByEmail, exitEnrollment, getSequence } from './store.js';
import { recordEvent } from './analytics.js';

const log = getLogger('sequence:reply-matcher');

interface WatcherEventPayload {
  id?: string;
  threadId?: string;
  from?: string;
  subject?: string;
  [key: string]: unknown;
}

/**
 * Extract a bare email address from a "Name <email>" or plain "email" string.
 */
function extractEmail(from: string): string | undefined {
  const match = from.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase();
  if (from.includes('@')) return from.trim().toLowerCase();
  return undefined;
}

export interface ReplyMatchResult {
  enrollmentId: string;
  contactEmail: string;
  sequenceId: string;
  sequenceName: string;
  threadId?: string;
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
    const senderEmail = extractEmail(payload.from ?? '');
    if (!senderEmail) continue;

    const enrollments = findActiveEnrollmentsByEmail(senderEmail);
    if (enrollments.length === 0) continue;

    for (const enrollment of enrollments) {
      const seq = getSequence(enrollment.sequenceId);
      if (!seq || !seq.exitOnReply) continue;

      // Only match when the enrollment has a thread ID and it matches the
      // incoming payload. Enrollments that haven't sent their first email
      // yet (threadId is null) are not eligible for reply-based exit —
      // otherwise any unrelated inbound email from the contact would
      // prematurely kill the enrollment.
      const threadMatch = enrollment.threadId != null
        && enrollment.threadId === payload.threadId;

      if (!threadMatch) continue;

      recordEvent(enrollment.sequenceId, enrollment.id, 'reply', enrollment.currentStep, {
        senderEmail,
        threadId: payload.threadId,
      });
      exitEnrollment(enrollment.id, 'replied');

      log.info(
        { enrollmentId: enrollment.id, senderEmail, threadId: payload.threadId },
        'Sequence enrollment exited on reply',
      );

      results.push({
        enrollmentId: enrollment.id,
        contactEmail: enrollment.contactEmail,
        sequenceId: enrollment.sequenceId,
        sequenceName: seq.name,
        threadId: payload.threadId,
      });
    }
  }

  return results;
}
