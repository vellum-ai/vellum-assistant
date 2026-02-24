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
      // Linear accepts both personal API keys and OAuth tokens; the Bearer scheme
      // is required for all token types per Linear's API docs.
      'Authorization': `Bearer ${token}`,
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

/**
 * Fetch all notifications since a given ISO timestamp, paginating until
 * `pageInfo.hasNextPage` is false so we never miss events when 50+ arrive
 * between polls.
 */
async function fetchNotifications(
  token: string,
  since: string,
): Promise<LinearNotification[]> {
  const allNodes: LinearNotification[] = [];
  let cursor: string | null = null;

  type NotificationsResponse = {
    notifications: { nodes: LinearNotification[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
  };

  do {
    const data: NotificationsResponse = await graphql<NotificationsResponse>(token, `
      query FetchNotifications($after: DateTime, $cursor: String) {
        notifications(
          filter: { updatedAt: { gte: $after } }
          orderBy: updatedAt
          first: 50
          after: $cursor
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
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `, { after: since, cursor });

    allNodes.push(...data.notifications.nodes);
    cursor = data.notifications.pageInfo.hasNextPage ? data.notifications.pageInfo.endCursor : null;
  } while (cursor !== null);

  return allNodes;
}

/**
 * Fetch all assigned issues updated since the watermark, paginating until
 * `pageInfo.hasNextPage` is false so updates beyond the first 50 aren't skipped.
 */
async function fetchAssignedIssueUpdates(
  token: string,
  viewerId: string,
  since: string,
): Promise<LinearIssue[]> {
  const allNodes: LinearIssue[] = [];
  let cursor: string | null = null;

  type IssuesResponse = {
    issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
  };

  do {
    const data: IssuesResponse = await graphql<IssuesResponse>(token, `
      query FetchAssignedIssues($assigneeId: ID, $after: DateTime, $cursor: String) {
        issues(
          filter: {
            assignee: { id: { eq: $assigneeId } }
            updatedAt: { gte: $after }
          }
          orderBy: updatedAt
          first: 50
          after: $cursor
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
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `, { assigneeId: viewerId, after: since, cursor });

    allNodes.push(...data.issues.nodes);
    cursor = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
  } while (cursor !== null);

  return allNodes;
}

// ── Issue state tracking ──────────────────────────────────────────────────────

/**
 * Tracks the last known state ID per issue (keyed by issue ID).
 * Populated on every poll so we can detect transitions across consecutive polls.
 * In-memory only; resets on daemon restart, which is acceptable — the first
 * poll after restart will seed the map without emitting false-positive events.
 */
const knownIssueStateIds = new Map<string, string>();

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

function issueToStatusChangeItem(issue: LinearIssue, previousStateId: string): WatcherItem {
  // Composite key encodes both the old and new state so re-polling the same
  // transition doesn't generate a duplicate event via the dedup layer.
  const externalId = `status_change:${issue.id}:${previousStateId}→${issue.state.id}`;
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

      // Also poll assigned issues directly for status changes not covered by
      // notifications (e.g., bulk team updates). We only emit an event when the
      // state ID differs from what we recorded on the previous poll — any other
      // field update (title, description, etc.) does not constitute a status change.
      // On first sight of an issue we seed the map without emitting, so we don't
      // fire false-positive events after a daemon restart.
      const assignedIssues = await fetchAssignedIssueUpdates(token, viewer.id, since);
      for (const issue of assignedIssues) {
        const previousStateId = knownIssueStateIds.get(issue.id);
        if (previousStateId !== undefined && previousStateId !== issue.state.id) {
          items.push(issueToStatusChangeItem(issue, previousStateId));
        }
        // Always update the map so the next poll has an accurate baseline.
        knownIssueStateIds.set(issue.id, issue.state.id);
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
