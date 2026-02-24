/**
 * Linear watcher provider — polls for assigned issues, status changes, and @mentions.
 *
 * Uses the Linear GraphQL API with a timestamp watermark. On first poll, captures
 * the current time as the watermark so we start from "now" and don't replay history.
 *
 * The watermark is an ISO 8601 timestamp string used in the `updatedAt_gte` filter.
 * We query notifications (which cover assignments and mentions) and issue status changes
 * for issues assigned to the authenticated user.
 *
 * The credential service expects a Linear API key (personal or OAuth access token)
 * stored under `integration:linear`. The token only needs read access to notifications
 * and issues.
 */

import { withValidToken } from '../../security/token-manager.js';
import { truncate } from '../../util/truncate.js';
import type { WatcherProvider, WatcherItem, FetchResult } from '../provider-types.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('watcher:linear');

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

// ── GraphQL response types ────────────────────────────────────────────────────

interface LinearNotification {
  id: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  issue?: {
    id: string;
    identifier: string;
    title: string;
    url: string;
    state?: {
      id: string;
      name: string;
      type: string;
    };
    assignee?: {
      id: string;
      name: string;
      email: string;
    };
    team?: {
      id: string;
      name: string;
    };
  };
  comment?: {
    id: string;
    body: string;
  };
}

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  updatedAt: string;
  state: {
    id: string;
    name: string;
    type: string;
  };
  team: {
    id: string;
    name: string;
  };
  assignee?: {
    id: string;
    name: string;
  };
}

interface LinearViewer {
  id: string;
  name: string;
  email: string;
}

// ── GraphQL helpers ───────────────────────────────────────────────────────────

async function graphql<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const resp = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Linear API ${resp.status}: ${body}`);
  }

  const result = await resp.json() as { data?: T; errors?: Array<{ message: string }> };

  if (result.errors?.length) {
    throw new Error(`Linear GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`);
  }

  if (!result.data) {
    throw new Error('Linear API returned no data');
  }

  return result.data;
}

/** Fetch the authenticated user's ID and name. */
async function fetchViewer(token: string): Promise<LinearViewer> {
  const data = await graphql<{ viewer: LinearViewer }>(token, `
    query {
      viewer {
        id
        name
        email
      }
    }
  `);
  return data.viewer;
}

/** Fetch notifications since a given ISO timestamp. */
async function fetchNotifications(
  token: string,
  since: string,
): Promise<LinearNotification[]> {
  const data = await graphql<{ notifications: { nodes: LinearNotification[] } }>(token, `
    query FetchNotifications($after: DateTime) {
      notifications(
        filter: { updatedAt: { gte: $after } }
        orderBy: updatedAt
        first: 50
      ) {
        nodes {
          id
          type
          createdAt
          updatedAt
          ... on IssueNotification {
            issue {
              id
              identifier
              title
              url
              state {
                id
                name
                type
              }
              assignee {
                id
                name
                email
              }
              team {
                id
                name
              }
            }
          }
          ... on IssueCommentMentionNotification {
            issue {
              id
              identifier
              title
              url
              team {
                id
                name
              }
            }
            comment {
              id
              body
            }
          }
        }
      }
    }
  `, { after: since });
  return data.notifications.nodes;
}

/**
 * Fetch issues assigned to the viewer that had status changes since the watermark.
 * We fetch assigned issues updated recently and emit events for state changes.
 */
async function fetchAssignedIssueUpdates(
  token: string,
  viewerId: string,
  since: string,
): Promise<LinearIssue[]> {
  const data = await graphql<{ issues: { nodes: LinearIssue[] } }>(token, `
    query FetchAssignedIssues($assigneeId: ID, $after: DateTime) {
      issues(
        filter: {
          assignee: { id: { eq: $assigneeId } }
          updatedAt: { gte: $after }
        }
        orderBy: updatedAt
        first: 50
      ) {
        nodes {
          id
          identifier
          title
          url
          updatedAt
          state {
            id
            name
            type
          }
          team {
            id
            name
          }
          assignee {
            id
            name
          }
        }
      }
    }
  `, { assigneeId: viewerId, after: since });
  return data.issues.nodes;
}

// ── Event type mapping ────────────────────────────────────────────────────────

/**
 * Map a Linear notification type to a watcher event type.
 * Linear notification types include: issueAssignedToYou, issueMentionedYou,
 * issueCommentMentionedYou, issueStatusChanged, etc.
 */
function notificationTypeToEventType(type: string): string {
  if (type === 'issueAssignedToYou') return 'linear_issue_assigned';
  if (type === 'issueMentionedYou') return 'linear_mention';
  if (type === 'issueCommentMentionedYou') return 'linear_comment_mention';
  if (type === 'issueStatusChanged') return 'linear_status_changed';
  return 'linear_notification';
}

function notificationToItem(n: LinearNotification): WatcherItem {
  const eventType = notificationTypeToEventType(n.type);
  const issue = n.issue;
  const teamName = issue?.team?.name ?? 'Unknown Team';
  const issueRef = issue ? `${issue.identifier}: ${truncate(issue.title, 60)}` : 'Unknown issue';

  const summary = eventType === 'linear_comment_mention' && n.comment
    ? `Linear @mention in ${teamName} / ${issueRef}: ${truncate(n.comment.body, 80)}`
    : `Linear ${n.type.replace(/([A-Z])/g, ' $1').trim()} in ${teamName} / ${issueRef}`;

  return {
    externalId: n.id,
    eventType,
    summary,
    payload: {
      notificationId: n.id,
      type: n.type,
      issueId: issue?.id,
      issueIdentifier: issue?.identifier,
      issueTitle: issue?.title,
      issueUrl: issue?.url,
      issueStateName: issue?.state?.name,
      issueStateType: issue?.state?.type,
      teamName,
      commentBody: n.comment?.body,
      updatedAt: n.updatedAt,
    },
    timestamp: new Date(n.updatedAt).getTime(),
  };
}

function issueToStatusChangeItem(issue: LinearIssue): WatcherItem {
  // Use a composite key so each distinct status seen for an issue is a unique event.
  // This prevents duplicate events across polls when the issue stays in the same state.
  const externalId = `status_change:${issue.id}:${issue.state.id}`;
  const teamName = issue.team?.name ?? 'Unknown Team';

  return {
    externalId,
    eventType: 'linear_status_changed',
    summary: `Linear status → ${issue.state.name} in ${teamName} / ${issue.identifier}: ${truncate(issue.title, 60)}`,
    payload: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueUrl: issue.url,
      stateName: issue.state.name,
      stateType: issue.state.type,
      teamName,
      updatedAt: issue.updatedAt,
    },
    timestamp: new Date(issue.updatedAt).getTime(),
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export const linearProvider: WatcherProvider = {
  id: 'linear',
  displayName: 'Linear',
  requiredCredentialService: 'integration:linear',

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

      // Resolve the authenticated viewer's ID once per poll for the assigned-issues query
      const viewer = await fetchViewer(token);

      // Fetch notifications (assignments, mentions, status changes via notification feed)
      const notifications = await fetchNotifications(token, since);

      // Only surface notification types that warrant attention
      const relevantTypes = new Set([
        'issueAssignedToYou',
        'issueMentionedYou',
        'issueCommentMentionedYou',
        'issueStatusChanged',
      ]);

      const items: WatcherItem[] = [];

      for (const n of notifications) {
        if (!relevantTypes.has(n.type)) continue;
        items.push(notificationToItem(n));
      }

      // Also poll assigned issues directly for status changes not reflected in
      // notifications (e.g., bulk team updates), avoiding duplicate notification events
      // by using a distinct externalId schema (status_change:<issueId>:<stateId>).
      const assignedIssues = await fetchAssignedIssueUpdates(token, viewer.id, since);
      for (const issue of assignedIssues) {
        items.push(issueToStatusChangeItem(issue));
      }

      const newWatermark = new Date().toISOString();
      log.info(
        { count: items.length, viewer: viewer.name, watermark: newWatermark },
        'Linear: fetched new notifications',
      );

      return { items, watermark: newWatermark };
    });
  },
};
