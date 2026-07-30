/**
 * The shared coordinate frame, its validators, and its string projection.
 *
 * Two contracts are built on this frame: `ChannelAddress` (the provider
 * conversation or thread a message belongs to) and `ChannelActor` (the peer who
 * sent it). They name different things, but they are shaped the same way and
 * project the same way, so the frame, the validators, and the projection engine
 * live here once instead of being written twice and drifting apart.
 *
 * The frame is three parts:
 *
 * - `channel`: the canonical {@link ChannelId} discriminator.
 * - `scope`: the provider account or installation the coordinates live inside,
 *   present only where the provider namespaces them by one. A Slack channel id
 *   is meaningful only within its workspace; a phone number is global.
 * - `coordinates`: the provider-native identifiers themselves.
 *
 * Coordinate values are canonical on the way out. Phone-shaped channels carry
 * E.164 and case-insensitive namespaces carry lower case, matching what the
 * assistant's own inbound canonicalizer produces. Where a provider has more
 * than one spelling, the schema takes the provider-native form and normalizes
 * it rather than picking a winner and rejecting the other: a WhatsApp `wa_id`
 * arrives as bare digits and validates, it just comes back out with its `+`.
 * Two spellings of one coordinate would otherwise give two projections of one
 * conversation.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Coordinate primitives
// ---------------------------------------------------------------------------

/**
 * Upper bound on a single coordinate value. Every provider identifier we carry
 * is far below this; the bound exists so a hostile projection cannot grow
 * without limit before validation rejects it.
 */
export const MAX_COORDINATE_LENGTH = 256;

/**
 * A provider identifier we do not model further: non-empty, bounded, and free
 * of whitespace and control characters so it survives the string projection
 * and cannot smuggle a line break into a log.
 */
export const opaqueId = () =>
  z
    .string()
    .min(1)
    .max(MAX_COORDINATE_LENGTH)
    .regex(
      /^[^\s\p{Cc}]+$/u,
      "must not contain whitespace or control characters",
    );

/**
 * E.164, matching exactly what `normalizePhoneNumber` in the assistant emits:
 * a leading `+` followed by 10 to 15 digits. Twilio hands over `From` and `To`
 * already in this form, so unlike a WhatsApp `wa_id` there is no second
 * provider-native spelling to accept.
 */
export const e164 = () =>
  z
    .string()
    .regex(/^\+\d{10,15}$/, "must be an E.164 phone number, e.g. +15555550123");

/**
 * A WhatsApp `wa_id`. Meta carries chat and sender ids as full international
 * digits with no leading `+` (`messages[].from` and `contacts[].wa_id` on the
 * Cloud API), so that is the spelling a producer actually holds. Both spellings
 * are accepted and canonicalized to E.164 by prefixing the `+`, which is
 * lossless because a `wa_id` is already a complete international number: unlike
 * a national format there is no country to guess. The digit bounds mirror
 * `normalizePhoneNumber` so the two agree on what counts as phone-shaped.
 */
export const waId = () =>
  z
    .string()
    .regex(
      /^\+?\d{10,15}$/,
      "must be a WhatsApp wa_id, e.g. 15555550188 or +15555550188",
    )
    .transform((value) => (value.startsWith("+") ? value : `+${value}`));

/** A decimal identifier of bounded width (Telegram ids, Discord snowflakes). */
export const decimalId = (maxDigits: number) =>
  z
    .string()
    .regex(new RegExp(`^\\d{1,${maxDigits}}$`), "must be decimal digits");

/**
 * A negatable decimal identifier. Telegram chat ids are negative for groups,
 * supergroups, and channels, and positive for private chats, so a chat
 * coordinate cannot reuse the unsigned rule a user id can.
 */
export const signedDecimalId = (maxDigits: number) =>
  z
    .string()
    .regex(
      new RegExp(`^-?\\d{1,${maxDigits}}$`),
      "must be decimal digits, optionally negative",
    );

/**
 * Slack object ids carry a type prefix, and the prefix is what says which kind
 * of object an id names. Validating it per field is the difference between a
 * schema that rejects a malformed address and one that only rejects a malformed
 * string: a workspace scope holding a channel id is exactly the kind of swap a
 * contract exists to catch.
 */
const slackObjectId = (pattern: RegExp, message: string) =>
  z.string().max(MAX_COORDINATE_LENGTH).regex(pattern, message);

export const slackTeamId = () =>
  slackObjectId(
    /^T[A-Z0-9]{2,}$/,
    "must be a Slack workspace id, e.g. T0123ABCD",
  );

export const slackEnterpriseId = () =>
  slackObjectId(
    /^E[A-Z0-9]{2,}$/,
    "must be a Slack Enterprise Grid org id, e.g. E0123ABCD",
  );

/** `U…` on a standalone workspace, `W…` for an Enterprise Grid org user. */
export const slackUserId = () =>
  slackObjectId(
    /^[UW][A-Z0-9]{2,}$/,
    "must be a Slack user id, e.g. U0123ABCD",
  );

/**
 * A Slack conversation: `C…` public channel, `D…` DM, `G…` private channel or
 * legacy group DM. The gateway forwards all three on the same field, so the
 * address accepts all three and the prefix is what tells them apart.
 */
export const slackConversationId = () =>
  slackObjectId(
    /^[CDG][A-Z0-9]{2,}$/,
    "must be a Slack conversation id, e.g. C0123ABCD",
  );

/**
 * A Slack message timestamp, used as the thread key (`thread_ts`). Seconds and
 * a six-digit fraction, e.g. `1700000000.000100`.
 */
export const slackThreadTs = () =>
  z
    .string()
    .regex(
      /^\d{10}\.\d{6}$/,
      "must be a Slack message timestamp, e.g. 1700000000.000100",
    );

// ---------------------------------------------------------------------------
// String projection
// ---------------------------------------------------------------------------

/**
 * Projection syntax:
 *
 *     <channel>:<field>=<value>[;<field>=<value>…]
 *
 * Scope fields carry a `scope.` prefix, coordinates are bare, and each group is
 * emitted in alphabetical order with scope first, so one value has exactly one
 * projection regardless of how its object literal was written. Values are
 * percent-encoded, which escapes `;`, `=`, and `%` and makes the field list
 * unambiguous for any coordinate content.
 */
const SCOPE_PREFIX = "scope.";
const CHANNEL_SEPARATOR = ":";
const FIELD_SEPARATOR = ";";
const VALUE_SEPARATOR = "=";

/** The unvalidated shape a projection decodes to, before a schema sees it. */
export interface CoordinateFrame {
  channel: string;
  scope?: Record<string, string>;
  coordinates: Record<string, string>;
}

function byKey(a: readonly [string, unknown], b: readonly [string, unknown]) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function projectGroup(
  group: Readonly<Record<string, unknown>>,
  prefix: string,
): string[] {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(group).sort(byKey)) {
    // Optional coordinates (a Slack thread key outside a thread, a Telegram
    // topic outside a forum) are absent rather than empty, and an absent field
    // is simply not projected.
    if (typeof value !== "string") {
      continue;
    }
    fields.push(
      `${prefix}${key}${VALUE_SEPARATOR}${encodeURIComponent(value)}`,
    );
  }
  return fields;
}

/** Project a validated coordinate frame onto its canonical string form. */
export function formatFrame(
  channel: string,
  scope: Readonly<Record<string, unknown>> | undefined,
  coordinates: Readonly<Record<string, unknown>>,
): string {
  const fields = [
    ...(scope ? projectGroup(scope, SCOPE_PREFIX) : []),
    ...projectGroup(coordinates, ""),
  ];
  return `${channel}${CHANNEL_SEPARATOR}${fields.join(FIELD_SEPARATOR)}`;
}

/**
 * Decode a projection back to its frame, without validating the coordinates
 * themselves: the caller runs its own schema over the result, which is what
 * rejects an unknown field, a missing scope block, or a malformed value.
 *
 * Returns `null` for anything that is not syntactically a projection.
 */
export function parseFrame(text: string): CoordinateFrame | null {
  const separator = text.indexOf(CHANNEL_SEPARATOR);
  if (separator <= 0) {
    return null;
  }

  const channel = text.slice(0, separator);
  const body = text.slice(separator + 1);
  if (body.length === 0) {
    return null;
  }

  // Field names come off an untrusted string, so they are accumulated in maps
  // rather than assigned onto object literals. Writing a decoded name straight
  // onto `{}` goes through `Object.prototype`, where `__proto__` is an accessor
  // rather than a key: the field would vanish instead of becoming an own
  // property, hiding it from both the duplicate check below and the schema's
  // unknown-key rejection, so a tampered projection would parse as clean. A map
  // key is just a key, and `Object.fromEntries` defines own properties without
  // consulting a setter, so every decoded name reaches validation.
  const scope = new Map<string, string>();
  const coordinates = new Map<string, string>();

  for (const field of body.split(FIELD_SEPARATOR)) {
    const assignment = field.indexOf(VALUE_SEPARATOR);
    if (assignment <= 0) {
      return null;
    }

    const rawKey = field.slice(0, assignment);
    let value: string;
    try {
      value = decodeURIComponent(field.slice(assignment + 1));
    } catch {
      // Malformed percent-escape.
      return null;
    }

    const isScope = rawKey.startsWith(SCOPE_PREFIX);
    const key = isScope ? rawKey.slice(SCOPE_PREFIX.length) : rawKey;
    const target = isScope ? scope : coordinates;
    if (key.length === 0 || target.has(key)) {
      return null;
    }

    target.set(key, value);
  }

  return {
    channel,
    ...(scope.size > 0 ? { scope: Object.fromEntries(scope) } : {}),
    coordinates: Object.fromEntries(coordinates),
  };
}
