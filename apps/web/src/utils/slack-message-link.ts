export interface SlackMessageLink {
  appUrl?: string;
  webUrl?: string;
}

export function parseSlackMessageLink(
  raw: unknown,
): SlackMessageLink | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const record = raw as Record<string, unknown>;
  const link = {
    appUrl: typeof record.appUrl === "string" ? record.appUrl : undefined,
    webUrl: typeof record.webUrl === "string" ? record.webUrl : undefined,
  };

  return link.appUrl || link.webUrl ? link : undefined;
}

export function getSlackLinkUrl(
  link: SlackMessageLink | null | undefined,
): string | undefined {
  return link?.webUrl ?? link?.appUrl;
}
