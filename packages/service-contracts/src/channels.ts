/**
 * Canonical channel-id vocabulary shared between the assistant daemon and the
 * gateway.
 *
 * A "channel" is an external messaging surface an actor can reach the
 * assistant through (Slack, Telegram, WhatsApp, phone, …) plus a couple of
 * internal ids (`vellum` for native app conversations, `platform` for the
 * internal control plane). This is the single source of truth for that set:
 * the assistant adopts it wholesale as its `ChannelId`, and the gateway
 * asserts its own (narrower) inbound list is a subset of it so the two sides
 * cannot silently drift.
 *
 * Both packages depend on `@vellumai/service-contracts`, so hoisting the set
 * here (rather than maintaining a copy on each side) means adding or renaming
 * a channel happens in exactly one place.
 *
 * Note that a consumer may legitimately handle only a *subset* of these — the
 * gateway, for example, never ingresses `platform`. Use a local list guarded
 * by `satisfies readonly ChannelId[]` for those cases rather than redefining
 * the union.
 */

export const CHANNEL_IDS = [
  "telegram",
  "phone",
  "vellum",
  "whatsapp",
  "slack",
  "email",
  "platform",
  "a2a",
] as const;

export type ChannelId = (typeof CHANNEL_IDS)[number];

export function isChannelId(value: unknown): value is ChannelId {
  return (
    typeof value === "string" &&
    (CHANNEL_IDS as readonly string[]).includes(value)
  );
}
