/**
 * Canonical classification of Slack conversations by kind.
 *
 * The Slack ingress path (`socket-mode.ts` event filters and `normalize.ts`
 * normalizers) repeatedly needs to decide whether a conversation is a 1:1
 * direct message, because DMs route to the default assistant and carry an
 * `im` chat type. That decision is centralized here so every call site
 * answers it identically — a DM that one filter recognizes and another does
 * not is silently dropped.
 *
 * Multi-person IMs (`mpim`) are a second, distinct direct-like kind: like a
 * DM, every message in one is addressed to its participants, so admission
 * must not require an @-mention or a tracked thread. Unlike a DM, an MPIM is
 * multi-party, so it keeps its own `mpim` chat type end to end rather than
 * being flattened into `im`. The daemon already branches on that value
 * (group-chat etiquette in `isGroupChatType`, and the `private`
 * permission-matrix cell via `slackConversationType`).
 */

/**
 * True when a Slack conversation is a 1:1 direct message (IM).
 *
 * Two independent signals each prove a DM, and either is sufficient:
 *   - `channel_type === "im"` — reliable when Slack sends it, but Slack omits
 *     it on message edits, deletes, and thread replies, and never sends it on
 *     reaction or interactive payloads.
 *   - a `D`-prefixed conversation ID — always present; only 1:1 IMs are
 *     prefixed `D` (public channels are `C`, private channels and
 *     multi-person IMs are `G` — https://api.slack.com/types/conversation).
 *
 * Gating on `channel_type` alone is what silently drops DM events that omit
 * it; the ID prefix is the always-present fallback. Pass `channelType` only
 * where the payload actually carries one.
 */
export function isSlackDmChannel(
  channelId: string | undefined,
  channelType?: string,
): boolean {
  return (
    channelType === "im" ||
    (typeof channelId === "string" && channelId.startsWith("D"))
  );
}

/**
 * True when a Slack conversation is a multi-person IM (group DM).
 *
 * Unlike {@link isSlackDmChannel} there is **no id-prefix fallback**. The
 * documented prefix for an MPIM is `G`, but `G` is shared with private
 * channels, and modern workspaces mint MPIMs with a plain `C` prefix
 * (verified: `C0BMU5X5FEU` reports `is_mpim: true, is_channel: true`). An id
 * alone therefore proves nothing in either direction, so this predicate reads
 * only the explicit `channel_type` discriminator.
 *
 * `channel_type` is present on `message` events but absent from reaction and
 * interactive payloads, so reaction admission cannot use this predicate on its
 * own: it composes it with the observed-kind cache in `user-directory.ts`.
 */
export function isSlackMpimChannel(channelType?: string): boolean {
  return channelType === "mpim";
}
