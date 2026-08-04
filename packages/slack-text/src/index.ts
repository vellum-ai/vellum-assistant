export interface RenderSlackTextOptions {
  userLabels?: Record<string, string>;
  channelLabels?: Record<string, string>;
  userFallbackLabel?: string;
  channelFallbackLabel?: string;
}

const SLACK_USER_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const SLACK_CHANNEL_REFERENCE_RE = /<#([CDG][A-Z0-9]+)(?:\|[^>]*)?>/g;

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

export function extractSlackChannelReferenceIds(text: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const match of text.matchAll(SLACK_CHANNEL_REFERENCE_RE)) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

export function renderSlackTextForModel(
  text: string,
  options: RenderSlackTextOptions = {},
): string {
  // Decode entities per Slack-sourced segment, never on the combined output:
  // caller-resolved labels (display names, channel names) must pass through
  // verbatim, so a label containing literal entity text is preserved and an
  // encoded bracket in a display name cannot decode into `<`/`>` after
  // sanitizeLabel() has already stripped raw brackets.
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(/<([^<>\s][^<>]*)>/g)) {
    result += decodeSlackHtmlEntities(text.slice(cursor, match.index));
    result += renderSlackToken(match[0], match[1] as string, options);
    cursor = match.index + match[0].length;
  }
  result += decodeSlackHtmlEntities(text.slice(cursor));
  return result;
}

function renderSlackToken(
  token: string,
  content: string,
  options: RenderSlackTextOptions,
): string {
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
}

/**
 * Slack entity-encodes every literal `&`, `<`, and `>` in message text so its
 * own `<...>` control tokens stay unambiguous. Decode them back on the
 * Slack-sourced segments — leaving them encoded breaks downstream markdown
 * (`&gt; quote` at line start never forms a blockquote, since entities resolve
 * only after block parsing) and shows raw entities to the model. `&lt;`/`&gt;`
 * are decoded before `&amp;` so a user-typed literal `&gt;` (double-encoded by
 * Slack as `&amp;gt;`) round-trips to `&gt;`, not `>`.
 */
function decodeSlackHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export async function buildSlackUserLabelMap(
  texts: Iterable<string | undefined>,
  resolveLabel: (userId: string) => Promise<string | undefined | null>,
): Promise<Record<string, string>> {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(SLACK_USER_MENTION_RE)) {
      const id = match[1];
      // A pipe-form mention carrying a usable embedded label renders from
      // that label directly; only queue a lookup when the label is missing,
      // empty, or ID-shaped. Mirrors the channel builder below.
      const [, embeddedLabel] = splitSlackLabel(match[0].slice(1, -1));
      const sanitizedEmbeddedLabel = sanitizeOptionalLabel(embeddedLabel);
      if (sanitizedEmbeddedLabel && sanitizedEmbeddedLabel !== id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }

  if (ids.length === 0) return {};

  const entries = await Promise.all(
    ids.map(async (id): Promise<[string, string] | undefined> => {
      try {
        const label = await resolveLabel(id);
        const sanitized = sanitizeOptionalLabel(label ?? undefined);
        if (!sanitized || sanitized === id) return undefined;
        return [id, sanitized];
      } catch {
        return undefined;
      }
    }),
  );

  return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}

export async function buildSlackChannelLabelMap(
  texts: Iterable<string | undefined>,
  resolveLabel: (channelId: string) => Promise<string | undefined | null>,
): Promise<Record<string, string>> {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(SLACK_CHANNEL_REFERENCE_RE)) {
      const id = match[1];
      const [, embeddedLabel] = splitSlackLabel(match[0].slice(1, -1));
      const sanitizedEmbeddedLabel = sanitizeOptionalLabel(embeddedLabel);
      if (sanitizedEmbeddedLabel && sanitizedEmbeddedLabel !== id) continue;
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }

  if (ids.length === 0) return {};

  const entries = await Promise.all(
    ids.map(async (id): Promise<[string, string] | undefined> => {
      try {
        const label = await resolveLabel(id);
        const sanitized = sanitizeOptionalLabel(label ?? undefined);
        if (!sanitized || sanitized === id) return undefined;
        return [id, sanitized];
      } catch {
        return undefined;
      }
    }),
  );

  return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}

function renderUserMention(
  content: string,
  options: RenderSlackTextOptions,
): string {
  const [idWithPrefix, label] = splitSlackLabel(content);
  const id = idWithPrefix.slice(1);
  if (!isSlackUserId(id)) {
    return `<${content}>`;
  }

  // Slack's legacy pipe form (`<@U123|username>`) carries its own label:
  // prefer it over a lookup, mirroring renderChannelReference. The embedded
  // label is Slack-sourced (part of the token), so entities decode before
  // sanitization; the caller-resolved label below is not.
  const embeddedLabel = sanitizeOptionalLabel(
    label === undefined ? undefined : decodeSlackHtmlEntities(label),
  );
  if (embeddedLabel && embeddedLabel !== id) {
    return `@${embeddedLabel}`;
  }

  const fallback = sanitizeLabel(options.userFallbackLabel, "unknown-user");
  const resolvedLabel = sanitizeLabel(options.userLabels?.[id], fallback);
  if (resolvedLabel === id) {
    return `@${fallback}`;
  }
  return `@${resolvedLabel}`;
}

function renderChannelReference(
  content: string,
  options: RenderSlackTextOptions,
): string {
  const [idWithPrefix, label] = splitSlackLabel(content);
  const channelId = idWithPrefix.slice(1);
  const fallback = sanitizeLabel(
    options.channelFallbackLabel,
    "unknown-channel",
  );
  // The embedded label is Slack-sourced (part of the token), so entities
  // decode before sanitization; the caller-resolved label below is not.
  const embeddedLabel = sanitizeOptionalLabel(
    label === undefined ? undefined : decodeSlackHtmlEntities(label),
  );
  if (embeddedLabel && embeddedLabel !== channelId) {
    return `#${embeddedLabel}`;
  }

  const resolvedLabel = sanitizeOptionalLabel(
    options.channelLabels?.[channelId],
  );
  if (resolvedLabel && resolvedLabel !== channelId) {
    return `#${resolvedLabel}`;
  }

  return `#${fallback}`;
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
    const embedded = subteam[1];
    return `@${sanitizeLabel(
      embedded === undefined ? undefined : decodeSlackHtmlEntities(embedded),
      "usergroup",
    )}`;
  }

  return `<${content}>`;
}

function renderLink(content: string): string {
  // Both halves of a link token are Slack-sourced, so entities decode here
  // (e.g. `&amp;` in URL query strings); sanitizeLabel runs after the decode
  // so it strips any bracket the decode reintroduced.
  const [rawUrl, rawLabel] = splitSlackLabel(content);
  const url = decodeSlackHtmlEntities(rawUrl);
  if (!rawLabel) {
    return url;
  }

  return `${sanitizeLabel(decodeSlackHtmlEntities(rawLabel), url)} (${url})`;
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

/**
 * Normalize a mention label to the renderer's semantics: strip angle
 * brackets, collapse whitespace, strip leading `@`/`#` prefixes. Exported as
 * the single source of truth so persistence-side validation applies exactly
 * the normalization rendering applies; returns `undefined` when nothing
 * usable remains.
 */
export function sanitizeSlackLabel(
  label: string | undefined,
): string | undefined {
  const sanitized = label
    ?.replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[@#]+/, "")
    .trim();
  return sanitized || undefined;
}

function sanitizeOptionalLabel(label: string | undefined): string | undefined {
  return sanitizeSlackLabel(label);
}

function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]+$/.test(value);
}

function looksLikeUrl(content: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(splitSlackLabel(content)[0]);
}
