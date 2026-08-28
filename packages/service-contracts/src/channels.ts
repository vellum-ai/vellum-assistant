/**
 * Canonical channel-id vocabulary shared between the assistant daemon and the
 * gateway.
 *
 * A "channel" is an external messaging surface an actor can reach the
 * assistant through (Slack, Telegram, WhatsApp, phone, …) plus a couple of
 * internal ids (`vellum` for native app conversations, `platform` for the
 * internal control plane). This is the single source of truth for that set:
 *
 * One id, `plugin`, does not name a surface: it names *every* surface a plugin
 * brings. A plugin channel's real identity is the plugin, which is workspace
 * state and cannot be a compile-time union member, so the plugin name travels
 * in `sourceMetadata.plugin` and is prefixed onto every external id the gateway
 * forwards (`imessage:+15551234567`). Two plugins therefore share a channel
 * row — one admission floor, one set of channel-wide defaults — while their
 * conversations, contacts, and trust records stay disjoint. See
 * `gateway/src/channels/plugin-inbound.ts` for what that concedes.
 *
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
  "discord",
  "plugin",
] as const;

export type ChannelId = (typeof CHANNEL_IDS)[number];

export function isChannelId(value: unknown): value is ChannelId {
  return (
    typeof value === "string" &&
    (CHANNEL_IDS as readonly string[]).includes(value)
  );
}

/**
 * The provider key holding each channel's bot credential.
 *
 * Two senses of "connected" share the provider registry: a provider the user
 * authorized so the assistant can act **as them** (`slack`, `discord`,
 * `google`), and a bot credential letting people reach the assistant **as
 * itself**. Nothing in a provider key says which, and the naming actively
 * misleads: `slack` and `discord` name the user integration while their bots
 * take a `_channel` suffix, yet `telegram` *is* the bot, because Telegram has
 * no user-identity integration.
 *
 * That irregularity is why this is stated rather than derived from the key,
 * and it is stated here because this file already owns what a channel is.
 *
 * Both senses can hold a user token, which is the sharpest edge. The `slack`
 * integration's persisted token *is* the installer's user token, held on its
 * OAuth connection. `slack_channel` holds an optional `user_token` in the
 * credential store, beside its bot and app tokens. Same words, different
 * homes, and only the second is a credential-store key: a pasted token is
 * always the channel's, because the integration's never leaves the exchange.
 *
 * Deliberately only the key. What fields each credential requires is declared
 * once already, per service, in the gateway's credential specs; restating it
 * here would be a second copy of a different fact.
 *
 * Channels absent from this map reach the assistant without a bot credential
 * of their own: `phone` through the voice provider, `vellum` and `platform`
 * internally.
 */
export const CHANNEL_BOT_PROVIDER = {
  slack: "slack_channel",
  discord: "discord_channel",
  telegram: "telegram",
} as const satisfies Partial<Record<ChannelId, string>>;

/**
 * Whether a provider key names a bot the assistant is reached through, rather
 * than a grant letting it act as the user. This is the "which sense of
 * connected" question, for any provider key.
 */
export function isChannelBotProvider(providerKey: string): boolean {
  return (Object.values(CHANNEL_BOT_PROVIDER) as readonly string[]).includes(
    providerKey,
  );
}
