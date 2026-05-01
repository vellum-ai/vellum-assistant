/**
 * Post-connection feed nudge.
 *
 * Emits a one-time nudge feed item when the user successfully connects
 * an email-capable OAuth provider. The nudge highlights ongoing email
 * management capabilities (inbox triage, daily digests) so the user
 * discovers what they can do beyond the initial setup.
 *
 * Uses a deterministic id (`connect-nudge:<service>`) so reconnecting
 * the same provider replaces the existing nudge in place rather than
 * appending a duplicate.
 */

import type { FeedItem } from "./feed-types.js";
import { appendFeedItem } from "./feed-writer.js";

/**
 * Services that should trigger an email management nudge on connection.
 * Only providers with real email integration are listed — see
 * `relationship-state-writer.ts` for the same "only Gmail is real" note.
 */
const EMAIL_SERVICES = new Set(["google"]);

/**
 * Emit a feed nudge for a newly connected email provider.
 *
 * No-ops silently when the service is not email-capable. Never throws —
 * the feed writer's warn-log contract absorbs persistence failures.
 */
export async function emitPostConnectNudge(service: string): Promise<void> {
  if (!EMAIL_SERVICES.has(service)) return;

  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const item: FeedItem = {
    id: `connect-nudge:${service}`,
    type: "nudge",
    priority: 70,
    title: "Gmail connected — want ongoing help?",
    summary:
      "I can triage your inbox, summarize new emails, or draft replies to important threads.",
    source: "gmail",
    timestamp: now.toISOString(),
    status: "new",
    expiresAt,
    author: "platform",
    createdAt: now.toISOString(),
    actions: [
      {
        id: "inbox-triage",
        label: "Triage my inbox",
        prompt:
          "Help me triage my inbox — summarize what's unread and flag anything that needs a reply",
      },
      {
        id: "daily-digest",
        label: "Set up daily digest",
        prompt:
          "Set up a daily email digest that summarizes my unread messages each morning",
      },
    ],
  };

  await appendFeedItem(item);
}
