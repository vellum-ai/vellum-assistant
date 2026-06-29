import type { Conversation } from "./conversation.js";

/**
 * Whether the conversation's connected client can render dynamic UI surfaces
 * for the current turn — `true` unless the channel explicitly lacks the
 * capability. Prefers the per-turn capabilities, falling back to the
 * conversation's structural channel capabilities (set at creation, so this is
 * reliable on every run path, including queue-drained turns that carry no
 * per-call options).
 *
 * Pure projection of the conversation's public capability state — the
 * `Conversation` reference is type-only, so this stays a dependency-free leaf
 * and is safe to call with a partial test double.
 */
export function conversationSupportsDynamicUi(
  conversation: Pick<
    Conversation,
    "currentTurnChannelCapabilities" | "channelCapabilities"
  >,
): boolean {
  const caps =
    conversation.currentTurnChannelCapabilities ??
    conversation.channelCapabilities;
  return caps?.supportsDynamicUi !== false;
}
