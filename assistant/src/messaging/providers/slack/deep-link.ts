export interface SlackMessageDeepLinks {
  appUrl?: string;
  webUrl?: string;
}

export function formatSlackPermalinkTimestamp(ts: string): string {
  return ts.replace(".", "");
}

export function buildSlackAppMessageUrl(params: {
  teamId?: string | null;
  channelId: string;
  messageTs: string;
}): string | undefined {
  const teamId = params.teamId?.trim();
  if (!teamId) return undefined;

  const search = new URLSearchParams({
    team: teamId,
    id: params.channelId,
    message: params.messageTs,
  });
  return `slack://channel?${search.toString()}`;
}

function normalizeSlackTeamUrl(teamUrl?: string | null): string | undefined {
  const trimmed = teamUrl?.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return undefined;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function buildArchivesMessageUrl(
  teamUrl: string,
  channelId: string,
  messageTs: string,
  threadTs?: string,
): string {
  const baseUrl = `${teamUrl}/archives/${encodeURIComponent(
    channelId,
  )}/p${formatSlackPermalinkTimestamp(messageTs)}`;
  if (!threadTs) return baseUrl;

  const search = new URLSearchParams({
    thread_ts: threadTs,
    cid: channelId,
  });
  return `${baseUrl}?${search.toString()}`;
}

export function buildSlackWebMessageUrl(params: {
  teamUrl?: string | null;
  channelId: string;
  messageTs: string;
  threadTs?: string;
}): string | undefined {
  const teamUrl = normalizeSlackTeamUrl(params.teamUrl);
  if (!teamUrl) return undefined;

  return buildArchivesMessageUrl(
    teamUrl,
    params.channelId,
    params.messageTs,
    params.threadTs,
  );
}

/**
 * Workspace-agnostic message permalink: `https://slack.com/archives/…`
 * resolves for any authenticated Slack viewer, so no per-workspace team URL
 * is needed. When `threadTs` marks an enclosing thread (and the message is
 * not itself the thread root), `thread_ts`/`cid` params make Slack open the
 * message inside its thread view instead of failing to locate a threaded
 * reply at the channel root.
 */
export function buildSlackPermalink(params: {
  channelId: string;
  messageTs: string;
  threadTs?: string;
}): string {
  const threadTs =
    params.threadTs !== params.messageTs ? params.threadTs : undefined;
  return buildArchivesMessageUrl(
    "https://slack.com",
    params.channelId,
    params.messageTs,
    threadTs,
  );
}

export function buildSlackWebChannelUrl(params: {
  teamUrl?: string | null;
  channelId: string;
}): string | undefined {
  const teamUrl = normalizeSlackTeamUrl(params.teamUrl);
  if (!teamUrl) return undefined;

  return `${teamUrl}/archives/${encodeURIComponent(params.channelId)}`;
}

export function buildSlackMessageDeepLinks(params: {
  teamId?: string | null;
  teamUrl?: string | null;
  channelId: string;
  messageTs: string;
  threadTs?: string;
}): SlackMessageDeepLinks | undefined {
  const appUrl = buildSlackAppMessageUrl(params);
  const webUrl = buildSlackWebMessageUrl(params);
  if (!appUrl && !webUrl) return undefined;
  return {
    ...(appUrl ? { appUrl } : {}),
    ...(webUrl ? { webUrl } : {}),
  };
}
