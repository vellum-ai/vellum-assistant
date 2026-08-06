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
  if (!teamId) {
    return undefined;
  }

  const search = new URLSearchParams({
    team: teamId,
    id: params.channelId,
    message: params.messageTs,
  });
  return `slack://channel?${search.toString()}`;
}

function normalizeSlackTeamUrl(teamUrl?: string | null): string | undefined {
  const trimmed = teamUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") {
      return undefined;
    }
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
  if (!threadTs) {
    return baseUrl;
  }

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
  if (!teamUrl) {
    return undefined;
  }

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

/**
 * Web URL for a channel. Workspace-branded when the team URL is known,
 * otherwise the workspace-agnostic `https://slack.com/archives/…` form —
 * Slack resolves the channel id to the right workspace for any
 * authenticated viewer (the web client already synthesizes this exact
 * shape from message permalinks, see `getSlackChannelLinkFromMessageLink`
 * in `clients/web`).
 */
export function buildSlackWebChannelUrl(params: {
  teamUrl?: string | null;
  channelId: string;
}): string {
  const teamUrl = normalizeSlackTeamUrl(params.teamUrl) ?? "https://slack.com";
  return `${teamUrl}/archives/${encodeURIComponent(params.channelId)}`;
}

/**
 * Deep-link pair for a message. The web URL always exists: it is
 * workspace-branded when the team URL is configured and otherwise falls
 * back to the workspace-agnostic `buildSlackPermalink` form, so installs
 * that never learned their workspace identity (e.g. gateway-connected
 * Slack) still get working links. The `slack://` app URL still requires
 * a known team id.
 */
export function buildSlackMessageDeepLinks(params: {
  teamId?: string | null;
  teamUrl?: string | null;
  channelId: string;
  messageTs: string;
  threadTs?: string;
}): SlackMessageDeepLinks {
  const appUrl = buildSlackAppMessageUrl(params);
  const webUrl =
    buildSlackWebMessageUrl(params) ??
    buildSlackPermalink({
      channelId: params.channelId,
      messageTs: params.messageTs,
      ...(params.threadTs ? { threadTs: params.threadTs } : {}),
    });
  return {
    ...(appUrl ? { appUrl } : {}),
    webUrl,
  };
}
