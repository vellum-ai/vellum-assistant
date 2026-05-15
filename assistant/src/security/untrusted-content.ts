/**
 * Structural defenses against prompt injection from external content.
 *
 * All external data (emails, messages, web pages, calendar events, etc.)
 * should be wrapped via `wrapUntrustedContent()` before entering the LLM
 * conversation context. The wrapper:
 *
 * 1. Delimits external content with `<external_content>` XML boundaries so
 *    the model can distinguish data from instructions.
 * 2. Escapes boundary-breaking sequences within the content.
 * 3. Enforces per-source character budgets to prevent context flooding.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const UNTRUSTED_CONTENT_SOURCES = [
  "email",
  "slack",
  "web",
  "calendar",
  "webhook",
  "search",
  "tool_result",
] as const;

export type UntrustedContentSource = (typeof UNTRUSTED_CONTENT_SOURCES)[number];

export interface ExternalContentEnvelope {
  source: UntrustedContentSource;
  origin?: string;
  content: string;
}

export interface WrapOptions {
  /** Which external source produced this content. */
  source: UntrustedContentSource;
  /** Origin identifier (sender email, URL, etc.). Sanitized before inclusion. */
  sourceDetail?: string;
  /** Override the default character budget for this source. */
  maxChars?: number;
}

// ---------------------------------------------------------------------------
// Per-source character budgets
// ---------------------------------------------------------------------------

const DEFAULT_BUDGETS: Record<UntrustedContentSource, number> = {
  email: 20_000,
  slack: 10_000,
  web: 40_000,
  calendar: 5_000,
  webhook: 10_000,
  search: 15_000,
  tool_result: 20_000,
};

const UNTRUSTED_CONTENT_SOURCE_SET = new Set<string>(UNTRUSTED_CONTENT_SOURCES);

const EXTERNAL_CONTENT_ENVELOPE_PATTERN =
  /^<external_content\s+([^\r\n<>]*)>\n([\s\S]*)\n<\/external_content>$/;

const EXTERNAL_CONTENT_ATTRIBUTE_PATTERN =
  /(?:^|\s+)(source|origin)="([^"\r\n]*)"/g;

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Wrap external content in structural XML boundaries.
 *
 * The returned string is safe to include directly in an LLM message - the
 * model will see it delimited as third-party data.
 */
export function wrapUntrustedContent(
  content: string,
  options: WrapOptions,
): string {
  const budget = options.maxChars ?? DEFAULT_BUDGETS[options.source];
  const escaped = escapeContentBoundaries(content);
  const truncated = truncateWithNotice(escaped, budget);
  const detail = options.sourceDetail
    ? ` origin="${sanitizeAttr(options.sourceDetail)}"`
    : "";
  return `<external_content source="${options.source}"${detail}>\n${truncated}\n</external_content>`;
}

export function parseExternalContentEnvelope(
  value: string,
): ExternalContentEnvelope | null {
  const match = EXTERNAL_CONTENT_ENVELOPE_PATTERN.exec(value);
  if (!match || match[0] !== value) {
    return null;
  }

  const attributes = parseExternalContentAttributes(match[1]);
  if (!attributes) {
    return null;
  }

  const content = match[2];
  if (/<\/external_content/gi.test(content)) {
    return null;
  }

  return { ...attributes, content };
}

export function unwrapExternalContentForDisplay(value: string): string {
  return parseExternalContentEnvelope(value)?.content ?? value;
}

/**
 * Escape sequences that could break out of the `<external_content>` wrapper.
 * Case-insensitive to cover mixed-case evasion attempts.
 */
export function escapeContentBoundaries(content: string): string {
  return content.replace(
    /<\/external_content/gi,
    (match) => `&lt;${match.slice(1)}`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize a value for use as an XML attribute (no quotes, angle brackets, newlines). */
function sanitizeAttr(value: string): string {
  return value.replace(/[<>"&\r\n]/g, "").slice(0, 200);
}

function parseExternalContentAttributes(
  attributes: string,
): Pick<ExternalContentEnvelope, "source" | "origin"> | null {
  let source: UntrustedContentSource | undefined;
  let origin: string | undefined;
  let originSeen = false;
  let cursor = 0;

  EXTERNAL_CONTENT_ATTRIBUTE_PATTERN.lastIndex = 0;
  for (const match of attributes.matchAll(EXTERNAL_CONTENT_ATTRIBUTE_PATTERN)) {
    if (match.index !== cursor) {
      return null;
    }

    const [, name, value] = match;
    if (name === "source") {
      if (source || !isUntrustedContentSource(value)) {
        return null;
      }
      source = value;
    } else {
      if (originSeen) {
        return null;
      }
      originSeen = true;
      origin = value;
    }
    cursor = match.index + match[0].length;
  }

  if (cursor !== attributes.length || !source) {
    return null;
  }

  return originSeen ? { source, origin } : { source };
}

function isUntrustedContentSource(
  value: string,
): value is UntrustedContentSource {
  return UNTRUSTED_CONTENT_SOURCE_SET.has(value);
}

/** Truncate content to a character budget, appending a notice if truncated. */
function truncateWithNotice(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return (
    content.slice(0, maxChars) +
    `\n[... truncated at ${maxChars.toLocaleString()} characters]`
  );
}
