/**
 * Reply matcher utilities for sequence enrollments.
 */

/**
 * Extract a bare email address from a "Name <email>" or plain "email" string.
 * Handles RFC 5322 addresses where display names or trailing comments may
 * contain angle brackets (e.g., `"Acme <support@acme.com>" <owner@example.com>`).
 * Picks the last `@`-containing segment so display-name fragments don't shadow
 * the actual mailbox. Strips parenthetical comments in the fallback path.
 */
export function extractEmail(from: string): string | undefined {
  // Strip parenthetical comments first to avoid matching addresses inside them
  const cleaned = from.replace(/\(.*?\)/g, "");
  const segments = [...cleaned.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  if (segments.length > 0) {
    const emailSegment = [...segments].reverse().find((s) => s.includes("@"));
    if (emailSegment) return emailSegment.trim().toLowerCase();
  }
  const stripped = from
    .replace(/<[^>]+>/g, "")
    .replace(/\(.*?\)/g, "")
    .trim()
    .toLowerCase();
  if (stripped.includes("@")) return stripped;
  return undefined;
}
