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
 * Depth-first search for the first `text/plain` part, falling back to the
 * snippet when the message carries only HTML.
 */
export function extractPlainTextBody(msg: GmailMessage): string {
  if (!msg.payload) {
    return "";
  }

  function walkParts(part: GmailMessagePart): string | null {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
    if (part.parts) {
      for (const child of part.parts) {
        const result = walkParts(child);
        if (result) {
          return result;
        }
      }
    }
    return null;
  }

  return walkParts(msg.payload) ?? msg.snippet ?? "";
}
