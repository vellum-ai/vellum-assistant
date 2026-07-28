import type { Conversation } from "@/types/conversation-types";

/**
 * Predicate matching macOS `ConversationModel.isChannelConversation`.
 *
 * Returns true when a conversation originated from an external channel
 * (Slack, Telegram, voice/phone, etc.). On web this gates the
 * native-only edit/undo/recall path (the composer stays writable);
 * macOS/iOS keep these conversations read-only since the daemon does not
 * mirror outbound writes back to the source channel.
 *
 * Excluded prefixes (treated as native):
 *   - `vellum`         → native Vellum-channel conversation.
 *   - `notification:*` → outbound-only delivery (e.g. a Slack push for a
 *                       scheduled reminder); the conversation itself
 *                       still lives in the app.
 *
 * Source of truth lives daemon-side as `channelBinding.sourceChannel`
 * with `conversationOriginChannel` as a fallback.
 */
export function isChannelConversation(
  conversation: Pick<Conversation, "originChannel"> | null | undefined,
): boolean {
  const origin = conversation?.originChannel;
  if (!origin) return false;
  if (origin === "vellum") return false;
  if (origin.startsWith("notification:")) return false;
  return true;
}
