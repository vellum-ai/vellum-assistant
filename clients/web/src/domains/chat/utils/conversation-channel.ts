import type { Conversation } from "@/types/conversation-types";

/**
 * Whether an origin string names an external channel, as opposed to a
 * conversation that lives natively in the app.
 *
 * Excluded origins (treated as native):
 *   - `vellum`         → native Vellum-channel conversation.
 *   - `notification:*` → outbound-only delivery (e.g. a Slack push for a
 *                       scheduled reminder); the conversation itself
 *                       still lives in the app.
 *
 * The one place this exclusion list lives: `isChannelConversation` applies it
 * to a conversation's `originChannel`, and the channel sidecar's
 * `getBoundChannelId` applies it to the binding-resolved origin.
 */
export function isExternalChannelOrigin(
  origin: string | null | undefined,
): boolean {
  if (!origin) {
    return false;
  }
  if (origin === "vellum") {
    return false;
  }
  if (origin.startsWith("notification:")) {
    return false;
  }
  return true;
}

/**
 * Predicate matching macOS `ConversationModel.isChannelConversation`.
 *
 * Returns true when a conversation originated from an external channel
 * (Slack, Telegram, voice/phone, etc.). On web this gates the
 * native-only edit/undo/recall path (the composer stays writable);
 * macOS/iOS keep these conversations read-only since the daemon does not
 * mirror outbound writes back to the source channel.
 *
 * Source of truth lives daemon-side as `channelBinding.sourceChannel`
 * with `conversationOriginChannel` as a fallback.
 */
export function isChannelConversation(
  conversation: Pick<Conversation, "originChannel"> | null | undefined,
): boolean {
  return isExternalChannelOrigin(conversation?.originChannel);
}
