/**
 * Channel conversation reset handler.
 *
 * Channel-agnostic contract — two reset shapes, keyed on `sourceThreadId`:
 *
 * - **Thread-less reset** (no `sourceThreadId`): resets the chat's MAIN
 *   conversation only — deletes the base + legacy keys and the thread-less
 *   binding. Thread/topic conversations in the same chat (Slack threads,
 *   Telegram topics) are independent conversations and are never touched.
 * - **Threaded reset** (`sourceThreadId` set): resets exactly that
 *   thread/topic's conversation — deletes its scoped key and its binding.
 *
 * Adapter-specific behavior stays inside the explicitly channel-gated
 * branches below and must not leak into the shared contract.
 */
import {
  deleteConversationKey,
  getOrCreateConversation,
} from "../../persistence/conversation-key-store.js";
import {
  applyDeterministicTitleIfReplaceable,
  deriveChannelInboundMintTitle,
} from "../../persistence/conversation-title-service.js";
import { buildScopedConversationKey } from "../../persistence/delivery-crud.js";
import {
  deleteBindingByChannelChatNullThread,
  deleteBindingByChannelChatThread,
} from "../../persistence/external-conversation-store.js";
import { BadRequestError } from "./errors.js";
import type { RouteHandlerArgs } from "./types.js";

export function handleDeleteConversation({ body = {} }: RouteHandlerArgs) {
  const { sourceChannel, conversationExternalId, sourceThreadId } = body as {
    sourceChannel?: string;
    conversationExternalId?: string;
    sourceThreadId?: string;
  };

  if (!sourceChannel || typeof sourceChannel !== "string") {
    throw new BadRequestError("sourceChannel is required");
  }
  if (!conversationExternalId || typeof conversationExternalId !== "string") {
    throw new BadRequestError("conversationExternalId is required");
  }

  const normalizedThreadId = sourceThreadId?.trim() || undefined;

  const scopedKey = buildScopedConversationKey(
    sourceChannel,
    conversationExternalId,
    normalizedThreadId,
  );
  deleteConversationKey(scopedKey);
  const legacyKey = `${sourceChannel}:${conversationExternalId}`;
  if (!normalizedThreadId) {
    deleteConversationKey(legacyKey);
    deleteBindingByChannelChatNullThread(sourceChannel, conversationExternalId);
  } else {
    // Slack adapter: eagerly re-mint a fresh conversation for the threaded
    // key. The fresh key is what keeps the next inbound from re-aliasing the
    // thread onto the flat channel conversation it was reset away from, and
    // gives mid-thread turns racing the reset a home. Titled at the mint like
    // any channel conversation. Telegram deliberately skips this: a reset
    // topic simply creates its fresh conversation on the next inbound message.
    if (sourceChannel === "slack") {
      const { conversationId, created } = getOrCreateConversation(scopedKey);
      if (created) {
        applyDeterministicTitleIfReplaceable(
          conversationId,
          deriveChannelInboundMintTitle({ sourceChannel }),
        );
      }
    }
    deleteBindingByChannelChatThread(
      sourceChannel,
      conversationExternalId,
      normalizedThreadId,
    );
  }

  return { ok: true };
}
