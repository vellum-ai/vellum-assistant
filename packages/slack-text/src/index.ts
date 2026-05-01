export interface RenderSlackTextOptions {
  userLabels?: Record<string, string>;
  channelLabels?: Record<string, string>;
  userFallbackLabel?: string;
  channelFallbackLabel?: string;
}

export interface BuildSlackUserLabelMapOptions {
  ignoredUserIds?: Iterable<string | undefined>;
}

const SLACK_USER_MENTION_RE = /<@([UW][A-Z0-9]+)>/g;
const LEADING_SLACK_USER_MENTION_RE = /^\s*<@[UW][A-Z0-9]+>\s*/;

export function extractSlackUserMentionIds(text: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const match of text.matchAll(SLACK_USER_MENTION_RE)) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

export function stripLeadingSlackUserMention(
  text: string,
  userId: string
): string {
  if (!isSlackUserId(userId)) {
    return text;
  }

  const mention = `<@${userId}>`;
  let stripped = text;

  while (true) {
    const next = stripLeadingExactToken(stripped, mention);
    if (next === stripped) {
      return stripped;
    }
    stripped = next;
  }
}

export function stripLeadingSlackMentionFallback(text: string): string {
  return text.replace(LEADING_SLACK_USER_MENTION_RE, "");
}

export function renderSlackTextForModel(
  text: string,
  options: RenderSlackTextOptions = {}
): string {
  return text.replace(/<([^<>\s][^<>]*)>/g, (token, content: string) => {
    if (content.startsWith("@")) {
      return renderUserMention(content, options);
    }

    if (content.startsWith("#")) {
      return renderChannelReference(content, options);
    }

    if (content.startsWith("!")) {
      return renderSpecialReference(content);
    }

    if (looksLikeUrl(content)) {
      return renderLink(content);
    }

    return token;
  });
}

export async function buildSlackUserLabelMap(
  texts: Iterable<string | undefined>,
  resolveLabel: (userId: string) => Promise<string | undefined | null>,
  options: BuildSlackUserLabelMapOptions = {}
): Promise<Record<string, string>> {
  const ignored = new Set(
    [...(options.ignoredUserIds ?? [])].filter(
      (id): id is string => typeof id === "string" && id.length > 0
    )
  );
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    if (!text) continue;
    for (const id of extractSlackUserMentionIds(text)) {
      if (ignored.has(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }

  if (ids.length === 0) return {};

  const entries = await Promise.all(
    ids.map(
      async (id): Promise<[string, string] | undefined> => {
        try {
          const label = await resolveLabel(id);
          const sanitized = sanitizeOptionalLabel(label ?? undefined);
          if (!sanitized || sanitized === id) return undefined;
          return [id, sanitized];
        } catch {
          return undefined;
        }
      }
    )
  );

  return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}

function renderUserMention(
  content: string,
  options: RenderSlackTextOptions
): string {
  const id = content.slice(1);
  if (!isSlackUserId(id)) {
    return `<${content}>`;
  }

  const fallback = sanitizeLabel(options.userFallbackLabel, "unknown-user");
  const label = sanitizeLabel(options.userLabels?.[id], fallback);
  if (label === id) {
    return `@${fallback}`;
  }
  return `@${label}`;
}

function renderChannelReference(
  content: string,
  options: RenderSlackTextOptions
): string {
  const [idWithPrefix, label] = splitSlackLabel(content);
  const channelId = idWithPrefix.slice(1);
  const fallback = sanitizeLabel(
    options.channelFallbackLabel,
    "unknown-channel"
  );
  const resolvedLabel = label ?? options.channelLabels?.[channelId];
  return `#${sanitizeLabel(resolvedLabel, fallback)}`;
}

function renderSpecialReference(content: string): string {
  if (
    content === "!here" ||
    content === "!channel" ||
    content === "!everyone"
  ) {
    return `@${content.slice(1)}`;
  }

  const subteam = /^!subteam\^[^|>]+(?:\|(.+))?$/.exec(content);
  if (subteam) {
    return `@${sanitizeLabel(subteam[1], "usergroup")}`;
  }

  return `<${content}>`;
}

function renderLink(content: string): string {
  const [url, label] = splitSlackLabel(content);
  if (!label) {
    return url;
  }

  return `${sanitizeLabel(label, url)} (${url})`;
}

function splitSlackLabel(content: string): [string, string | undefined] {
  const separatorIndex = content.indexOf("|");
  if (separatorIndex === -1) {
    return [content, undefined];
  }

  return [content.slice(0, separatorIndex), content.slice(separatorIndex + 1)];
}

function sanitizeLabel(label: string | undefined, fallback: string): string {
  const sanitized = label
    ?.replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[@#]+/, "")
    .trim();

  if (sanitized) {
    return sanitized;
  }

  const sanitizedFallback = fallback
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[@#]+/, "")
    .trim();

  return sanitizedFallback || "unknown";
}

function sanitizeOptionalLabel(label: string | undefined): string | undefined {
  return label
    ?.replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[@#]+/, "")
    .trim();
}

function stripLeadingExactToken(text: string, token: string): string {
  const leadingWhitespaceLength = text.length - text.trimStart().length;
  const afterWhitespace = text.slice(leadingWhitespaceLength);

  if (!afterWhitespace.startsWith(token)) {
    return text;
  }

  return afterWhitespace.slice(token.length).trimStart();
}

function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]+$/.test(value);
}

function looksLikeUrl(content: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(splitSlackLabel(content)[0]);
}
