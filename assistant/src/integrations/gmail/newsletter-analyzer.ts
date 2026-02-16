/**
 * Newsletter detection and grouping helper.
 *
 * NOT a tool — this is a utility function used by the LLM-driven
 * declutter flow to group messages by sender for the table surface.
 */

import type { GmailMessage, GmailHeader } from './types.js';

export interface NewsletterGroup {
  senderEmail: string;
  senderName: string;
  messageCount: number;
  hasUnsubscribe: boolean;
  messageIds: string[];
  sampleSubjects: string[];
}

function getHeader(headers: GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function parseSender(from: string): { name: string; email: string } {
  // "Display Name <email@example.com>" or just "email@example.com"
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].replace(/^["']|["']$/g, '').trim(), email: match[2].toLowerCase() };
  }
  return { name: from.trim(), email: from.trim().toLowerCase() };
}

/**
 * Group a list of Gmail messages by sender for newsletter analysis.
 *
 * Expects messages fetched with `format=metadata` and
 * `metadataHeaders=["From", "Subject", "List-Unsubscribe"]`.
 *
 * Returns groups sorted by message count (descending), filtered to
 * senders with at least `minMessages` messages.
 */
export function groupBySender(
  messages: GmailMessage[],
  minMessages = 3,
  maxSampleSubjects = 3,
): NewsletterGroup[] {
  const groups = new Map<string, {
    senderName: string;
    senderEmail: string;
    messageIds: string[];
    subjects: string[];
    hasUnsubscribe: boolean;
  }>();

  for (const msg of messages) {
    const headers = msg.payload?.headers;
    const from = getHeader(headers, 'From');
    if (!from) continue;

    const { name, email } = parseSender(from);
    const existing = groups.get(email);
    const subject = getHeader(headers, 'Subject') ?? '';
    const hasUnsub = !!getHeader(headers, 'List-Unsubscribe');

    if (existing) {
      existing.messageIds.push(msg.id);
      existing.subjects.push(subject);
      if (hasUnsub) existing.hasUnsubscribe = true;
    } else {
      groups.set(email, {
        senderName: name,
        senderEmail: email,
        messageIds: [msg.id],
        subjects: [subject],
        hasUnsubscribe: hasUnsub,
      });
    }
  }

  return [...groups.values()]
    .filter((g) => g.messageIds.length >= minMessages)
    .sort((a, b) => b.messageIds.length - a.messageIds.length)
    .map((g) => ({
      senderEmail: g.senderEmail,
      senderName: g.senderName,
      messageCount: g.messageIds.length,
      hasUnsubscribe: g.hasUnsubscribe,
      messageIds: g.messageIds,
      sampleSubjects: g.subjects.slice(0, maxSampleSubjects),
    }));
}
