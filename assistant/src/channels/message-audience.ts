/**
 * Who a reply should be visible to, decided once for every producer.
 */

import type { MessageAudience } from "@vellumai/gateway-client";

import { isSlackDmConversation } from "../messaging/providers/slack/message-metadata.js";

/**
 * The audience a reply addressed at `userId` should carry, or `undefined` when
 * the whole room may see it.
 *
 * Restricting a message only means something where someone else could read it.
 * A room with one reader gets no restriction: a Slack DM is already private,
 * and marking it restricted there costs durability, because an ephemeral
 * message does not survive a reload.
 *
 * Slack is the only channel that can show one reader a message in a room it
 * shares with others. The test is for a DM rather than for a channel id, so
 * every other room shape counts as shared: a private group holds several
 * readers even though its id begins with `G` rather than `C`.
 *
 * `sourceChannel` and `chatId` are loosely typed because the only questions
 * asked of them are whether the channel is Slack and whether the room is a
 * DM, and several callers hold values that were never narrowed. An unknown
 * channel answers with no restriction rather than throwing.
 */
export function audienceForReader(
  sourceChannel: string | null | undefined,
  chatId: string | null | undefined,
  userId: string | null | undefined,
): MessageAudience | undefined {
  if (sourceChannel !== "slack" || !userId || !chatId) {
    return undefined;
  }
  if (isSlackDmConversation(chatId)) {
    return undefined;
  }
  return { kind: "oneReader", userId };
}
