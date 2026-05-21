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

export function buildSlackWebMessageUrl(params: {
  teamUrl?: string | null;
  channelId: string;
  messageTs: string;
  threadTs?: string;
}): string | undefined {
  const teamUrl = normalizeSlackTeamUrl(params.teamUrl);
  if (!teamUrl) return undefined;

  const baseUrl = `${teamUrl}/archives/${encodeURIComponent(
    params.channelId,
  )}/p${formatSlackPermalinkTimestamp(params.messageTs)}`;
  if (!params.threadTs) return baseUrl;

  const search = new URLSearchParams({
    thread_ts: params.threadTs,
    cid: params.channelId,
  });
  return `${baseUrl}?${search.toString()}`;
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
