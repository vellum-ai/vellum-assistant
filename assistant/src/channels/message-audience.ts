/**
 * Who a reply should be visible to, decided once for every producer.
 */

import type { MessageAudience } from "@vellumai/gateway-client";

/**
 * The audience a reply addressed at `userId` should carry, or `undefined` when
 * the whole room may see it.
 *
 * Restricting a message only means something where someone else could read it.
 * A room with one reader gets no restriction: on Slack a DM is already private,
 * and marking it restricted there only costs durability, because an ephemeral
 * message does not survive a reload.
 *
 * Slack is the only channel that can show one reader a message in a room it
 * shares with others. Its room ids start with `C` for a channel and something
 * else for a DM, which is the distinction this reads.
 *
 * `sourceChannel` is a plain string because the only question asked of it is
 * whether it is Slack, and several callers hold one that was never narrowed.
 * They no longer have to coerce an absent channel to satisfy the signature.
 */
export function audienceForReader(
  sourceChannel: string | null | undefined,
  chatId: string | null | undefined,
  userId: string | null | undefined,
): MessageAudience | undefined {
  if (sourceChannel !== "slack" || !userId || !chatId?.startsWith("C")) {
    return undefined;
  }
  return { kind: "oneReader", userId };
}
