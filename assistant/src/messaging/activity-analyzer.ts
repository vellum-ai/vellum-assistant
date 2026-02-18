/**
 * Activity classifier for messaging conversations.
 *
 * Takes Conversation[] from any provider and groups them by activity level.
 * Works for Slack channels, Gmail senders, Discord servers — anything
 * that maps to the Conversation type.
 */

import type { Conversation } from './provider-types.js';

export type ActivityLevel = 'dead' | 'low' | 'medium' | 'high';

export interface ActivityGroup {
  level: ActivityLevel;
  conversations: Conversation[];
}

export interface ActivitySummary {
  platform: string;
  totalConversations: number;
  groups: ActivityGroup[];
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Classify conversations by activity level based on last activity timestamp
 * and unread count. Returns sorted groups from high to dead.
 */
export function classifyActivity(
  conversations: Conversation[],
  platform: string,
  now = Date.now(),
): ActivitySummary {
  const groups: Record<ActivityLevel, Conversation[]> = {
    high: [],
    medium: [],
    low: [],
    dead: [],
  };

  for (const conv of conversations) {
    const ageDays = (now - conv.lastActivityAt) / ONE_DAY_MS;

    let level: ActivityLevel;
    if (conv.unreadCount > 0 && ageDays < 1) {
      level = 'high';
    } else if (ageDays < 7) {
      level = 'medium';
    } else if (ageDays < 30) {
      level = 'low';
    } else {
      level = 'dead';
    }

    groups[level].push(conv);
  }

  // Sort each group by lastActivityAt descending
  for (const level of Object.keys(groups) as ActivityLevel[]) {
    groups[level].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  const result: ActivityGroup[] = [];
  for (const level of ['high', 'medium', 'low', 'dead'] as ActivityLevel[]) {
    if (groups[level].length > 0) {
      result.push({ level, conversations: groups[level] });
    }
  }

  return {
    platform,
    totalConversations: conversations.length,
    groups: result,
  };
}
