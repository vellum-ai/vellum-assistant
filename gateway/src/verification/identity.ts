/**
 * Channel-agnostic inbound identity canonicalization for the gateway.
 *
 * Mirrors assistant/src/util/canonicalize-identity.ts so the gateway
 * can canonicalize sender IDs independently.
 */

/** Channels whose raw sender IDs are phone numbers. */
const PHONE_CHANNELS = new Set(["phone", "whatsapp"]);

/** Channels whose raw sender IDs are email addresses. */
const EMAIL_CHANNELS = new Set(["email"]);

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
 * For email channels: lowercases the address.
 * For other channels: returns trimmed raw ID unchanged.
 * Returns null only when rawId is empty/whitespace-only.
 */
export function canonicalizeInboundIdentity(
  channel: string,
  rawId: string,
): string | null {
  return canonicalizeIdentityAs(identityKindFor(channel), rawId);
}

/**
 * What an address on a channel *is*, independent of which channel carries it.
 *
 * A built-in channel's answer follows from its name, which is why the sets
 * above suffice for them. A plugin channel's does not: `plugin` is one id
 * covering every plugin, and whether its addresses are phone numbers, email
 * addresses, or opaque handles is the plugin's business. Its ingress manifest
 * declares the answer, and it arrives here as one of these.
 */
export type IdentityKind = "phone" | "email" | "opaque";

function identityKindFor(channel: string): IdentityKind {
  if (PHONE_CHANNELS.has(channel)) {
    return "phone";
  }
  if (EMAIL_CHANNELS.has(channel)) {
    return "email";
  }
  return "opaque";
}

/**
 * Canonicalize an address of a known kind.
 *
 * Phone-like: E.164 where the input parses as one, the trimmed input where it
 * does not — a raw id that is not a phone number after all still has to
 * compare equal to itself. Email: lowercased. Opaque: trimmed, because a
 * platform-stable id is already canonical and rewriting it would only make it
 * stop matching what is stored.
 *
 * Returns null only for an empty or whitespace-only input.
 */
export function canonicalizeIdentityAs(
  kind: IdentityKind,
  rawId: string,
): string | null {
  const trimmed = rawId.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (kind === "phone") {
    return normalizePhoneNumber(trimmed) ?? trimmed;
  }
  if (kind === "email") {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

/**
 * Canonical sender id for a possibly-absent inbound actor id. Treats a missing
 * or whitespace-only id as absent (null) before canonicalizing, so trust
 * resolution and its failure sentinels share one normalization.
 */
export function canonicalSenderIdFor(
  channel: string,
  actorExternalId?: string,
): string | null {
  const trimmed = actorExternalId?.trim();
  return trimmed ? canonicalizeInboundIdentity(channel, trimmed) : null;
}
