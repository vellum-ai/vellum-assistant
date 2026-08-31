/**
 * Field readers shared by every consumer of a Gmail message: the messaging
 * adapter and the notification normalizer both need the same header lookup,
 * sender parsing, and plain-text body extraction.
 */

import type { GmailMessage, GmailMessagePart } from "./types.js";

/** Read a header value by case-insensitive name. Returns "" when absent. */
export function extractHeader(msg: GmailMessage, name: string): string {
  const lower = name.toLowerCase();
  return (
    msg.payload?.headers?.find((h) => h.name.toLowerCase() === lower)?.value ??
    ""
  );
}

/**
 * Split an RFC 5322 `From` value into a display name and an address.
 * A bare address yields that address as both, matching how Gmail renders it.
 */
export function parseFromHeader(from: string): {
  displayName: string;
  address: string;
} {
  const emailMatch = from.match(/<([^>]+)>/);
  const address = emailMatch?.[1] ?? from;
  const displayName = emailMatch ? from.replace(/<[^>]+>/, "").trim() : from;
  return { displayName: displayName || address, address };
}

/**
 * Named HTML entities worth decoding in an email body. The long list is not
 * worth carrying: mail that reaches here is machine-generated HTML whose text
 * runs use these five plus numeric escapes.
 */
const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: "\u00a0",
  quot: '"',
};

/** Tags whose boundaries read as a line break once the markup is gone. */
const HTML_BREAK_TAGS =
  /<\s*\/?\s*(?:br|p|div|tr|li|ul|ol|h[1-6]|table|thead|tbody|blockquote|section|article|header|footer|hr|pre)\b[^>]*>/gi;

/** Elements whose content is markup machinery rather than readable text. */
const HTML_NON_CONTENT_ELEMENTS =
  /<\s*(script|style|head|title)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z]+);/g,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(
          hex ? body.slice(2) : body.slice(1),
          hex ? 16 : 10,
        );
        try {
          return String.fromCodePoint(code);
        } catch {
          // Out of range, or not a code point at all. Leave it as written.
          return match;
        }
      }
      return NAMED_HTML_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

/**
 * Render an HTML mail body as the text a reader would see.
 *
 * This is deliberately a stripper rather than a parser: the output is read by
 * the model and by the notification tiering layer, neither of which needs the
 * document structure, and a real HTML parser is a dependency this path does
 * not otherwise want. Tags become nothing (block-level ones become a line
 * break), entities are decoded, and whitespace is collapsed, which is what
 * separates a readable body from a wall of markup.
 */
function htmlToPlainText(html: string): string {
  const withoutMachinery = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(HTML_NON_CONTENT_ELEMENTS, " ");
  const withBreaks = withoutMachinery.replace(HTML_BREAK_TAGS, "\n");
  const withoutTags = withBreaks.replace(/<[^>]*>/g, "");

  return decodeHtmlEntities(withoutTags)
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Depth-first search for the first part of the given MIME type. */
function findPartBody(part: GmailMessagePart, mimeType: string): string | null {
  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  if (part.parts) {
    for (const child of part.parts) {
      const result = findPartBody(child, mimeType);
      if (result) {
        return result;
      }
    }
  }
  return null;
}

/**
 * The message body as plain text.
 *
 * `text/plain` wins when the message carries one. Otherwise a `text/html` part
 * is converted: tags are stripped, block-level ones become line breaks, and
 * entities are decoded. The snippet is the last resort, for a message with no
 * readable body part at all, and it is a truncated preview rather than the
 * body a caller asked for.
 */
export function extractPlainTextBody(msg: GmailMessage): string {
  if (!msg.payload) {
    return "";
  }

  const plain = findPartBody(msg.payload, "text/plain");
  if (plain) {
    return plain;
  }

  const html = findPartBody(msg.payload, "text/html");
  if (html) {
    const text = htmlToPlainText(html);
    if (text) {
      return text;
    }
  }

  return msg.snippet ?? "";
}
