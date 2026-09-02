/**
 * Durable records of the assistant's own delivered reactions.
 *
 * A reaction happens mid-turn (the react tool fans out to the channel while
 * the agent loop is still running), but its row must not be written then: an
 * assistant row inserted between a `tool_use` and its `tool_result` breaks
 * the pairing history repair enforces, and a reload would then teach the
 * model its own reaction failed. The tool queues the record on the live
 * conversation instead, and the agent loop drains the queue at the turn
 * boundary, after the turn's rows are settled.
 *
 * Slack rows write the `slackMeta` envelope (the Slack transcript context
 * builds provider history from rows and reads only that shape); every other
 * channel writes the neutral `providerMeta` that `readProviderMetadata`
 * serves to channel-agnostic readers, `Conversation.loadFromDb`'s renderer
 * included.
 */
import type { ChannelId } from "../channels/types.js";
import { buildNeutralReactionMeta } from "../messaging/reaction-envelopes.js";
import {
  addMessage,
  REACTION_MESSAGE_KIND,
} from "../persistence/conversation-crud.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("reaction-record");

export interface QueuedReactionRecord {
  channel: ChannelId;
  chatId: string;
  /** Target message id, in the channel's own id space. */
  messageId: string;
  emoji: string;
  op: "added" | "removed";
  /** The turn's provenance, so actor-scoped loads keep the row. */
  provenanceTrustClass?: string;
}

/**
 * Persist queued reaction records as standalone assistant rows. Non-throwing:
 * the reactions already happened on the channel, so a persistence failure
 * loses the record, never the act, and is logged rather than raised.
 */
export async function persistReactionRecords(
  conversationId: string,
  records: readonly QueuedReactionRecord[],
): Promise<void> {
  for (const record of records) {
    try {
      const facts = {
        channel: record.channel,
        chatId: record.chatId,
        targetMessageId: record.messageId,
        emoji: record.emoji,
        op: record.op,
      };
      // The assistant's own rows carry the neutral envelope on every channel;
      // the Slack renderers read it through the envelope's Slack view.
      const envelope = {
        providerMeta: JSON.stringify(buildNeutralReactionMeta(facts)),
      };
      await addMessage(conversationId, "assistant", "[reaction]", {
        metadata: {
          messageKind: REACTION_MESSAGE_KIND,
          ...(record.provenanceTrustClass
            ? { provenanceTrustClass: record.provenanceTrustClass }
            : {}),
          provenanceSourceChannel: record.channel,
          ...envelope,
        },
        skipIndexing: true,
      });
    } catch (err) {
      log.warn(
        { err, conversationId, channel: record.channel, op: record.op },
        "Failed to persist the assistant's reaction record",
      );
    }
  }
}
