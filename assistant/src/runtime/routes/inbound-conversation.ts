/**
 * Channel conversation reset handler.
 *
 * Channel-agnostic contract — two reset shapes, keyed on `sourceThreadId`:
 *
 * - **Thread-less reset** (no `sourceThreadId`): clears the chat's MAIN
 *   conversation key (base + legacy). Thread/topic keys in the same chat
 *   are untouched.
 * - **Threaded reset** (`sourceThreadId` set): clears exactly that
 *   thread/topic's conversation key.
 *
 * External bindings are intentionally left in place: they keep sidebar channel
 * grouping (Telegram/Slack sections) on the conversation that already ran there.
 * The next inbound message mints a fresh conversation for the cleared key and
 * {@link upsertBinding} moves the active binding forward.
 *
 * Adapter-specific behavior stays inside the explicitly channel-gated
 * branches below and must not leak into the shared contract.
 */
import {
  deleteConversationKey,
  getOrCreateConversation,
} from "../../persistence/conversation-key-store.js";
import { buildScopedConversationKey } from "../../persistence/delivery-crud.js";
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
  } else {
    // Slack adapter: eagerly re-mint a fresh conversation for the threaded
    // key so mid-thread turns racing the reset land in the new conversation.
    // Telegram deliberately skips this — a reset topic simply creates its
    // fresh conversation on the next inbound message.
    if (sourceChannel === "slack") {
      getOrCreateConversation(scopedKey);
    }
  }

  return { ok: true };
}
