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
 * stored under `linear`. The token only needs read access to notifications
 * and issues.
 */

import type { OAuthConnection } from "../../oauth/connection.js";
import { resolveOAuthConnection } from "../../oauth/connection-resolver.js";
import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import type {
  FetchResult,
  WatcherItem,
  WatcherProvider,
} from "../provider-types.js";

const log = getLogger("watcher:linear");

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

async function graphql<T>(
  connection: OAuthConnection,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const resp = await connection.request({
    method: "POST",
    path: "/graphql",
    body: { query, variables },
  });

  if (resp.status >= 400) {
    const body =
      typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body);
    throw new Error(`Linear API ${resp.status}: ${body}`);
  }

  const result = resp.body as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (result.errors?.length) {
    throw new Error(
      `Linear GraphQL errors: ${result.errors.map((e) => e.message).join(", ")}`,
    );
  }

  if (!result.data) {
    throw new Error("Linear API returned no data");
  }

  return result.data;
}

/** Fetch the authenticated user's ID and name. */
async function fetchViewer(connection: OAuthConnection): Promise<LinearViewer> {
  const data = await graphql<{ viewer: LinearViewer }>(
    connection,
    `
      query {
        viewer {
          id
          name
          email
        }
      }
    `,
  );
  return data.viewer;
}

/**
 * Fetch all notifications since a given ISO timestamp, paginating until
 * `pageInfo.hasNextPage` is false so we never miss events when 50+ arrive
 * between polls.
 */
async function fetchNotifications(
  connection: OAuthConnection,
  since: string,
): Promise<LinearNotification[]> {
  const allNodes: LinearNotification[] = [];
  let cursor: string | null = null;

  type NotificationsResponse = {
    notifications: {
      nodes: LinearNotification[];
      pageInfo: { hasNextPage: boolean; endCursor: string };
    };
  };

  do {
    const data: NotificationsResponse = await graphql<NotificationsResponse>(
      connection,
      `
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
      `,
      { after: since, cursor },
    );

    allNodes.push(...data.notifications.nodes);
    cursor = data.notifications.pageInfo.hasNextPage
      ? data.notifications.pageInfo.endCursor
      : null;
  } while (cursor != null);

  return allNodes;
}

/**
 * Fetch all assigned issues updated since the watermark, paginating until
 * `pageInfo.hasNextPage` is false so updates beyond the first 50 aren't skipped.
 */
async function fetchAssignedIssueUpdates(
  connection: OAuthConnection,
  viewerId: string,
  since: string,
): Promise<LinearIssue[]> {
  const allNodes: LinearIssue[] = [];
  let cursor: string | null = null;

  type IssuesResponse = {
    issues: {
      nodes: LinearIssue[];
      pageInfo: { hasNextPage: boolean; endCursor: string };
    };
  };

  do {
    const data: IssuesResponse = await graphql<IssuesResponse>(
      connection,
      `
        query FetchAssignedIssues(
          $assigneeId: ID
          $after: DateTime
          $cursor: String
        ) {
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
      `,
      { assigneeId: viewerId, after: since, cursor },
    );

    allNodes.push(...data.issues.nodes);
    cursor = data.issues.pageInfo.hasNextPage
      ? data.issues.pageInfo.endCursor
      : null;
  } while (cursor != null);

  return allNodes;
}

/**
 * Fetch all issue IDs currently assigned to the viewer. Unlike
 * `fetchAssignedIssueUpdates`, this has no `updatedAt` filter so it returns the
 * complete set — needed for accurate eviction and reassignment detection.
 */
async function fetchAllAssignedIssueIds(
  connection: OAuthConnection,
  viewerId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;

  type IdsResponse = {
    issues: {
      nodes: { id: string }[];
      pageInfo: { hasNextPage: boolean; endCursor: string };
    };
  };

  do {
    const data: IdsResponse = await graphql<IdsResponse>(
      connection,
      `
        query FetchAllAssignedIssueIds($assigneeId: ID, $cursor: String) {
          issues(
            filter: { assignee: { id: { eq: $assigneeId } } }
            first: 50
            after: $cursor
          ) {
            nodes {
              id
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      { assigneeId: viewerId, cursor },
    );

    for (const node of data.issues.nodes) {
      ids.add(node.id);
    }
    cursor = data.issues.pageInfo.hasNextPage
      ? data.issues.pageInfo.endCursor
      : null;
  } while (cursor != null);

  return ids;
}

// ── Issue state tracking ──────────────────────────────────────────────────────

/**
 * Tracks the last known state ID per issue, scoped by watcher instance key
 * (the watcher's DB UUID) so that multiple Linear watchers in the same process
 * — even when they share the same `credentialService` string — maintain
 * completely independent baselines.
 *
 * Keying by `credentialService` alone is insufficient: `runWatchersOnce` polls
 * watchers sequentially, so watcher-1 would write its post-poll state into the
 * shared map, and watcher-2 would then see already-updated IDs and silently
 * skip emitting valid transitions. Outer key: watcherKey; inner key: issue ID.
 *
 * In-memory only; resets on daemon restart, which is acceptable — the first
 * poll after restart will seed the map without emitting false-positive events.
 */
const knownIssueStateIdsByWatcher = new Map<string, Map<string, string>>();

/**
 * Tracks the complete set of assigned issue IDs from the previous poll so we
 * can detect reassignments. An issue that was previously unassigned and then
 * reassigned should not emit a false-positive status change even if its cached
 * state differs from its current state.
 */
const lastSeenAssignedIdsByWatcher = new Map<string, Set<string>>();

/** Get (or lazily create) the per-watcher state map. */
function getStateCache(watcherKey: string): Map<string, string> {
  let cache = knownIssueStateIdsByWatcher.get(watcherKey);
  if (!cache) {
    cache = new Map<string, string>();
    knownIssueStateIdsByWatcher.set(watcherKey, cache);
  }
  return cache;
}

/**
 * Evict the state cache for a watcher that has been deleted or permanently
 * disabled. Prevents unbounded growth of `knownIssueStateIdsByWatcher` in
 * environments that create and delete watchers frequently (watcher churn).
 */
function clearLinearStateCache(watcherKey: string): void {
  knownIssueStateIdsByWatcher.delete(watcherKey);
  lastSeenAssignedIdsByWatcher.delete(watcherKey);
}

// ── Event type mapping ────────────────────────────────────────────────────────

/**
 * Map a Linear notification type to a watcher event type.
 * Linear notification types include: issueAssignedToYou, issueMentionedYou,
 * issueCommentMentionedYou, issueStatusChanged, etc.
 */
function notificationTypeToEventType(type: string): string {
  if (type === "issueAssignedToYou") return "linear_issue_assigned";
  if (type === "issueMentionedYou") return "linear_mention";
  if (type === "issueCommentMentionedYou") return "linear_comment_mention";
  if (type === "issueStatusChanged") return "linear_status_changed";
  return "linear_notification";
}

function notificationToItem(n: LinearNotification): WatcherItem {
  const eventType = notificationTypeToEventType(n.type);
  const issue = n.issue;
  const teamName = issue?.team?.name ?? "Unknown Team";
  const issueRef = issue
    ? `${issue.identifier}: ${truncate(issue.title, 60)}`
    : "Unknown issue";

  const summary =
    eventType === "linear_comment_mention" && n.comment
      ? `Linear @mention in ${teamName} / ${issueRef}: ${truncate(
          n.comment.body,
          80,
        )}`
      : `Linear ${n.type
          .replace(/([A-Z])/g, " $1")
          .trim()} in ${teamName} / ${issueRef}`;

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

function issueToStatusChangeItem(
  issue: LinearIssue,
  previousStateId: string,
): WatcherItem {
  // Composite key encodes both the old and new state so re-polling the same
  // transition doesn't generate a duplicate event via the dedup layer.
  const externalId = `status_change:${issue.id}:${previousStateId}→${issue.state.id}`;
  const teamName = issue.team?.name ?? "Unknown Team";

  return {
    externalId,
    eventType: "linear_status_changed",
    summary: `Linear status → ${issue.state.name} in ${teamName} / ${
      issue.identifier
    }: ${truncate(issue.title, 60)}`,
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
  id: "linear",
  displayName: "Linear",
  requiredCredentialService: "linear",

  async getInitialWatermark(_credentialService: string): Promise<string> {
    // Start from "now" so we don't replay all existing notifications
    return new Date().toISOString();
  },

  cleanup(watcherKey: string): void {
    clearLinearStateCache(watcherKey);
  },

  async fetchNew(
    credentialService: string,
    watermark: string | null,
    _config: Record<string, unknown>,
    watcherKey: string,
  ): Promise<FetchResult> {
    const connection = await resolveOAuthConnection(credentialService);
    const since = watermark ?? new Date().toISOString();

    // Resolve the authenticated viewer's ID once per poll for the assigned-issues query
    const viewer = await fetchViewer(connection);

    // Fetch notifications (assignments, mentions, status changes via notification feed)
    const notifications = await fetchNotifications(connection, since);

    // Only surface notification types that warrant attention
    const relevantTypes = new Set([
      "issueAssignedToYou",
      "issueMentionedYou",
      "issueCommentMentionedYou",
      "issueStatusChanged",
    ]);

    const items: WatcherItem[] = [];

    for (const n of notifications) {
      if (!relevantTypes.has(n.type)) continue;
      items.push(notificationToItem(n));
    }

    // Fetch the complete set of currently assigned issue IDs (no updatedAt
    // filter) so we can accurately evict stale cache entries and guard against
    // false-positive status change events on reassignment.
    const currentAssignedIds = await fetchAllAssignedIssueIds(
      connection,
      viewer.id,
    );
    const previousAssignedIds = lastSeenAssignedIdsByWatcher.get(watcherKey);

    // Also poll assigned issues directly for status changes not covered by
    // notifications (e.g., bulk team updates). We only emit an event when the
    // state ID differs from what we recorded on the previous poll — any other
    // field update (title, description, etc.) does not constitute a status change.
    // On first sight of an issue we seed the map without emitting, so we don't
    // fire false-positive events after a daemon restart.
    const assignedIssues = await fetchAssignedIssueUpdates(
      connection,
      viewer.id,
      since,
    );
    const stateCache = getStateCache(watcherKey);
    for (const issue of assignedIssues) {
      const previousStateId = stateCache.get(issue.id);
      // Only emit a status change if: (1) we have a cached state that differs,
      // AND (2) the issue was also assigned in the previous poll. Condition (2)
      // prevents false-positive events when an issue is unassigned, changes
      // state while unassigned, and is then reassigned.
      const wasPreviouslySeen = previousAssignedIds?.has(issue.id) ?? false;
      if (
        previousStateId !== undefined &&
        previousStateId !== issue.state.id &&
        wasPreviouslySeen
      ) {
        items.push(issueToStatusChangeItem(issue, previousStateId));
      }
      stateCache.set(issue.id, issue.state.id);
    }

    // Evict cached state for issues that left the assigned set so stale
    // entries don't accumulate and don't cause false-positive events if the
    // issue is later reassigned.
    if (previousAssignedIds) {
      for (const id of previousAssignedIds) {
        if (!currentAssignedIds.has(id)) {
          stateCache.delete(id);
        }
      }
    }
    lastSeenAssignedIdsByWatcher.set(watcherKey, currentAssignedIds);

    const newWatermark = new Date().toISOString();
    log.info(
      { count: items.length, viewer: viewer.name, watermark: newWatermark },
      "Linear: fetched new notifications",
    );

    return { items, watermark: newWatermark };
  },
};
