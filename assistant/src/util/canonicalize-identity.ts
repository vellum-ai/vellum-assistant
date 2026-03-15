/**
 * Channel-agnostic inbound identity canonicalization.
 *
 * Normalizes raw sender identifiers into a stable canonical form so that
 * trust lookups, member matching, and guardian binding comparisons are
 * immune to formatting variance across channels.
 *
 * Phone-like channels (voice, whatsapp) normalize to E.164 using the
 * existing phone utilities. Non-phone channels (telegram, slack, etc.)
 * pass through the platform-stable ID as-is after whitespace trimming.
 */

import type { ChannelId } from "../channels/types.js";
import { normalizePhoneNumber } from "./phone.js";

/** Channels whose raw sender IDs are phone numbers. */
const PHONE_CHANNELS: ReadonlySet<ChannelId> = new Set(["phone", "whatsapp"]);

/**
 * Canonicalize a raw inbound sender identity for the given channel.
 *
 * - For phone-like channels: attempts E.164 normalization. Returns the
 *   normalized E.164 string on success, or the trimmed raw ID if
 *   normalization fails (defensive: don't discard an identity just because
 *   it doesn't parse as a phone number).
 * - For non-phone channels: returns the trimmed raw ID unchanged (these
 *   platforms provide stable, unique identifiers that don't need normalization).
 *
 * Returns `null` only when `rawId` is empty/whitespace-only.
 */
export function canonicalizeInboundIdentity(
  channel: ChannelId,
  rawId: string,
): string | null {
  const trimmed = rawId.trim();
  if (trimmed.length === 0) return null;

  if (PHONE_CHANNELS.has(channel)) {
    const e164 = normalizePhoneNumber(trimmed);
    // Defensive: if normalization fails, preserve the raw ID so downstream
    // lookups don't silently lose the identity.
    return e164 ?? trimmed;
  }

  return trimmed;
}
