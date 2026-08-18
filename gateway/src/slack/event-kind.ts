import type { SlackInboundEvent } from "../channels/inbound-event.js";

type SlackInboundMessage = SlackInboundEvent["message"];

/**
 * Whether the event acts on a message rather than being one: an edit, a
 * delete, a reaction, or a button press.
 *
 * Two things follow from it. Such an event carries no media of its own, and it
 * names no thread: it replies where the message it refers to lives, without
 * creating a thread there.
 */
export function slackEventRefersToAnotherMessage(
  message: SlackInboundMessage,
): boolean {
  return message.isEdit === true || typeof message.callbackData === "string";
}
