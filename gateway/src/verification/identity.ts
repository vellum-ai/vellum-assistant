/**
 * Channel-agnostic inbound identity canonicalization for the gateway.
 *
 * Mirrors assistant/src/util/canonicalize-identity.ts so the gateway
 * can canonicalize sender IDs independently.
 */

/** Channels whose raw sender IDs are phone numbers. */
const PHONE_CHANNELS = new Set(["phone", "whatsapp"]);

/**
 * Normalize a phone number string to E.164 format.
 */
function normalizePhoneNumber(input: string): string | null {
  const withoutTrunkZero = input.replace(/\(0\)/g, "");
  const stripped = withoutTrunkZero.replace(/[\s\-().]/g, "");

  if (stripped.length === 0) return null;

  if (stripped.startsWith("+")) {
    const digits = stripped.slice(1);
    if (/^\d{10,15}$/.test(digits)) {
      return stripped;
    }
    return null;
  }

  if (!/^\d+$/.test(stripped)) return null;

  if (stripped.length === 10) {
    return `+1${stripped}`;
  }

  if (stripped.length === 11 && stripped.startsWith("1")) {
    return `+${stripped}`;
  }

  return null;
}

/**
 * Canonicalize a raw inbound sender identity for the given channel.
 *
 * For phone-like channels: attempts E.164 normalization.
 * For non-phone channels: returns trimmed raw ID unchanged.
 * Returns null only when rawId is empty/whitespace-only.
 */
export function canonicalizeInboundIdentity(
  channel: string,
  rawId: string,
): string | null {
  const trimmed = rawId.trim();
  if (trimmed.length === 0) return null;

  if (PHONE_CHANNELS.has(channel)) {
    const e164 = normalizePhoneNumber(trimmed);
    return e164 ?? trimmed;
  }

  return trimmed;
}
