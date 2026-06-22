/**
 * Canonical classification of Slack conversations by kind.
 *
 * The Slack ingress path (`socket-mode.ts` event filters and `normalize.ts`
 * normalizers) repeatedly needs to decide whether a conversation is a 1:1
 * direct message, because DMs route to the default assistant and carry an
 * `im` chat type. That decision is centralized here so every call site
 * answers it identically — a DM that one filter recognizes and another does
 * not is silently dropped.
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
