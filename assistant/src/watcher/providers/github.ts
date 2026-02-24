/**
 * GitHub watcher provider — polls for new PRs, issues, and review requests.
 *
 * Uses the GitHub Notifications API (`GET /notifications`) with a timestamp
 * watermark. On first poll, captures the current time as the watermark so we
 * start from "now" and don't replay historical notifications.
 *
 * The credential service expects a GitHub Personal Access Token (or fine-grained
 * token) stored under `integration:github`. The token needs at minimum the
 * `notifications` scope (classic) or Notification read permission (fine-grained).
 */

import { withValidToken } from '../../security/token-manager.js';
import { truncate } from '../../util/truncate.js';
import type { WatcherProvider, WatcherItem, FetchResult } from '../provider-types.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('watcher:github');

const GITHUB_API_BASE = 'https://api.github.com';

// ── API types ──────────────────────────────────────────────────────────────────

interface GitHubNotification {
  id: string;
  reason: string; // 'assign', 'author', 'comment', 'mention', 'review_requested', 'subscribed', etc.
  unread: boolean;
  updated_at: string;
  subject: {
    title: string;
    url: string | null;
    latest_comment_url: string | null;
    type: 'Issue' | 'PullRequest' | 'Release' | 'Commit' | string;
  };
  repository: {
    full_name: string;
    html_url: string;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Map a GitHub notification reason to a watcher event type. */
function reasonToEventType(reason: string, subjectType: string): string {
  if (reason === 'review_requested') return 'github_review_requested';
  if (reason === 'assign') return subjectType === 'Issue' ? 'github_issue_assigned' : 'github_pr_assigned';
  if (reason === 'mention') return 'github_mention';
  if (subjectType === 'PullRequest') return 'github_pr_activity';
  return 'github_notification';
}

function notificationToItem(n: GitHubNotification): WatcherItem {
  const eventType = reasonToEventType(n.reason, n.subject.type);
  const repoName = n.repository.full_name;
  const title = n.subject.title;
  const subjectType = n.subject.type;

  return {
    externalId: n.id,
    eventType,
    summary: `GitHub ${subjectType} in ${repoName}: ${truncate(title, 80)}`,
    payload: {
      id: n.id,
      reason: n.reason,
      subjectType: n.subject.type,
      title,
      subjectUrl: n.subject.url,
      repoFullName: repoName,
      repoHtmlUrl: n.repository.html_url,
      updatedAt: n.updated_at,
    },
    timestamp: new Date(n.updated_at).getTime(),
  };
}

/** Fetch a single page of notifications since a timestamp. */
async function fetchNotificationsPage(
  token: string,
  since: string,
  page: number,
): Promise<{ items: GitHubNotification[]; hasMore: boolean }> {
  const params = new URLSearchParams({
    all: 'false', // only unread
    since,
    per_page: '50',
    page: String(page),
  });

  const resp = await fetch(`${GITHUB_API_BASE}/notifications?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`GitHub Notifications API ${resp.status}: ${body}`);
  }

  const items = (await resp.json()) as GitHubNotification[];
  // GitHub returns 50 per page; if we got a full page there may be more
  const hasMore = items.length === 50;
  return { items, hasMore };
}

// ── Provider ───────────────────────────────────────────────────────────────────

export const githubProvider: WatcherProvider = {
  id: 'github',
  displayName: 'GitHub',
  requiredCredentialService: 'integration:github',

  async getInitialWatermark(_credentialService: string): Promise<string> {
    // Start from "now" so we don't replay all existing notifications
    return new Date().toISOString();
  },

  async fetchNew(
    credentialService: string,
    watermark: string | null,
    _config: Record<string, unknown>,
  ): Promise<FetchResult> {
    return withValidToken(credentialService, async (token) => {
      const since = watermark ?? new Date().toISOString();
      const items: WatcherItem[] = [];
      let page = 1;

      while (true) {
        const { items: pageItems, hasMore } = await fetchNotificationsPage(token, since, page);

        for (const n of pageItems) {
          // Only surface notifications for reasons that warrant attention
          const relevantReasons = new Set([
            'assign', 'mention', 'review_requested', 'team_mention',
          ]);
          if (!relevantReasons.has(n.reason)) continue;

          items.push(notificationToItem(n));
        }

        if (!hasMore) break;
        page++;
      }

      // New watermark: the time just before we fetched so we don't miss events
      // that arrive between poll cycles.
      const newWatermark = new Date().toISOString();

      log.info({ count: items.length, watermark: newWatermark }, 'GitHub: fetched new notifications');
      return { items, watermark: newWatermark };
    });
  },
};
