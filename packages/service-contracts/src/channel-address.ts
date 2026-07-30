/**
 * Durable channel identity.
 *
 * A `ChannelAddress` answers "which peer is this, on which channel, inside
 * which provider account". It is the identity half of the channel contract and
 * is deliberately separate from the delivery half (conversation ids, reply
 * callback URLs, transport hints), which lives on
 * `ChannelDeliveryRoute` in `./channel-envelope.js`. A delivery coordinate is
 * ephemeral: it changes when a thread moves, when a callback URL is reissued,
 * or when a transport is re-registered. An address does not, so nothing that
 * routes a reply may ever stand in for one.
 *
 * Every variant has the same three-part frame:
 *
 * - `channel`: the canonical {@link ChannelId} discriminator.
 * - `scope`: the provider account or installation the identity lives inside,
 *   present only on channels whose identifiers are namespaced by one. A Slack
 *   user id is meaningful only within its workspace; a Telegram user id is
 *   global, so `telegram` has no scope.
 * - `coordinates`: the provider-native identifiers of the peer itself.
 *
 * Because the frame is uniform, both the string projection below and the
 * capability annotations in `./channel-capabilities.js` are computed from the
 * schemas rather than restated in a table that could drift away from them.
 *
 * Coordinate values are canonical, not raw. Phone-shaped channels carry E.164,
 * and case-insensitive namespaces (email, A2A) carry lower case, matching what
 * the assistant's own inbound canonicalizer already produces. Two spellings of
 * one identity would give two projections of one peer, which would make the
 * projection ambiguous, so the schemas normalize rather than accept both.
 */

import { z } from "zod";

import type { ChannelId } from "./channels.js";

// ---------------------------------------------------------------------------
// Coordinate primitives
// ---------------------------------------------------------------------------

/**
 * Upper bound on a single coordinate value. Every provider identifier we carry
 * is far below this; the bound exists so a hostile projection cannot grow
 * without limit before validation rejects it.
 */
const MAX_COORDINATE_LENGTH = 256;

/**
 * A provider identifier we do not model further: non-empty, bounded, and free
 * of whitespace and control characters so it survives the string projection
 * and cannot smuggle a line break into a log.
 */
const opaqueId = () =>
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
 * a leading `+` followed by 10 to 15 digits. Producers canonicalize before
 * building an address, so a nationally formatted number is a malformed
 * coordinate here rather than a second spelling of the same peer.
 */
const e164 = () =>
  z
    .string()
    .regex(/^\+\d{10,15}$/, "must be an E.164 phone number, e.g. +15555550123");

/** A decimal identifier of bounded width (Telegram user ids, Discord snowflakes). */
const decimalId = (maxDigits: number) =>
  z
    .string()
    .regex(new RegExp(`^\\d{1,${maxDigits}}$`), "must be decimal digits");

/**
 * A Slack object id: an uppercase type letter followed by uppercase
 * alphanumerics (`T…` workspace, `E…` enterprise grid, `U…`/`W…` user).
 */
const slackId = () =>
  z
    .string()
    .max(MAX_COORDINATE_LENGTH)
    .regex(/^[A-Z][A-Z0-9]{2,}$/, "must be a Slack object id, e.g. T0123ABCD");

// ---------------------------------------------------------------------------
// Per-channel address variants
// ---------------------------------------------------------------------------

/**
 * Native app conversations. The gateway mints a principal id for the local
 * human actor at guardian bootstrap and it is what `contact_channels` stores as
 * the `vellum` address. A self-hosted assistant is its own installation, so
 * there is no external account to scope by.
 */
export const VellumChannelAddressSchema = z.strictObject({
  channel: z.literal("vellum"),
  coordinates: z.strictObject({
    principalId: opaqueId(),
  }),
});

/**
 * Platform push relay.
 *
 * `platform` does not mint identities of its own. It is a delivery relay whose
 * conversations are owned by the `vellum` channel, and the principal it targets
 * (`target_guardian_principal_id` on the push dispatch body) is resolved from
 * the `vellum` guardian binding. Its address is therefore that same principal,
 * scoped by the platform-side assistant id the push is dispatched through, and
 * a `platform` address and a `vellum` address can denote one person. Encoding
 * that borrowing explicitly is the honest reading of the current vocabulary;
 * inventing a platform-native peer identifier would not be.
 */
export const PlatformChannelAddressSchema = z.strictObject({
  channel: z.literal("platform"),
  scope: z.strictObject({
    /** Platform-side assistant id the push dispatch is addressed to. */
    platformAssistantId: opaqueId(),
  }),
  coordinates: z.strictObject({
    /** The `vellum` principal this relay delivers to. */
    principalId: opaqueId(),
  }),
});

/**
 * Slack user ids are unique only within a workspace, so the workspace is part
 * of the identity. `enterpriseId` is present only on Enterprise Grid
 * installations and is optional for that reason, not because it is
 * discretionary: a producer that has it must include it.
 */
export const SlackChannelAddressSchema = z.strictObject({
  channel: z.literal("slack"),
  scope: z.strictObject({
    /** Workspace id (`T…`). */
    teamId: slackId(),
    /** Enterprise Grid organization id (`E…`), on grid installations only. */
    enterpriseId: slackId().optional(),
  }),
  coordinates: z.strictObject({
    /** Slack user id (`U…`, or `W…` on grid). */
    userId: slackId(),
  }),
});

/**
 * Telegram user ids are global to the Bot API, so a Telegram address needs no
 * scope. The bot itself is the installation, and no bot identifier is carried
 * on the ingress wire today, so none is modelled here.
 */
export const TelegramChannelAddressSchema = z.strictObject({
  channel: z.literal("telegram"),
  coordinates: z.strictObject({
    /** Bot API `from.id`, rendered as decimal digits. */
    userId: decimalId(19),
  }),
});

/**
 * The WhatsApp Business phone number that received the message is the
 * installation: the same person messaging two of our numbers is reachable at
 * two addresses, and a reply is only valid from the number they wrote to.
 */
export const WhatsAppChannelAddressSchema = z.strictObject({
  channel: z.literal("whatsapp"),
  scope: z.strictObject({
    /** Cloud API `metadata.phone_number_id` of the receiving business number. */
    businessPhoneNumberId: decimalId(32),
  }),
  coordinates: z.strictObject({
    /** Sender's WhatsApp number in E.164. */
    waId: e164(),
  }),
});

/**
 * Discord user snowflakes are global. A guild scopes where a message was seen,
 * not who the author is, so it is delivery routing and stays off the address.
 */
export const DiscordChannelAddressSchema = z.strictObject({
  channel: z.literal("discord"),
  coordinates: z.strictObject({
    /** Author user snowflake. */
    userId: decimalId(20),
  }),
});

/**
 * An email address is globally unique, and which of our inbound addresses the
 * peer wrote to is routing rather than identity. Lower cased to match the
 * `COLLATE NOCASE` matching the contact store already applies.
 */
export const EmailChannelAddressSchema = z.strictObject({
  channel: z.literal("email"),
  coordinates: z.strictObject({
    address: z.email().max(320).toLowerCase(),
  }),
});

/** Phone numbers are globally unique; the Twilio number they dialed is routing. */
export const PhoneChannelAddressSchema = z.strictObject({
  channel: z.literal("phone"),
  coordinates: z.strictObject({
    e164: e164(),
  }),
});

/**
 * Assistant-to-assistant peers. The peer's `gatewayUrl` is where a reply goes
 * and is re-registered whenever the peer's ingress moves, so identity is the
 * assistant id alone. Lower cased, matching how A2A invites store it.
 */
export const A2aChannelAddressSchema = z.strictObject({
  channel: z.literal("a2a"),
  coordinates: z.strictObject({
    assistantId: opaqueId().toLowerCase(),
  }),
});

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

/**
 * Address variant per canonical channel.
 *
 * The `satisfies Record<ChannelId, …>` annotation is the exhaustiveness gate:
 * adding an id to `CHANNEL_IDS` fails to compile here until its address shape
 * is spelled out, and a variant for a channel that is not canonical fails too.
 * `channel-address.test.ts` pins the union below to this map, since
 * `z.discriminatedUnion` takes a tuple that the map's value type cannot supply.
 */
export const CHANNEL_ADDRESS_SCHEMAS = {
  a2a: A2aChannelAddressSchema,
  discord: DiscordChannelAddressSchema,
  email: EmailChannelAddressSchema,
  phone: PhoneChannelAddressSchema,
  platform: PlatformChannelAddressSchema,
  slack: SlackChannelAddressSchema,
  telegram: TelegramChannelAddressSchema,
  vellum: VellumChannelAddressSchema,
  whatsapp: WhatsAppChannelAddressSchema,
} as const satisfies Record<ChannelId, z.ZodObject>;

export const ChannelAddressSchema = z.discriminatedUnion("channel", [
  CHANNEL_ADDRESS_SCHEMAS.a2a,
  CHANNEL_ADDRESS_SCHEMAS.discord,
  CHANNEL_ADDRESS_SCHEMAS.email,
  CHANNEL_ADDRESS_SCHEMAS.phone,
  CHANNEL_ADDRESS_SCHEMAS.platform,
  CHANNEL_ADDRESS_SCHEMAS.slack,
  CHANNEL_ADDRESS_SCHEMAS.telegram,
  CHANNEL_ADDRESS_SCHEMAS.vellum,
  CHANNEL_ADDRESS_SCHEMAS.whatsapp,
]);

export type ChannelAddress = z.infer<typeof ChannelAddressSchema>;

/** The address variant for one channel, e.g. `ChannelAddressFor<"slack">`. */
export type ChannelAddressFor<C extends ChannelId> = Extract<
  ChannelAddress,
  { channel: C }
>;

// ---------------------------------------------------------------------------
// String projection
// ---------------------------------------------------------------------------

/**
 * Projection syntax:
 *
 *     <channel>:<field>=<value>[;<field>=<value>…]
 *
 * Scope fields carry a `scope.` prefix, coordinates are bare, and each group is
 * emitted in alphabetical order with scope first, so one address has exactly
 * one projection regardless of how its object literal was written. Values are
 * percent-encoded, which escapes `;`, `=`, and `%` and makes the field list
 * unambiguous for any coordinate content.
 */
const SCOPE_PREFIX = "scope.";

const CHANNEL_SEPARATOR = ":";
const FIELD_SEPARATOR = ";";
const VALUE_SEPARATOR = "=";

function byKey(a: readonly [string, unknown], b: readonly [string, unknown]) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/**
 * Project an address onto its canonical string form.
 *
 * The address is validated first, so the output is always the projection of a
 * canonical address: a caller that hands over `Alice@example.com` gets the
 * projection of `alice@example.com` rather than a second spelling.
 *
 * @throws {z.ZodError} when the address is not a valid {@link ChannelAddress}.
 */
export function formatChannelAddress(address: ChannelAddress): string {
  const canonical = ChannelAddressSchema.parse(address);
  const fields: string[] = [];

  if ("scope" in canonical) {
    for (const [key, value] of Object.entries(canonical.scope).sort(byKey)) {
      // Optional scope coordinates (Slack's enterprise id off grid) are absent
      // rather than empty, and an absent field is simply not projected.
      if (typeof value !== "string") continue;
      fields.push(
        `${SCOPE_PREFIX}${key}${VALUE_SEPARATOR}${encodeURIComponent(value)}`,
      );
    }
  }

  for (const [key, value] of Object.entries(canonical.coordinates).sort(
    byKey,
  )) {
    fields.push(`${key}${VALUE_SEPARATOR}${encodeURIComponent(value)}`);
  }

  return `${canonical.channel}${CHANNEL_SEPARATOR}${fields.join(FIELD_SEPARATOR)}`;
}

/**
 * Inverse of {@link formatChannelAddress}. Returns `null` for anything that is
 * not a projection of a valid address: an unknown channel, a duplicated or
 * unknown field, a broken percent-escape, a coordinate that fails its own
 * format, or a channel's scope block being absent when it is required.
 */
export function safeParseChannelAddress(text: string): ChannelAddress | null {
  const separator = text.indexOf(CHANNEL_SEPARATOR);
  if (separator <= 0) {
    return null;
  }

  const channel = text.slice(0, separator);
  const body = text.slice(separator + 1);
  if (body.length === 0) {
    return null;
  }

  const scope: Record<string, string> = {};
  const coordinates: Record<string, string> = {};
  let scoped = false;

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
    if (key.length === 0 || Object.hasOwn(target, key)) {
      return null;
    }

    target[key] = value;
    scoped ||= isScope;
  }

  const result = ChannelAddressSchema.safeParse({
    channel,
    ...(scoped ? { scope } : {}),
    coordinates,
  });
  return result.success ? result.data : null;
}

/**
 * Inverse of {@link formatChannelAddress}, throwing instead of returning
 * `null`. The message deliberately omits the input: a projection carries an
 * email address or a phone number, and a parse failure is not a reason to put
 * one in a log line.
 */
export function parseChannelAddress(text: string): ChannelAddress {
  const address = safeParseChannelAddress(text);
  if (address === null) {
    throw new Error("not a valid channel address projection");
  }
  return address;
}
